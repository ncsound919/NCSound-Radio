import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { toHistoryEntry } from '@/lib/broadcast'

export const dynamic = 'force-dynamic'

/**
 * GET /api/history?limit=10
 * Last N PlayLog rows, newest first, with the track joined.
 * (Rows accumulate because /api/nowplaying lazily logs each slot.)
 */
export async function GET(request: Request) {
  try {
    const url = new URL(request.url)
    const rawLimit = Number.parseInt(url.searchParams.get('limit') ?? '10', 10)
    const limit = Number.isFinite(rawLimit)
      ? Math.min(50, Math.max(1, Math.floor(rawLimit)))
      : 10

    const plays = await db.playLog.findMany({
      orderBy: { playedAt: 'desc' },
      take: limit,
      include: { track: true },
    })

    return NextResponse.json({ plays: plays.map(toHistoryEntry) })
  } catch (error) {
    console.error('[api/history]', error)
    return NextResponse.json(
      { error: 'Failed to load play history' },
      { status: 500 },
    )
  }
}
