import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/admin-auth'
import { allow, clientIp } from '@/lib/rate-limit'
import { toShowDTO } from '@/lib/broadcast'
import { listIngestSessions, mintIngestSession, type IngestSessionRole } from '@/lib/ingest'
import { fmtSlotLabel, nextSlotWindow } from '@/lib/slots'

export const dynamic = 'force-dynamic'

/**
 * GET  /api/ops/slots — the Shows & slots roster.
 * POST /api/ops/slots — mint a slot-bound host/guest credential for a show.
 *
 * C5 (docs/HOSTS-AND-GUEST-SLOTS-PLAN.md). The operator sees each show's next
 * window and mints a credential bound to it; the engine enforces the window
 * (`withinSlot`) and drops the holder at the slot's end. The token is returned
 * once, here, and never stored on this side.
 *
 * Admin-gated: minting is the owner's act, and the engine additionally requires
 * the master token (`INGEST_TOKEN`) for `/sessions`.
 */

const MINT_MAX_PER_WINDOW = 10
const WINDOW_MS = 60_000

export async function GET(request: Request) {
  const denied = await requireAdmin(request)
  if (denied) return denied

  const now = new Date()
  const shows = await db.show.findMany({ orderBy: [{ dayOfWeek: 'asc' }, { startHour: 'asc' }, { startMinute: 'asc' }] })

  const roster = shows.map((show) => {
    const window = nextSlotWindow(show, now)
    return {
      ...toShowDTO(show),
      slot: {
        notBefore: window.notBefore.toISOString(),
        notAfter: window.notAfter.toISOString(),
        label: fmtSlotLabel(window),
        open: now.getTime() >= window.notBefore.getTime() && now.getTime() <= window.notAfter.getTime(),
      },
    }
  })

  const sessions = await listIngestSessions()
  const engine = sessions.ok
    ? { reachable: true as const, error: null }
    : 'unreachable' in sessions
      ? { reachable: false as const, error: 'engine unreachable' }
      : { reachable: false as const, error: sessions.error }

  return NextResponse.json({
    now: now.toISOString(),
    shows: roster,
    sessions: sessions.ok ? sessions.data : [],
    engine,
  })
}

export async function POST(request: Request) {
  const denied = await requireAdmin(request)
  if (denied) return denied

  if (!allow(`ops-slots:${clientIp(request)}`, MINT_MAX_PER_WINDOW, WINDOW_MS)) {
    return NextResponse.json(
      { ok: false, error: `Too many session mints — max ${MINT_MAX_PER_WINDOW} per minute.` },
      { status: 429 },
    )
  }

  let body: { showId?: unknown; role?: unknown; canLive?: unknown; ttlMin?: unknown }
  try {
    body = (await request.json()) as typeof body
  } catch {
    return NextResponse.json({ error: 'Body must be JSON' }, { status: 400 })
  }

  const showId = typeof body.showId === 'string' ? body.showId : ''
  if (!showId) return NextResponse.json({ error: 'showId is required' }, { status: 400 })

  const role: IngestSessionRole = body.role === 'guest' ? 'guest' : 'host'
  const show = await db.show.findUnique({ where: { id: showId } })
  if (!show) return NextResponse.json({ error: 'Unknown show' }, { status: 404 })

  const window = nextSlotWindow(show, new Date())
  // Default the live capability from the show's own kind: a LIVE show is one
  // someone takes the mic for; a PLAYLIST show is a producer steering the
  // rotation, who has no business going live.
  const canLive = typeof body.canLive === 'boolean' ? body.canLive : show.kind === 'LIVE'
  // The slot's end already clamps `expiresAt` on the engine; this TTL only sets
  // the ceiling, so give it the window length plus an hour of slack.
  const ttlMin = typeof body.ttlMin === 'number' && Number.isFinite(body.ttlMin)
    ? Math.min(1440, Math.max(1, Math.round(body.ttlMin)))
    : Math.min(1440, Math.max(1, show.durationMin + 60))

  const minted = await mintIngestSession({
    role,
    label: `${show.name} · ${show.host}`.slice(0, 60),
    canLive,
    ttlMin,
    notBefore: window.notBefore.toISOString(),
    notAfter: window.notAfter.toISOString(),
  })

  if ('unreachable' in minted) {
    return NextResponse.json(
      { ok: false, unreachable: true, error: 'No answer from the engine — the credential may not have been minted. Check the engine before minting again.' },
      { status: 503 },
    )
  }
  if (!minted.ok) {
    return NextResponse.json({ ok: false, error: minted.error }, { status: minted.status || 502 })
  }

  return NextResponse.json(
    {
      ok: true,
      session: minted.data.session,
      // Shown once, here. The station does not persist it.
      token: minted.data.token,
      slot: {
        notBefore: window.notBefore.toISOString(),
        notAfter: window.notAfter.toISOString(),
        label: fmtSlotLabel(window),
      },
    },
    { status: 201 },
  )
}
