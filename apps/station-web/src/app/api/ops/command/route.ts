import { NextResponse } from 'next/server'
import { sendCommand } from '@/lib/ingest'
import { requireAdmin } from '@/lib/admin-auth'
import { allow, clientIp } from '@/lib/rate-limit'

export const dynamic = 'force-dynamic'

/**
 * Engine commands are not free: one can silence a live broadcast. An unlocked
 * session previously had no ceiling, so a stuck retry loop could stop the
 * station repeatedly. This is the same limiter the unlock route uses.
 */
const MAX_PER_WINDOW = 20
const WINDOW_MS = 60_000

/**
 * POST /api/ops/command
 *
 * The station site's one real control over the engine. Until this existed,
 * `sendCommand()` had zero call sites: ingest had a fully working command
 * plane — 42 commands, schema validation, replay protection — and the only
 * operator-facing tool for it was the DJ console, which meant nobody could
 * silence a stream from the station site at all.
 *
 * Allowlisted, not pass-through. Accepting an arbitrary command body would
 * make this a general remote control for anything the engine can do
 * (`library.load` with an arbitrary path, `autopilot.setVibe`, …) behind a
 * single PIN. The set below is the set an operator should be able to reach in
 * an emergency, and nothing else.
 *
 * `mix.panic` is deliberately absent. It is a DJ panic MIX — it stops the
 * autopilot and slams the crossfader to one side, leaving one deck audibly
 * playing. An operator who hit a red "TAKE OFF AIR" button wired to it would
 * watch the stream carry on.
 *
 * `transport.stop` is the verb that silences the station: it stops the engine
 * *and* flips Liquidsoap's on-air switch to `blank()`. Before that switch
 * existed, stopping the engine promoted the library fallback playlist and the
 * station carried on playing filler.
 */
const ALLOWED = {
  'transport.stop': {},
  'transport.play': {},
  'transport.pause': {},
  'transport.offAir': {},
  'transport.onAir': { enabled: true },
  'mix.skip': {},
  'mix.mixNext': {},
} as const satisfies Record<string, object>

type AllowedType = keyof typeof ALLOWED

function isAllowedType(value: unknown): value is AllowedType {
  return typeof value === 'string' && Object.hasOwn(ALLOWED, value)
}

export async function POST(request: Request) {
  const denied = await requireAdmin(request)
  if (denied) return denied

  if (!allow(`ops-command:${clientIp(request)}`, MAX_PER_WINDOW, WINDOW_MS)) {
    return NextResponse.json(
      { ok: false, error: `Too many engine commands — max ${MAX_PER_WINDOW} per minute.` },
      { status: 429 },
    )
  }

  let body: { type?: unknown; command?: unknown }
  try {
    body = (await request.json()) as { type?: unknown; command?: unknown }
  } catch {
    return NextResponse.json({ error: 'Body must be JSON' }, { status: 400 })
  }

  const type = body.type ?? (body.command as { type?: unknown } | undefined)?.type
  if (!isAllowedType(type)) {
    return NextResponse.json(
      {
        error: 'Unsupported command',
        allowed: Object.keys(ALLOWED),
      },
      { status: 400 },
    )
  }

  // mix.mixNext accepts an optional presetId. Anything else in the envelope is
  // dropped rather than forwarded, so a future caller cannot smuggle a path.
  const presetId =
    type === 'mix.mixNext'
      ? (body.command as { presetId?: unknown } | undefined)?.presetId
      : undefined
  const command: Record<string, unknown> = { type }
  if (type === 'mix.mixNext' && typeof presetId === 'string' && presetId.length > 0) {
    command.presetId = presetId.slice(0, 64)
  }

  const result = await sendCommand(command, {
    id: 'ops',
    role: 'ops' as const,
    label: 'station ops',
  })

  if (result.unreachable) {
    // Deliberately NOT "nothing was sent". `sendCommand` throws on a timeout
    // too, and a 4s timeout can fire after ingest received and applied the
    // command. Claiming nothing happened would push the operator into pressing
    // the button again. Each attempt carries its own envelope id, so a retry
    // is deduplicated by the ingest replay cache rather than double-executed.
    return NextResponse.json(
      {
        ok: false,
        unreachable: true,
        error: 'No answer from the engine within 4s — it may or may not have acted. Check the Ops status before acting again.',
      },
      { status: 503 },
    )
  }

  const body2 = result.body as
    | { ok?: boolean; code?: string; error?: string; result?: unknown }
    | null

  if (!body2?.ok && body2?.code === 'UNAUTHORIZED') {
    // Almost always a missing INGEST_TOKEN on this process, not a refused
    // operator. Saying so saves an hour of hunting a policy that is fine.
    return NextResponse.json(
      {
        ok: false,
        error:
          'This app cannot authenticate to the engine. Set INGEST_TOKEN on the station app to match the engine.',
      },
      { status: 502 },
    )
  }

  return NextResponse.json(
    {
      ok: body2?.ok === true,
      code: body2?.code ?? null,
      error: body2?.error ?? null,
      result: body2?.result ?? null,
    },
    { status: body2?.ok === true ? 200 : 502 },
  )
}
