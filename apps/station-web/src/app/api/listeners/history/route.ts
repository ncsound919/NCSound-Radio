import { NextResponse } from 'next/server'
import { ingestListenerHistory, ingestStatus } from '@/lib/ingest'
import { STATION_TIMEZONE } from '@/lib/broadcast'

export const dynamic = 'force-dynamic'

/**
 * GET /api/listeners/history
 *
 * Real Icecast samples, buffered by the ingest service as it polls.
 *
 * The buffer lives in the service process, so it only covers the current run.
 * `startedAt` is reported honestly and `partial` is true whenever the series is
 * shorter than the 24 hours the UI would like. A chart drawn from the old
 * circadian simulation looked complete and was entirely invented; a short real
 * series that says it is short is more useful than a long fake one.
 */
export async function GET() {
  try {
    const nowMs = Date.now()
    const WINDOW_MS = 24 * 60 * 60 * 1000

    const [history, status] = await Promise.all([ingestListenerHistory(), ingestStatus()])

    if (!history) {
      return NextResponse.json(
        {
          points: [],
          current: null,
          peak24h: null,
          partial: true,
          reason: 'DJ engine is not reachable',
          timezone: STATION_TIMEZONE,
          serverTime: new Date(nowMs).toISOString(),
        },
        { status: 503 },
      )
    }

    const cutoff = nowMs - WINDOW_MS
    const points = history.samples
      .filter((s) => Date.parse(s.at) >= cutoff)
      .map((s) => ({ t: s.at, v: s.current }))

    const listeners = status?.engine.listeners ?? null
    const spanMs =
      points.length > 1 ? Date.parse(points[points.length - 1].t) - Date.parse(points[0].t) : 0

    return NextResponse.json({
      points,
      current: listeners?.current ?? null,
      peak24h: listeners?.peak24h ?? null,
      // The service has been up for less than a day, or restarted.
      partial: spanMs < WINDOW_MS,
      recordedSince: history.startedAt,
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