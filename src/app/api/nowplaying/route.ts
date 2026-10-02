import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import {
  adSpotScheduleForDay,
  campaignForAdSlot,
  computeListeners,
  computeOnAir,
  etDayStartUTC,
  getRotationWheel,
  getUpNextElements,
  isCleanDaypart,
  maybeLogAdPlay,
  maybeLogPlays,
  toTrackDTO,
  DAY_MS,
} from '@/lib/broadcast'
import type {
  ElementKind,
  NowPlayingElement,
  QueueEntry,
} from '@/lib/station-types'

export const dynamic = 'force-dynamic'

const TRACK_GAP_SEC = 12

/** Pseudo TrackDTO for an ad-break spot (sold sponsor creative or house promo). */
function adSpotTrack(
  campaign: { name: string; sponsorName: string; creativeName: string } | null,
  slotId: string,
): QueueEntry {
  return {
    id: `adspot-${slotId}`,
    title: campaign ? campaign.creativeName : 'House promo — support WAVC 91.3',
    artist: campaign ? campaign.sponsorName : 'WAVC 91.3 FM',
    album: campaign ? `Campaign: ${campaign.name}` : 'Unsold inventory',
    durationSec: 30,
    rightsId: campaign ? 'ADSPOT' : 'HOUSE',
    explicit: false,
    playlist: campaign ? 'Sponsor Spot' : 'House Promo',
    bpm: null,
    elementKind: 'AD_SPOT' as ElementKind,
    sponsorName: campaign ? campaign.sponsorName : null,
  }
}

/**
 * GET /api/nowplaying
 * Deterministic AutoDJ "what's on air" computed from the wall clock over the
 * program-clock wheel (music blocks → station IDs → ad breaks), station
 * metadata from StationSetting, simulated listeners, and lazy PlayLog
 * accumulation (song history fills as this endpoint is polled).
 */
export async function GET() {
  try {
    const nowMs = Date.now()
    const [{ elements, cycleSec }, settings] = await Promise.all([
      getRotationWheel(nowMs),
      db.stationSetting.findMany(),
    ])
    const settingsMap = new Map(settings.map((s) => [s.key, s.value]))

    if (elements.length === 0) {
      return NextResponse.json(
        { error: 'Rotation library is empty' },
        { status: 503 },
      )
    }

    const onAir = computeOnAir(elements, cycleSec, nowMs)
    const upcoming = getUpNextElements(elements, onAir.index, 3)
    const listeners = computeListeners(nowMs)
    const clean = isCleanDaypart(nowMs)

    // Absolute slot-start instants for the current + upcoming elements
    // (startedAt is the current element's real start; later ones accumulate).
    const slotStarts: number[] = []
    let acc = onAir.startedAt.getTime()
    const elementSeq: Array<{ kind: ElementKind; durSec: number }> = [
      { kind: onAir.element.kind, durSec: onAir.element.durSec },
      ...upcoming.map((el) => ({ kind: el.kind, durSec: el.durSec })),
    ]
    for (let k = 0; k < elementSeq.length; k++) {
      slotStarts.push(acc)
      acc += (elementSeq[k].durSec + TRACK_GAP_SEC) * 1000
    }

    // On-air ad schedule (same day-anchored allocation the nightly ledger
    // pull uses) decides which creative airs in current + upcoming spots.
    let adSchedule: ReturnType<typeof adSpotScheduleForDay> = []
    if (elementSeq.some((e) => e.kind === 'AD_SPOT')) {
      const campaignRows = await db.campaign.findMany({
        where: { active: true, startAt: { lte: new Date(nowMs) } },
        include: { sponsor: true },
        orderBy: { id: 'asc' },
      })
      const campaigns = campaignRows.map((c) => ({
        id: c.id,
        name: c.name,
        sponsorName: c.sponsor.name,
        creativeName: c.creativeName,
        spotsPerDay: c.spotsPerDay,
        startAtMs: c.startAt.getTime(),
      }))
      adSchedule = [
        ...adSpotScheduleForDay(
          etDayStartUTC(new Date(nowMs - DAY_MS)).getTime(),
          elements,
          cycleSec,
          campaigns,
        ),
        ...adSpotScheduleForDay(etDayStartUTC(new Date(nowMs)).getTime(), elements, cycleSec, campaigns),
      ]
    }

    const campaignAt = (slotMs: number) => campaignForAdSlot(slotMs, adSchedule)

    // Song history: music + station IDs log to PlayLog; ad spots do not
    // (their ledger is ad_plays, written lazily below + nightly backfill).
    if (onAir.element.track) {
      await maybeLogPlays(onAir.element.track.id, onAir.startedAt)
    }

    // Queue entries (pseudo tracks for IDs and ad spots).
    const next: QueueEntry[] = upcoming.map((el, k) => {
      if (el.kind === 'AD_SPOT') {
        return adSpotTrack(campaignAt(slotStarts[k + 1]), `${Math.round(slotStarts[k + 1] / 1000)}-${k}`)
      }
      if (el.kind === 'STATION_ID' && el.track) {
        return {
          ...toTrackDTO(el.track),
          elementKind: 'STATION_ID' as ElementKind,
          sponsorName: null,
        }
      }
      return el.track
        ? { ...toTrackDTO(el.track), elementKind: 'MUSIC' as ElementKind, sponsorName: null }
        : adSpotTrack(null, `fallback-${k}`)
    })

    const currentEntry: QueueEntry = onAir.element.track
      ? {
          ...toTrackDTO(onAir.element.track),
          elementKind: onAir.element.kind,
          sponsorName: null,
        }
      : adSpotTrack(campaignAt(slotStarts[0]), `${Math.round(slotStarts[0] / 1000)}-cur`)

    // Current element descriptor for the UI.
    const currentCampaign =
      onAir.element.kind === 'AD_SPOT' ? campaignAt(slotStarts[0]) : null
    const element: NowPlayingElement = currentCampaign
      ? {
          kind: 'AD_SPOT' as ElementKind,
          campaignName: currentCampaign.name,
          sponsorName: currentCampaign.sponsorName,
          creativeName: currentCampaign.creativeName,
        }
      : { kind: onAir.element.kind }

    // Proof-of-play: a sold spot that is on the air RIGHT NOW gets its
    // ad_plays row at the exact broadcast instant (idempotent on every poll).
    if (onAir.element.kind === 'AD_SPOT' && currentCampaign) {
      await maybeLogAdPlay(currentCampaign.id, onAir.startedAt)
    }

    // Request heat + who shouted, for the current + upcoming MUSIC tracks.
    const musicIds = [currentEntry, ...next]
      .filter((e) => e.elementKind === 'MUSIC')
      .map((e) => e.id)
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
        track: currentEntry,
        startedAt: onAir.startedAt.toISOString(),
        elapsed: onAir.elapsed,
        duration: onAir.duration,
        remaining: onAir.remaining,
        progress: onAir.progress,
      },
      element,
      daypart: {
        clean,
        label: clean ? 'Clean Daypart' : 'Open Rotations',
      },
      next,
      heat,
      requestedBy,
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
