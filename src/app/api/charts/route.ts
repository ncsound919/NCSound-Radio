import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import type { ChartEntry, ChartMover, ChartsResponse } from '@/lib/station-types'

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

    const [spinsByTrack, shoutsByTrack, totalSpins7d, currentSpins, prevSpins] = await Promise.all([
      db.playLog.groupBy({
        by: ['trackId'],
        _count: { _all: true },
        _max: { playedAt: true },
        where: { playedAt: { gte: since7d } },
        orderBy: { _count: { trackId: 'desc' } },
        take: 8,
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

    const body: ChartsResponse = {
      week,
      totalSpins7d,
      mover,
      timezone: 'America/New_York',
      serverTime: new Date(nowMs).toISOString(),
    }
    return NextResponse.json(body)
  } catch (error) {
    console.error('[api/charts GET]', error)
    return NextResponse.json({ error: 'Failed to load charts' }, { status: 500 })
  }
}
