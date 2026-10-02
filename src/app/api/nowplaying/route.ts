import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import {
  computeListeners,
  computeOnAir,
  getRotationTracks,
  getUpNext,
  maybeLogPlays,
  toTrackDTO,
} from '@/lib/broadcast'

export const dynamic = 'force-dynamic'

/**
 * GET /api/nowplaying
 * Deterministic AutoDJ "what's on air" computed from the wall clock,
 * station metadata from StationSetting, simulated listeners, and lazy
 * PlayLog accumulation (song history fills as this endpoint is polled).
 */
export async function GET() {
  try {
    const nowMs = Date.now()
    const [settings, tracks] = await Promise.all([
      db.stationSetting.findMany(),
      getRotationTracks(),
    ])
    const settingsMap = new Map(settings.map((s) => [s.key, s.value]))

    if (tracks.length === 0) {
      return NextResponse.json(
        { error: 'Rotation library is empty' },
        { status: 503 },
      )
    }

    const onAir = computeOnAir(tracks, nowMs)
    const next = getUpNext(tracks, onAir.index, 3).map(toTrackDTO)
    const listeners = computeListeners(nowMs)
    await maybeLogPlays(onAir.track.id, onAir.startedAt)

    const streamUrl = process.env.AZURACAST_STREAM_URL || null

    return NextResponse.json({
      station: {
        name: settingsMap.get('station_name') ?? 'WAVC 91.3 FM',
        tagline:
          settingsMap.get('tagline') ??
          'The Carolinas\u2019 independent hip-hop signal',
        bitrateKbps:
          Number.parseInt(settingsMap.get('bitrate_kbps') ?? '128', 10) || 128,
        timezone: settingsMap.get('timezone') ?? 'America/New_York',
        rightsGate: settingsMap.get('rights_gate') ?? 'ENFORCED',
      },
      current: {
        track: toTrackDTO(onAir.track),
        startedAt: onAir.startedAt.toISOString(),
        elapsed: onAir.elapsed,
        duration: onAir.duration,
        remaining: onAir.remaining,
        progress: onAir.progress,
      },
      next,
      listeners,
      mode: streamUrl ? ('live' as const) : ('simulated' as const),
      streamUrl,
      serverTime: new Date(nowMs).toISOString(),
    })
  } catch (error) {
    console.error('[api/nowplaying]', error)
    return NextResponse.json(
      { error: 'Failed to load now-playing data' },
      { status: 500 },
    )
  }
}
