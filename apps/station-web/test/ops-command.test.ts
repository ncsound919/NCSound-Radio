import './setup'
import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { ADMIN_COOKIE, login, setAdminCredential } from '../src/lib/admin-auth'
import { db } from '../src/lib/db'

/**
 * The station site's one control over the engine. It can silence a live
 * broadcast, so what matters is the allowlist: only the operator's emergency
 * verbs reach ingest, and each is forwarded with the fields the engine schema
 * requires (`transport.onAir` needs `enabled`, which was missing and made the
 * "take on air" button a no-op).
 *
 * `sendCommand` is mocked so the test asserts the forwarded payload without a
 * running ingest. The real rate limiter is left in place: this file makes only
 * a handful of calls, well under the 20/minute cap, and `mock.module` is
 * process-global — replacing the limiter here would strip exports that
 * `rate-limit.test.ts` imports.
 */
type Sent = { command: Record<string, unknown>; actor: unknown }
const sent: Sent[] = []

const realIngest = await import('../src/lib/ingest')
mock.module('../src/lib/ingest', () => ({
  ...realIngest,
  sendCommand: async (command: Record<string, unknown>, actor: unknown) => {
    sent.push({ command, actor })
    return { body: { ok: true, result: { applied: true } } }
  },
}))

const route = await import('../src/app/api/ops/command/route')

const ADMIN_KEYS = ['admin_user', 'admin_pw_hash', 'admin_session_secret', 'admin_session_epoch']
let dbUp = false
try {
  await db.stationSetting.count()
  dbUp = true
} catch {
  dbUp = false
}

type Stored = { key: string; value: string }
let snapshot: Stored[] = []
let cookie = ''

function post(body: unknown, withAuth = true): Promise<Response> {
  return route.POST(
    new Request('http://station.local/api/ops/command', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(withAuth ? { cookie } : {}) },
      body: JSON.stringify(body),
    }),
  )
}

describe('ops command route (Postgres)', () => {
  beforeAll(async () => {
    if (!dbUp) return
    snapshot = (await db.stationSetting.findMany({ where: { key: { in: ADMIN_KEYS } } })) as Stored[]
    await db.stationSetting.deleteMany({ where: { key: { in: ADMIN_KEYS } } })
    await setAdminCredential('ops-admin', 'a-long-enough-passphrase')
    const out = await login(new Request('http://x'), 'ops-admin', 'a-long-enough-passphrase')
    const sc = out.response.headers.get('set-cookie') ?? ''
    const m = new RegExp(`${ADMIN_COOKIE}=([^;]+)`).exec(sc)
    cookie = `${ADMIN_COOKIE}=${m ? m[1] : ''}`
  })

  afterAll(async () => {
    if (!dbUp) return
    await db.stationSetting.deleteMany({ where: { key: { in: ADMIN_KEYS } } })
    for (const row of snapshot) await db.stationSetting.create({ data: row })
  })

  test.skipIf(!dbUp)('an unauthenticated request is refused before anything else', async () => {
    const res = await post({ type: 'transport.stop' }, false)
    expect(res.status).toBe(401)
    expect(sent.length).toBe(0)
  })

  test.skipIf(!dbUp)('a command outside the allowlist is refused and lists what is allowed', async () => {
    const res = await post({ type: 'library.load' })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string; allowed: string[] }
    expect(body.allowed).toContain('transport.stop')
    expect(body.allowed).not.toContain('library.load')
    expect(sent.length).toBe(0)
  })

  test.skipIf(!dbUp)('transport.onAir is forwarded with the required enabled flag', async () => {
    sent.length = 0
    const res = await post({ type: 'transport.onAir' })
    expect(res.status).toBe(200)
    expect(sent.length).toBe(1)
    expect(sent[0]!.command).toEqual({ type: 'transport.onAir', enabled: true })
  })

  test.skipIf(!dbUp)('mix.mixNext carries a presetId but drops anything else', async () => {
    sent.length = 0
    await post({ type: 'mix.mixNext', command: { type: 'mix.mixNext', presetId: 'slam', path: '/etc/passwd' } })
    expect(sent.length).toBe(1)
    expect(sent[0]!.command).toEqual({ type: 'mix.mixNext', presetId: 'slam' })
  })

  test.skipIf(!dbUp)('the forwarded actor is the ops identity, not the request body', async () => {
    sent.length = 0
    await post({ type: 'transport.stop', actor: { id: 'attacker', role: 'ops', label: 'x' } })
    expect(sent.length).toBe(1)
    expect(sent[0]!.actor).toEqual({ id: 'ops', role: 'ops', label: 'station ops' })
  })
})
