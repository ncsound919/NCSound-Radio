import { NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/admin-auth'
import { revokeIngestSession } from '@/lib/ingest'

export const dynamic = 'force-dynamic'

/**
 * POST /api/ops/slots/revoke
 *
 * Revoke a host/guest credential by id. The engine closes the holder's control
 * socket and, if they were live, drops them off the air so autopilot resumes —
 * so this is the mid-show kill switch, admin-gated like the rest of the ops
 * plane.
 */
export async function POST(request: Request) {
  const denied = await requireAdmin(request)
  if (denied) return denied

  let body: { id?: unknown }
  try {
    body = (await request.json()) as typeof body
  } catch {
    return NextResponse.json({ error: 'Body must be JSON' }, { status: 400 })
  }

  const id = typeof body.id === 'string' ? body.id : ''
  if (!id) return NextResponse.json({ error: 'id is required' }, { status: 400 })

  const result = await revokeIngestSession(id)
  if ('unreachable' in result) {
    return NextResponse.json(
      { ok: false, unreachable: true, error: 'No answer from the engine — the credential may still be live.' },
      { status: 503 },
    )
  }
  if (!result.ok) {
    return NextResponse.json({ ok: false, error: result.error }, { status: result.status || 502 })
  }

  return NextResponse.json({ ok: result.data.ok, killedLive: result.data.killedLive })
}
