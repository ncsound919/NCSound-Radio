import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { ingestStatus, streamUrl } from '@/lib/ingest'
import { maybeLogPlays, getActiveShow, etWallClock, DAY_MS } from '@/lib/broadcast'
import type {
  ElementKind,
  LiveShowInfo,
  NowPlayingElement,
  QueueEntry,
  WheelSlice,
} from '@/lib/station-types'
import type { Show } from '@prisma/client'

export const dynamic = 'force-dynamic'

/** Label for a track the station library has no row for yet. */
const UNFILED_PLAYLIST = 'Unfiled'

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
          // null, not 0: with the engine unreachable the count is unknown, and
          // a confident 0 is a lie about a measurement we never took.
          listeners: { current: null, peak24h: null },
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

    // Queue entries straight from the engine's autopilot. Album, rights id,
    // explicit flag and playlist label are station data the engine cannot
    // know, so they start unknown and are filled in from the library below.
    const next: QueueEntry[] = (onAir?.next ?? []).map((t) => ({
      id: t.id,
      title: t.title,
      artist: t.artist,
      album: null,
      durationSec: t.durationSec,
      rightsId: null,
      explicit: false,
      playlist: UNFILED_PLAYLIST,
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
          rightsId: null,
          explicit: false,
          playlist: UNFILED_PLAYLIST,
          bpm: onAir.current.track.bpm,
          elementKind: (onAir.element.kind ?? 'MUSIC') as ElementKind,
          sponsorName: null,
        }
      : null

    // Enrich from the station library. These fields used to be synthesised —
    // `rightsId: track.id.toUpperCase()` invented a clearance reference for a
    // rights record that was never created.
    const entryIds = [currentEntry?.id, ...next.map((e) => e.id)].filter(
      (id): id is string => Boolean(id),
    )
    const stationRows =
      entryIds.length > 0
        ? await db.track.findMany({
            where: { id: { in: entryIds } },
            select: { id: true, album: true, rightsId: true, explicit: true, playlist: true },
          })
        : []
    const stationById = new Map(stationRows.map((r) => [r.id, r]))
    const enrich = (entry: QueueEntry | null) => {
      const row = entry ? stationById.get(entry.id) : undefined
      if (!entry || !row) return
      entry.album = row.album
      entry.rightsId = row.rightsId
      entry.explicit = row.explicit
      entry.playlist = row.playlist
    }
    enrich(currentEntry)
    next.forEach(enrich)

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

    /**
     * The engine's single on-air answer.
     *
     * This line used to be `stream?.onAir === true && onAir !== null`, which
     * stayed true after the station was taken off air: the Icecast mount keeps
     * its source connected while Liquidsoap outputs `blank()`, and
     * `transport.stop` does not change the engine's state string. Listeners were
     * told "live" while the station was transmitting silence. The DJ console
     * read a different subset of the same three inputs and reached the opposite
     * conclusion, which is how two halves of one station came to disagree about
     * whether it was on.
     */
    const broadcast = live.broadcast
    const onAirNow = broadcast?.onAir === true

    // The scheduled show actually running. This was hardcoded to null while
    // getActiveShow() sat unused, so the player bar's LIVE badge could never
    // render.
    const activeShow = await getActiveShow(nowMs)
    const liveShow = activeShow ? liveShowInfo(activeShow, nowMs) : null

    // Program-clock slices built from the engine's real timeline: what is
    // spinning now plus what it has queued. This replaced a synthetic
    // one-element wheel that always drew a single full circle.
    const wheel: WheelSlice[] = onAir
      ? [
          {
            kind: (onAir.element.kind ?? 'MUSIC') as ElementKind,
            durSec: onAir.current.duration,
          },
          ...next.map((e) => ({ kind: e.elementKind, durSec: e.durationSec })),
        ]
      : []

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
      liveShow,
      next,
      heat,
      requestedBy,
      wheel,
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
        // Real master-bus spectrum off the engine's analyser. This is the
        // broadcast signal, so the UI can visualise it instead of animating a
        // Web Audio stand-in that was never on the air.
        spectrum: engine.telemetry?.spectrum ?? [],
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
      /**
       * Why it is not live, when it is not.
       *
       * "standby" on its own is ambiguous between an idle station, an operator
       * who took it off air, and a mount with no source. The engine says which.
       */
      standbyReason: onAirNow ? null : broadcast?.reason ?? 'status unknown',
      /** The three components, so the UI can show which one is failing. */
      broadcastComponents: broadcast?.components ?? null,
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

/**
 * Project a scheduled Show onto the LiveShowInfo the player bar renders.
 *
 * Times are derived from `nowMs` rather than re-parsed so the countdown
 * always agrees with the timestamp the caller polled at.
 */
function liveShowInfo(show: Show, nowMs: number): LiveShowInfo {
  const wc = etWallClock(new Date(nowMs))
  const startMin = show.startHour * 60 + show.startMinute
  const elapsedMin = Math.max(0, wc.minuteOfDay - startMin)
  const minutesLeft = Math.max(0, startMin + show.durationMin - wc.minuteOfDay)
  return {
    id: show.id,
    name: show.name,
    host: show.host,
    description: show.description,
    kind: show.kind === 'LIVE' ? 'LIVE' : 'PLAYLIST',
    accent: show.accent,
    startedAtIso: new Date(nowMs - elapsedMin * 60_000).toISOString(),
    endsAtIso: new Date(nowMs + minutesLeft * 60_000).toISOString(),
    minutesLeft,
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
