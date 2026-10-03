import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { ingestStatus, streamUrl } from '@/lib/ingest'
import { maybeLogPlays, DAY_MS } from '@/lib/broadcast'
import type { ElementKind, NowPlayingElement, QueueEntry } from '@/lib/station-types'

export const dynamic = 'force-dynamic'

/**
 * GET /api/nowplaying
 *
 * The current track, queue and listener count come from the DJ engine, which
 * is the thing actually broadcasting. This endpoint adds what the engine
 * cannot know: station settings, request heat, campaign allocation for any ad
 * slots, and the scheduled show currently running.
 *
 * When ingest is unreachable the route says `mode: "offline"` and reports no
 * track. It does not fall back to the old program-clock wheel, because a
 * computed schedule presented as "now playing" is a lie about what is on air.
 */
export async function GET() {
  try {
    const nowMs = Date.now()

    const [live, settings] = await Promise.all([ingestStatus(), db.stationSetting.findMany()])
    const settingsMap = new Map(settings.map((s) => [s.key, s.value]))

    if (!live) {
      return NextResponse.json(
        {
          station: stationIdentity(settingsMap),
          current: null,
          next: [],
          heat: {},
          requestedBy: {},
          wheel: [],
          cycleIndex: 0,
          cycleSec: 0,
          listeners: { current: 0, peak24h: 0 },
          mode: 'offline' as const,
          offlineReason: 'DJ engine is not reachable',
          streamUrl: null,
          serverTime: new Date(nowMs).toISOString(),
        },
        { status: 503 },
      )
    }

    const engine = live.engine
    const onAir = engine.onAir
    const stream = live.stream

    // Queue entries straight from the engine's autopilot.
    const next: QueueEntry[] = (onAir?.next ?? []).map((t) => ({
      id: t.id,
      title: t.title,
      artist: t.artist,
      album: null,
      durationSec: t.durationSec,
      rightsId: t.id.toUpperCase(),
      explicit: false,
      playlist: engine.autopilot.vibeTemplateId ?? 'Core Rotation',
      bpm: t.bpm,
      elementKind: (t.elementKind ?? 'MUSIC') as ElementKind,
      sponsorName: null,
    }))

    const currentEntry: QueueEntry | null = onAir
      ? {
          id: onAir.current.track.id,
          title: onAir.current.track.title,
          artist: onAir.current.track.artist,
          album: null,
          durationSec: onAir.current.track.durationSec,
          rightsId: onAir.current.track.id.toUpperCase(),
          explicit: false,
          playlist: engine.autopilot.vibeTemplateId ?? 'Core Rotation',
          bpm: onAir.current.track.bpm,
          elementKind: (onAir.element.kind ?? 'MUSIC') as ElementKind,
          sponsorName: null,
        }
      : null

    // Request heat + who shouted, from the app's own database.
    const musicIds = [currentEntry, ...next].filter((e) => e?.elementKind === 'MUSIC').map((e) => e!.id)
    const heat: Record<string, number> = {}
    const requestedBy: Record<string, string[]> = {}
    if (musicIds.length > 0) {
      const since7d = new Date(nowMs - 7 * DAY_MS)
      const [counts, shouts] = await Promise.all([
        db.trackRequest.groupBy({
          by: ['trackId'],
          where: { trackId: { in: musicIds }, createdAt: { gte: since7d } },
          _count: { trackId: true },
        }),
        db.trackRequest.findMany({
          where: { trackId: { in: musicIds }, createdAt: { gte: since7d } },
          orderBy: { createdAt: 'desc' },
          select: { trackId: true, listenerName: true },
          take: 60,
        }),
      ])
      for (const g of counts) heat[g.trackId] = g._count.trackId
      for (const s of shouts) {
        const list = requestedBy[s.trackId] ?? (requestedBy[s.trackId] = [])
        if (list.length < 3 && !list.includes(s.listenerName)) list.push(s.listenerName)
      }
    }

    // Log the live play so song history fills from what actually aired.
    if (currentEntry) {
      await maybeLogPlays(currentEntry.id, new Date(onAir!.current.startedAt), 'AUTODJ')
    }

    const onAirNow = stream?.onAir === true && onAir !== null

    return NextResponse.json({
      station: stationIdentity(settingsMap),
      current: onAir
        ? {
            track: currentEntry,
            startedAt: onAir.current.startedAt,
            elapsed: onAir.current.elapsed,
            duration: onAir.current.duration,
            remaining: onAir.current.remaining,
            progress: onAir.current.progress,
          }
        : null,
      element: (onAir?.element ?? { kind: 'MUSIC' }) as NowPlayingElement,
      daypart: onAir?.daypart ?? { clean: true, label: 'Music only' },
      liveShow: null,
      next,
      heat,
      requestedBy,
      wheel: onAir ? [{ kind: 'MUSIC' as ElementKind, durSec: onAir.current.duration }] : [],
      cycleIndex: 0,
      cycleSec: onAir?.cycleSec ?? 0,
      // Real, from Icecast. Never derived from a curve.
      listeners: engine.listeners,
      engine: {
        state: engine.state,
        crateSize: engine.autopilot.crateSize,
        autopilot: engine.autopilot.enabled,
        uptimeSec: engine.uptimeSec,
        lastError: engine.lastError,
      },
      stream: stream
        ? {
            onAir: stream.onAir,
            encoder: stream.encoder,
            icecast: stream.icecast.version,
            mounts: stream.mounts,
          }
        : null,
      mode: onAirNow ? ('live' as const) : ('standby' as const),
      streamUrl: onAirNow ? streamUrl() : null,
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

function stationIdentity(settingsMap: Map<string, string>) {
  return {
    name: settingsMap.get('station_name') ?? 'NCSound Radio',
    tagline: settingsMap.get('tagline') ?? 'The Carolinas\u2019 independent hip-hop signal',
    bitrateKbps: Number.parseInt(settingsMap.get('bitrate_kbps') ?? '128', 10) || 128,
    timezone: settingsMap.get('timezone') ?? 'America/New_York',
    rightsGate: settingsMap.get('rights_gate') ?? 'ENFORCED',
  }
}
