import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import type {
  AllTimeEntry,
  ArtistEntry,
  ChartEntry,
  ChartMover,
  ChartsResponse,
} from '@/lib/station-types'

export const dynamic = 'force-dynamic'

/**
 * GET /api/charts — "The Wave Chart".
 * Most-heard cleared tracks over the trailing 7 days, ranked by spins from the
 * PlayLog ledger, with listener shout heat joined in. Imaging plays count
 * toward totalSpins7d but never chart. The rights gate is implicit: every
 * Track row was only created after its record read CLEARED.
 *
 * Week-over-week movement ("biggest mover") is derived statelessly from the
 * same ledger: the previous comparable window is the 7 days ending 24h ago.
 */
export async function GET() {
  try {
    const nowMs = Date.now()
    const since7d = new Date(nowMs - 7 * 86_400_000)
    const sincePrev = new Date(nowMs - 8 * 86_400_000)
    const untilPrev = new Date(nowMs - 1 * 86_400_000)

    const [spinsByTrack, shoutsByTrack, totalSpins7d, currentSpins, prevSpins, allTimeSpins, musicSpins7d] = await Promise.all([
      db.playLog.groupBy({
        by: ['trackId'],
        _count: { _all: true },
        _max: { playedAt: true },
        where: { playedAt: { gte: since7d } },
        orderBy: { _count: { trackId: 'desc' } },
        take: 40,
      }),
      db.trackRequest.groupBy({
        by: ['trackId'],
        _count: { _all: true },
        where: { createdAt: { gte: since7d } },
      }),
      db.playLog.count({ where: { playedAt: { gte: since7d } } }),
      db.playLog.findMany({
        orderBy: { playedAt: 'desc' },
        take: 3,
        select: { trackId: true },
      }),
      // Previous comparable window: deep enough to place this week's entries.
      db.playLog.groupBy({
        by: ['trackId'],
        _count: { _all: true },
        where: { playedAt: { gte: sincePrev, lt: untilPrev } },
        orderBy: { _count: { trackId: 'desc' } },
        take: 40,
      }),
      // Hall of Fame: every spin since launch, per track.
      db.playLog.groupBy({
        by: ['trackId'],
        _count: { _all: true },
        _min: { playedAt: true },
        _max: { playedAt: true },
        orderBy: { _count: { trackId: 'desc' } },
        take: 5,
      }),
      // Denominator for the artist share bars: all music rows this week.
      db.playLog.count({
        where: {
          playedAt: { gte: since7d },
          track: { playlist: { not: 'Imaging' } },
        },
      }),
    ])

    const onAirIds = new Set(currentSpins.map((s) => s.trackId))
    const shoutMap = new Map(shoutsByTrack.map((s) => [s.trackId, s._count._all]))

    const trackIds = Array.from(
      new Set([...spinsByTrack.map((s) => s.trackId), ...prevSpins.map((s) => s.trackId)]),
    )
    const tracks = trackIds.length
      ? await db.track.findMany({
          where: { id: { in: trackIds }, playlist: { not: 'Imaging' } },
          select: {
            id: true,
            title: true,
            artist: true,
            rightsId: true,
            playlist: true,
            explicit: true,
          },
        })
      : []
    const trackMap = new Map(tracks.map((t) => [t.id, t]))

    // Previous-window ranks, computed AFTER imaging rows drop out so the two
    // windows rank on exactly the same population (music only).
    const prevRankMap = new Map<string, number>()
    let prevRank = 0
    for (const p of prevSpins) {
      if (!trackMap.has(p.trackId)) continue
      prevRank += 1
      prevRankMap.set(p.trackId, prevRank)
    }

    const rows: Array<Omit<ChartEntry, 'rank'>> = spinsByTrack.flatMap((s) => {
      const t = trackMap.get(s.trackId)
      if (!t) return [] // imaging / talk rows never chart
      return [
        {
          trackId: t.id,
          title: t.title,
          artist: t.artist,
          rightsId: t.rightsId,
          playlist: t.playlist,
          explicit: t.explicit,
          spins7d: s._count._all,
          shouts7d: shoutMap.get(t.id) ?? 0,
          lastPlayedAt: (s._max.playedAt ?? null)?.toISOString() ?? null,
          onAirNow: onAirIds.has(t.id),
          prevRank: prevRankMap.get(t.id) ?? null,
        },
      ]
    })

    // Secondary sort: shouts break spin ties so request heat is visible.
    rows.sort((a, b) => b.spins7d - a.spins7d || b.shouts7d - a.shouts7d)

    const week: ChartEntry[] = rows.slice(0, 6).map((r, i) => ({ ...r, rank: i + 1 }))

    // Biggest mover: largest climb among charted entries (needs ≥ 2 positions
    // so noise doesn't crown a mover over a single extra spin).
    let mover: ChartMover | null = null
    for (const r of week) {
      if (r.prevRank === null) continue
      const delta = r.prevRank - r.rank
      if (delta >= 2 && (!mover || delta > mover.delta)) {
        mover = { trackId: r.trackId, title: r.title, artist: r.artist, delta, rank: r.rank }
      }
    }

    // Artists of the Week: aggregate this week's music spins by artist over
    // the same rows the weekly chart ranks (imaging rows dropped by the join).
    const artistAgg = new Map<string, { spins: number; tracks: number; topTitle: string; topSpins: number }>()
    for (const s of spinsByTrack) {
      const t = trackMap.get(s.trackId)
      if (!t) continue
      const cur = artistAgg.get(t.artist) ?? { spins: 0, tracks: 0, topTitle: t.title, topSpins: 0 }
      cur.spins += s._count._all
      cur.tracks += 1
      if (s._count._all > cur.topSpins) {
        cur.topSpins = s._count._all
        cur.topTitle = t.title
      }
      artistAgg.set(t.artist, cur)
    }
    const topArtists: ArtistEntry[] = Array.from(artistAgg.entries())
      .sort((a, b) => b[1].spins - a[1].spins)
      .slice(0, 4)
      .map(([artist, agg]) => ({
        artist,
        spins7d: agg.spins,
        trackCount: agg.tracks,
        topTrackTitle: agg.topTitle,
        sharePct: musicSpins7d > 0 ? Math.round((agg.spins / musicSpins7d) * 100) : 0,
      }))

    // Hall of Fame: same music-only filter, ranked on the all-time ledger.
    const allTimeIds = allTimeSpins.map((s) => s.trackId)
    const allTimeTracks = allTimeIds.length
      ? await db.track.findMany({
          where: { id: { in: allTimeIds }, playlist: { not: 'Imaging' } },
          select: { id: true, title: true, artist: true, rightsId: true },
        })
      : []
    const allTimeMap = new Map(allTimeTracks.map((t) => [t.id, t]))
    const allTime: AllTimeEntry[] = allTimeSpins.flatMap((s, i) => {
      const t = allTimeMap.get(s.trackId)
      if (!t) return []
      return [
        {
          trackId: t.id,
          rank: 0, // re-ranked below after the final sort
          title: t.title,
          artist: t.artist,
          rightsId: t.rightsId,
          totalSpins: s._count._all,
          firstPlayedAt: (s._min.playedAt ?? null)?.toISOString() ?? null,
          lastPlayedAt: (s._max.playedAt ?? null)?.toISOString() ?? null,
        },
      ]
    })
    allTime.sort((a, b) => b.totalSpins - a.totalSpins)
    allTime.forEach((e, i) => {
      e.rank = i + 1
    })

    const body: ChartsResponse = {
      week,
      totalSpins7d,
      mover,
      allTime,
      topArtists,
      musicSpins7d,
      timezone: 'America/New_York',
      serverTime: new Date(nowMs).toISOString(),
    }
    return NextResponse.json(body)
  } catch (error) {
    console.error('[api/charts GET]', error)
    return NextResponse.json({ error: 'Failed to load charts' }, { status: 500 })
  }
}
