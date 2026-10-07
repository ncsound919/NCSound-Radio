import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { etDayStartUTC } from '@/lib/broadcast'
import { allow, clientIp, sweepRateLimits } from '@/lib/rate-limit'
import { supabaseUserId } from '@/lib/supabase-user'
import type {
  RequestRecentEntry,
  RequestTopEntry,
  RequestsResponse,
} from '@/lib/station-types'

export const dynamic = 'force-dynamic'

const postSchema = z.object({
  trackId: z.string().min(1),
  listenerName: z.string().trim().min(1).max(32),
  note: z.string().trim().max(140).optional().nullable(),
})

/**
 * GET /api/requests — the listener request line.
 * top: most-requested tracks (last 7 days of activity),
 * recent: latest shouts, totalToday / totalAllTime counters.
 */
export async function GET() {
  try {
    const since7d = new Date(Date.now() - 7 * 24 * 3600 * 1000)
    const dayStart = etDayStartUTC(new Date())

    const [grouped, recent, totalToday, totalAllTime] = await Promise.all([
      db.trackRequest.groupBy({
        by: ['trackId'],
        _count: { _all: true },
        _max: { createdAt: true },
        where: { createdAt: { gte: since7d } },
        orderBy: { _count: { trackId: 'desc' } },
        take: 6,
      }),
      db.trackRequest.findMany({
        orderBy: { createdAt: 'desc' },
        take: 8,
        include: { track: { select: { title: true, artist: true } } },
      }),
      db.trackRequest.count({ where: { createdAt: { gte: dayStart } } }),
      db.trackRequest.count(),
    ])

    // Join track metadata for the grouped rows.
    const trackIds = grouped.map((g) => g.trackId)
    const tracks = trackIds.length
      ? await db.track.findMany({
          where: { id: { in: trackIds } },
          select: {
            id: true,
            title: true,
            artist: true,
            explicit: true,
          },
        })
      : []
    const trackMap = new Map(tracks.map((t) => [t.id, t]))

    const top: RequestTopEntry[] = grouped
      .map((g) => {
        const t = trackMap.get(g.trackId)
        if (!t) return null
        return {
          trackId: g.trackId,
          title: t.title,
          artist: t.artist,
          explicit: t.explicit,
          count: g._count._all,
          lastRequestedAt: (g._max.createdAt ?? new Date()).toISOString(),
        }
      })
      .filter((x): x is RequestTopEntry => x !== null)

    const recentRows: RequestRecentEntry[] = recent.map((r) => ({
      id: r.id,
      listenerName: r.listenerName,
      note: r.note ?? null,
      trackTitle: r.track.title,
      trackArtist: r.track.artist,
      createdAt: r.createdAt.toISOString(),
    }))

    const body: RequestsResponse = {
      top,
      recent: recentRows,
      totalToday,
      totalAllTime,
    }
    return NextResponse.json(body)
  } catch (error) {
    console.error('[api/requests GET]', error)
    return NextResponse.json({ error: 'Failed to load requests' }, { status: 500 })
  }
}

/**
 * POST /api/requests — add a listener request.
 * Duplicate (track, listener) pairs are rejected
 * with 409 so the count reflects distinct listeners.
 */
export async function POST(req: NextRequest) {
  try {
    // Per-IP throttle: 5 shouts per minute (the chat line has the same spirit).
    sweepRateLimits()
    if (!allow(`req:${clientIp(req)}`, 5, 60_000)) {
      return NextResponse.json(
        { error: 'Easy on the shout-outs — try again in a minute.' },
        { status: 429 },
      )
    }

    const parsed = postSchema.safeParse(await req.json())
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Pick a track and give us your on-air name (max 32 chars).' },
        { status: 400 },
      )
    }
    const { trackId, listenerName, note } = parsed.data

    // Attribute to a signed-in listener when the app sends its Supabase JWT;
    // anonymous web listeners are still just a name.
    const userId = await supabaseUserId(req)

    const track = await db.track.findUnique({
      where: { id: trackId },
      select: { id: true, title: true, playlist: true },
    })
    if (!track) {
      return NextResponse.json({ error: 'Unknown track.' }, { status: 404 })
    }

    // Station content (imaging IDs, produced talk segments) is not requestable.
    if (track.playlist === 'Imaging' || track.playlist === 'Talk') {
      return NextResponse.json(
        { error: 'That one is station content — only songs are requestable.' },
        { status: 403 },
      )
    }

    try {
      const created = await db.trackRequest.create({
        data: {
          trackId,
          listenerName,
          userId,
          note: note?.trim() ? note.trim().slice(0, 140) : null,
        },
      })
      const count = await db.trackRequest.count({ where: { trackId } })
      const body = {
        ok: true as const,
        request: {
          id: created.id,
          trackId: created.trackId,
          listenerName: created.listenerName,
          note: created.note ?? null,
          createdAt: created.createdAt.toISOString(),
        },
        count,
        message: `Request logged — "${track.title}" now has ${count} shout${count === 1 ? '' : 's'}.`,
      }
      return NextResponse.json(body, { status: 201 })
    } catch (e: unknown) {
      if (
        typeof e === 'object' &&
        e !== null &&
        'code' in e &&
        (e as { code?: string }).code === 'P2002'
      ) {
        return NextResponse.json(
          { error: `You already shouted for that one, ${listenerName}.` },
          { status: 409 },
        )
      }
      throw e
    }
  } catch (error) {
    console.error('[api/requests POST]', error)
    return NextResponse.json({ error: 'Failed to log request' }, { status: 500 })
  }
}
