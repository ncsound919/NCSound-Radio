import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import type { TracksResponse } from '@/lib/station-types'

export const dynamic = 'force-dynamic'

/**
 * GET /api/tracks — the on-air library for the listener request picker.
 * Only CLEARED, non-imaging tracks are exposed: the rights gate decides
 * what can even be requested.
 */
export async function GET() {
  try {
    const clearedRights = await db.rightsLog.findMany({
      where: { status: 'CLEARED' },
      select: { id: true },
    })
    const clearedIds = new Set(clearedRights.map((r) => r.id))

    const tracks = await db.track.findMany({
      where: { playlist: { not: 'Imaging' } },
      orderBy: [{ title: 'asc' }],
      select: {
        id: true,
        title: true,
        artist: true,
        playlist: true,
        durationSec: true,
        explicit: true,
        rightsId: true,
      },
    })

    const body: TracksResponse = {
      tracks: tracks.filter((t) => clearedIds.has(t.rightsId)),
    }
    return NextResponse.json(body)
  } catch (error) {
    console.error('[api/tracks]', error)
    return NextResponse.json({ error: 'Failed to load library' }, { status: 500 })
  }
}
