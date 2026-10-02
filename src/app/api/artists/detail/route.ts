import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import type { ArtistDetailResponse, ArtistRecentSpin, ArtistTrackRow } from '@/lib/station-types'

export const dynamic = 'force-dynamic'

/**
 * GET /api/artists/detail?name=… — public artist profile behind the Wave Chart.
 * Everything shown is earned from the PlayLog ledger (the same audit trail the
 * broadcast writes); no ops data, no PII. Unknown names return 200 + found:false
 * so the client shows a gentle "nothing on the ledger yet" state instead of an error.
 */
export async function GET(request: NextRequest) {
  try {
    const raw = request.nextUrl.searchParams.get('name') ?? ''
    const name = raw.trim().slice(0, 120)
    if (!name) {
      return NextResponse.json({ error: 'Missing artist name' }, { status: 400 })
    }

    // Artist is a free-text field on Track; resolve the canonical casing
    // case-insensitively (SQLite has no mode:'insensitive').
    const distinct = await db.track.findMany({
      where: { playlist: { not: 'Imaging' } },
      select: { artist: true },
      distinct: ['artist'],
      take: 300,
    })
    const canonical = distinct
      .map((d) => d.artist)
      .find((a) => a.toLowerCase() === name.toLowerCase())

    if (!canonical) {
      const empty: ArtistDetailResponse = {
        artist: name,
        found: false,
        trackCount: 0,
        spins7d: 0,
        totalSpins: 0,
        sharePct: 0,
        firstPlayedAt: null,
        lastPlayedAt: null,
        tracks: [],
        recent: [],
        serverTime: new Date().toISOString(),
      }
      return NextResponse.json(empty)
    }

    const nowMs = Date.now()
    const since7d = new Date(nowMs - 7 * 86_400_000)

    const [tracks, spins7dByTrack, allTimeByTrack, shouts7dByTrack, currentSpins, recentRows, musicSpins7d, weekSpins, weekShouts] =
      await Promise.all([
        db.track.findMany({
          where: { artist: canonical, playlist: { not: 'Imaging' } },
          select: {
            id: true,
            title: true,
            rightsId: true,
            playlist: true,
            explicit: true,
          },
        }),
        db.playLog.groupBy({
          by: ['trackId'],
          _count: { _all: true },
          where: { playedAt: { gte: since7d }, track: { artist: canonical } },
        }),
        db.playLog.groupBy({
          by: ['trackId'],
          _count: { _all: true },
          _min: { playedAt: true },
          _max: { playedAt: true },
          where: { track: { artist: canonical } },
        }),
        db.trackRequest.groupBy({
          by: ['trackId'],
          _count: { _all: true },
          where: { createdAt: { gte: since7d }, track: { artist: canonical } },
        }),
        // On-air now: the three most recent ledger spins (same heuristic as /api/charts).
        db.playLog.findMany({
          orderBy: { playedAt: 'desc' },
          take: 3,
          select: { trackId: true },
        }),
        db.playLog.findMany({
          orderBy: { playedAt: 'desc' },
          take: 8,
          where: { track: { artist: canonical } },
          select: { playedAt: true, source: true, track: { select: { title: true } } },
        }),
        db.playLog.count({
          where: { playedAt: { gte: since7d }, track: { playlist: { not: 'Imaging' } } },
        }),
        // This week's full chart ranking (music-only) so track rows can show
        // their Wave Chart position — same ranking rules as /api/charts.
        db.playLog.groupBy({
          by: ['trackId'],
          _count: { _all: true },
          where: { playedAt: { gte: since7d }, track: { playlist: { not: 'Imaging' } } },
          orderBy: { _count: { trackId: 'desc' } },
          take: 40,
        }),
        // Week-wide shout heat — the chart's tiebreaker.
        db.trackRequest.groupBy({
          by: ['trackId'],
          _count: { _all: true },
          where: { createdAt: { gte: since7d } },
        }),
      ])

    const spins7dMap = new Map(spins7dByTrack.map((s) => [s.trackId, s._count._all]))
    const allTimeMap = new Map(
      allTimeByTrack.map((s) => [s.trackId, { total: s._count._all, max: s._max.playedAt, min: s._min.playedAt }]),
    )
    const shoutMap = new Map(shouts7dByTrack.map((s) => [s.trackId, s._count._all]))
    const onAirIds = new Set(currentSpins.map((s) => s.trackId))

    // Chart ranks with the EXACT same rules as /api/charts: spins first,
    // listener shouts break ties. The public chart shows the top 6, so only
    // those positions count as "charting" — deeper ranks stay null.
    const CHART_DEPTH = 6
    const weekShoutMap = new Map(weekShouts.map((s) => [s.trackId, s._count._all]))
    const chartRankMap = new Map<string, number>()
    ;[...weekSpins]
      .sort(
        (a, b) =>
          b._count._all - a._count._all ||
          (weekShoutMap.get(b.trackId) ?? 0) - (weekShoutMap.get(a.trackId) ?? 0),
      )
      .forEach((s, i) => {
        if (i < CHART_DEPTH && !chartRankMap.has(s.trackId)) chartRankMap.set(s.trackId, i + 1)
      })

    const trackRows: ArtistTrackRow[] = tracks
      .map((t) => ({
        trackId: t.id,
        title: t.title,
        rightsId: t.rightsId,
        playlist: t.playlist,
        explicit: t.explicit,
        spins7d: spins7dMap.get(t.id) ?? 0,
        totalSpins: allTimeMap.get(t.id)?.total ?? 0,
        shouts7d: shoutMap.get(t.id) ?? 0,
        chartRank: chartRankMap.get(t.id) ?? null,
        onAirNow: onAirIds.has(t.id),
        lastPlayedAt: (allTimeMap.get(t.id)?.max ?? null)?.toISOString() ?? null,
      }))
      .sort((a, b) => b.spins7d - a.spins7d || b.totalSpins - a.totalSpins || a.title.localeCompare(b.title))

    const totalSpins = trackRows.reduce((sum, t) => sum + t.totalSpins, 0)
    const spins7d = trackRows.reduce((sum, t) => sum + t.spins7d, 0)
    const firstMs = allTimeByTrack.reduce<number | null>(
      (acc, s) =>
        s._min.playedAt && (acc === null || s._min.playedAt.getTime() < acc) ? s._min.playedAt.getTime() : acc,
      null,
    )
    const lastMs = allTimeByTrack.reduce<number | null>(
      (acc, s) =>
        s._max.playedAt && (acc === null || s._max.playedAt.getTime() > acc) ? s._max.playedAt.getTime() : acc,
      null,
    )

    const recent: ArtistRecentSpin[] = recentRows.map((r) => ({
      title: r.track.title,
      playedAt: r.playedAt.toISOString(),
      source: r.source,
    }))

    const body: ArtistDetailResponse = {
      artist: canonical,
      found: true,
      trackCount: trackRows.length,
      spins7d,
      totalSpins,
      sharePct: musicSpins7d > 0 ? Math.round((spins7d / musicSpins7d) * 100) : 0,
      firstPlayedAt: firstMs !== null ? new Date(firstMs).toISOString() : null,
      lastPlayedAt: lastMs !== null ? new Date(lastMs).toISOString() : null,
      tracks: trackRows,
      recent,
      serverTime: new Date(nowMs).toISOString(),
    }
    return NextResponse.json(body)
  } catch (error) {
    console.error('[api/artists/detail GET]', error)
    return NextResponse.json({ error: 'Failed to load artist detail' }, { status: 500 })
  }
}
