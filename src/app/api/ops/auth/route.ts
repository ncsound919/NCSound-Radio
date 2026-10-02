import { NextResponse } from 'next/server'
import { z } from 'zod'
import { allow, clientIp, sweepRateLimits } from '@/lib/rate-limit'
import { getOpsPin } from '@/lib/ops-auth'

export const dynamic = 'force-dynamic'

const bodySchema = z.object({ pin: z.string().min(1).max(16) })

/**
 * POST /api/ops/auth — validate the control-room PIN for the Ops UI.
 * Rate-limited (10 attempts / 5 min / IP). On success the client keeps the
 * PIN in sessionStorage and presents it as `x-ops-pin` on mutating calls.
 */
export async function POST(request: Request) {
  try {
    sweepRateLimits()
    if (!allow(`opsauth:${clientIp(request)}`, 10, 5 * 60_000)) {
      return NextResponse.json(
        { error: 'Too many unlock attempts — try again in a few minutes.' },
        { status: 429 },
      )
    }

    const body: unknown = await request.json().catch(() => null)
    const parsed = bodySchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json({ error: 'Enter the station PIN.' }, { status: 400 })
    }

    const expected = await getOpsPin()
    if (parsed.data.pin !== expected) {
      return NextResponse.json(
        { error: 'Wrong PIN — that key does not open this door.' },
        { status: 401 },
      )
    }

    return NextResponse.json({ ok: true })
  } catch (error) {
    console.error('[api/ops/auth]', error)
    return NextResponse.json({ error: 'Unlock check failed' }, { status: 500 })
  }
}
