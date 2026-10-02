import { NextResponse } from 'next/server'
import { computeListeners, STATION_TIMEZONE } from '@/lib/broadcast'

export const dynamic = 'force-dynamic'

/**
 * GET /api/listeners/history
 * Listener-count trend for the past 24 hours, sampled every 15 minutes from
 * the same deterministic circadian simulation that drives /api/nowplaying
 * (no DB writes needed — the simulation is a pure function of the clock).
 * 97 points including "now". Cheap to poll.
 */
export async function GET() {
  try {
    const nowMs = Date.now()
    const STEP_MS = 15 * 60 * 1000
    const WINDOW_MS = 24 * 60 * 60 * 1000

    const points: Array<{ t: string; v: number }> = []
    for (let t = nowMs - WINDOW_MS; t <= nowMs; t += STEP_MS) {
      points.push({
        t: new Date(t).toISOString(),
        v: computeListeners(t).current,
      })
    }

    const listeners = computeListeners(nowMs)

    return NextResponse.json({
      points,
      current: listeners.current,
      peak24h: listeners.peak24h,
      timezone: STATION_TIMEZONE,
      serverTime: new Date(nowMs).toISOString(),
    })
  } catch (error) {
    console.error('[api/listeners/history]', error)
    return NextResponse.json(
      { error: 'Failed to load listener history' },
      { status: 500 },
    )
  }
}
