import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import type { ChartEntry, ChartsResponse } from '@/lib/station-types'

export const dynamic = 'force-dynamic'

/**
 * GET /api/charts — "The Wave Chart".
 * Most-heard cleared tracks over the trailing 7 days, ranked by spins from the
 * PlayLog ledger, with listener shout heat joined in. Imaging plays count
 * toward totalSpins7d but never chart. The rights gate is implicit: every
 * Track row was only created after its record read CLEARED.
 */
export async function GET() {
  try {
    const nowMs = Date.now()
    const since7d = new Date(nowMs - 7 * 86_400_000)

    const [spinsByTrack, shoutsByTrack, totalSpins7d, currentSpins] = await Promise.all([
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
    ])

    const onAirIds = new Set(currentSpins.map((s) => s.trackId))
    const shoutMap = new Map(shoutsByTrack.map((s) => [s.trackId, s._count._all]))

    const trackIds = spinsByTrack.map((s) => s.trackId)
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
        },
      ]
    })

    // Secondary sort: shouts break spin ties so request heat is visible.
    rows.sort((a, b) => b.spins7d - a.spins7d || b.shouts7d - a.shouts7d)

    const week: ChartEntry[] = rows.slice(0, 6).map((r, i) => ({ ...r, rank: i + 1 }))

    const body: ChartsResponse = {
      week,
      totalSpins7d,
      timezone: 'America/New_York',
      serverTime: new Date(nowMs).toISOString(),
    }
    return NextResponse.json(body)
  } catch (error) {
    console.error('[api/charts GET]', error)
    return NextResponse.json({ error: 'Failed to load charts' }, { status: 500 })
  }
}
