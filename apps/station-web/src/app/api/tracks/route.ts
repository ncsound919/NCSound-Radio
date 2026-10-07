import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import type { TracksResponse } from '@/lib/station-types'

export const dynamic = 'force-dynamic'

/**
 * GET /api/tracks — the on-air library for the listener request picker.
 * Station content (imaging, talk) is left out; everything else is requestable.
 */
export async function GET() {
  try {
    const tracks = await db.track.findMany({
      where: { playlist: { notIn: ['Imaging', 'Talk'] } },
      orderBy: [{ title: 'asc' }],
      select: {
        id: true,
        title: true,
        artist: true,
        playlist: true,
        durationSec: true,
        explicit: true,
      },
    })

    const body: TracksResponse = {
      tracks,
    }
    return NextResponse.json(body)
  } catch (error) {
    console.error('[api/tracks]', error)
    return NextResponse.json({ error: 'Failed to load library' }, { status: 500 })
  }
}
