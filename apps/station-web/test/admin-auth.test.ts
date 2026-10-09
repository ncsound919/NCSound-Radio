import './setup'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import {
  ADMIN_COOKIE,
  adminConfigured,
  currentAdmin,
  hashPassword,
  login,
  logout,
  requireAdmin,
  setAdminCredential,
  verifyPassword,
} from '../src/lib/admin-auth'
import { db } from '../src/lib/db'

const ADMIN_KEYS = ['admin_user', 'admin_pw_hash', 'admin_session_secret', 'admin_session_epoch']

// Reachability is resolved before the test table is built, so the DB-backed
// tests can be *skipped* (visible) rather than silently passing when no
// Postgres is configured. CI without a database still runs the crypto tests.
let dbUp = false
try {
  await db.stationSetting.count()
  dbUp = true
} catch {
  dbUp = false
}

// ---------------------------------------------------------------------------
// Password hashing — pure, no database.
// ---------------------------------------------------------------------------

describe('password hashing (scrypt)', () => {
  test('a hash verifies its own password and nothing else', () => {
    const stored = hashPassword('correct horse battery staple')
    expect(stored.startsWith('scrypt$')).toBe(true)
    expect(verifyPassword('correct horse battery staple', stored)).toBe(true)
    expect(verifyPassword('wrong password entirely', stored)).toBe(false)
  })

  test('the same password hashes differently each time (random salt)', () => {
    const a = hashPassword('same-password-here')
    const b = hashPassword('same-password-here')
    expect(a).not.toBe(b)
    expect(verifyPassword('same-password-here', a)).toBe(true)
    expect(verifyPassword('same-password-here', b)).toBe(true)
  })

  test('malformed stored values are rejected, not thrown on', () => {
    for (const bad of ['', 'not-a-hash', 'scrypt$1$2$3', 'bcrypt$16384$8$1$aaaa$bbbb']) {
      expect(verifyPassword('anything', bad)).toBe(false)
    }
  })

  test('unicode is normalised so composed and decomposed forms match', () => {
    const composed = 'caf\u00e9-secret-123' // é as one code point
    const decomposed = 'cafe\u0301-secret-123' // e + combining acute
    expect(verifyPassword(decomposed, hashPassword(composed))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Session flow — requires Postgres.
// ---------------------------------------------------------------------------

type Stored = { key: string; value: string }
let snapshot: Stored[] = []

function tokenFrom(res: Response): string | null {
  const setCookie = res.headers.get('set-cookie')
  if (!setCookie) return null
  const m = new RegExp(`${ADMIN_COOKIE}=([^;]+)`).exec(setCookie)
  return m ? decodeURIComponent(m[1]!) : null
}

function withCookie(token: string): Request {
  return new Request('http://station.local/api/ops/command', {
    headers: { cookie: `${ADMIN_COOKIE}=${encodeURIComponent(token)}` },
  })
}

describe('admin session flow (Postgres)', () => {
  const USER = 'ops-admin'
  const PASSWORD = 'a-long-enough-passphrase'

  beforeAll(async () => {
    if (!dbUp) return
    snapshot = (await db.stationSetting.findMany({ where: { key: { in: ADMIN_KEYS } } })) as Stored[]
    await db.stationSetting.deleteMany({ where: { key: { in: ADMIN_KEYS } } })
  })

  afterAll(async () => {
    if (!dbUp) return
    await db.stationSetting.deleteMany({ where: { key: { in: ADMIN_KEYS } } })
    for (const row of snapshot) await db.stationSetting.create({ data: row })
  })

  test.skipIf(!dbUp)('no credential means not configured', async () => {
    expect(await adminConfigured()).toBe(false)
  })

  test.skipIf(!dbUp)('setting a credential configures the account', async () => {
    await setAdminCredential(USER, PASSWORD)
    expect(await adminConfigured()).toBe(true)
  })

  test.skipIf(!dbUp)('login refuses a wrong password with no cookie', async () => {
    const out = await login(new Request('http://x'), USER, 'not-the-password')
    expect(out.ok).toBe(false)
    expect(out.response.status).toBe(401)
    expect(tokenFrom(out.response)).toBeNull()
  })

  test.skipIf(!dbUp)('login refuses an unknown username', async () => {
    const out = await login(new Request('http://x'), 'someone-else', PASSWORD)
    expect(out.ok).toBe(false)
    expect(out.response.status).toBe(401)
  })

  test.skipIf(!dbUp)('a correct login mints a cookie that currentAdmin accepts', async () => {
    const out = await login(new Request('http://x'), USER, PASSWORD)
    expect(out.ok).toBe(true)
    const token = tokenFrom(out.response)
    expect(token).toBeTruthy()
    expect(await currentAdmin(withCookie(token!))).toEqual({ user: USER })
    expect(await requireAdmin(withCookie(token!))).toBeNull()
  })

  test.skipIf(!dbUp)('a tampered token is rejected', async () => {
    const out = await login(new Request('http://x'), USER, PASSWORD)
    const token = tokenFrom(out.response)!
    const tampered = token.slice(0, -2) + (token.endsWith('aa') ? 'bb' : 'aa')
    expect(await currentAdmin(withCookie(tampered))).toBeNull()
  })

  test.skipIf(!dbUp)('no cookie is unauthenticated and requireAdmin returns a 401', async () => {
    expect(await currentAdmin(new Request('http://x'))).toBeNull()
    const res = await requireAdmin(new Request('http://x'))
    expect(res?.status).toBe(401)
  })

  test.skipIf(!dbUp)('logout bumps the epoch and invalidates the old cookie', async () => {
    const out = await login(new Request('http://x'), USER, PASSWORD)
    const token = tokenFrom(out.response)!
    expect(await currentAdmin(withCookie(token))).not.toBeNull()
    await logout()
    expect(await currentAdmin(withCookie(token))).toBeNull()
  })
})
