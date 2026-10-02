import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { etWallClock, toShowDTO } from '@/lib/broadcast'

export const dynamic = 'force-dynamic'

/**
 * GET /api/schedule
 * Weekly show grid + the show on air right now, computed against the
 * America/New_York wall clock (DST-safe via Intl).
 */
export async function GET() {
  try {
    const shows = await db.show.findMany({
      orderBy: [
        { dayOfWeek: 'asc' },
        { startHour: 'asc' },
        { startMinute: 'asc' },
      ],
    })

    const wc = etWallClock(new Date())
    const currentShow = shows.find((s) => {
      if (!s.active || s.dayOfWeek !== wc.dayOfWeek) return false
      const startMin = s.startHour * 60 + s.startMinute
      return (
        wc.minuteOfDay >= startMin && wc.minuteOfDay < startMin + s.durationMin
      )
    })

    const hh = String(wc.hour).padStart(2, '0')
    const mm = String(wc.minute).padStart(2, '0')

    return NextResponse.json({
      timezone: 'America/New_York',
      now: {
        dayOfWeek: wc.dayOfWeek,
        minutes: wc.minuteOfDay,
        label: `${wc.weekdayShort} ${hh}:${mm} ET`,
      },
      shows: shows.map(toShowDTO),
      currentShowId: currentShow?.id ?? null,
    })
  } catch (error) {
    console.error('[api/schedule]', error)
    return NextResponse.json(
      { error: 'Failed to load schedule' },
      { status: 500 },
    )
  }
}
