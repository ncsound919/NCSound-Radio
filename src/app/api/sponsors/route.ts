import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { etDayStartUTC, toSponsorDTO } from '@/lib/broadcast'

export const dynamic = 'force-dynamic'

/** Static rate card shown on the sponsors board. */
const PACKAGES = [
  {
    id: 'on-air-spot',
    name: 'On-Air Spot',
    price: '$180/mo',
    spotsPerDay: 8,
    perks: [
      '15s or 30s produced spot',
      'Proof-of-play ledger access',
      'Monthly air-check report',
    ],
  },
  {
    id: 'show-sponsor',
    name: 'Show Sponsor',
    price: '$300/mo',
    spotsPerDay: 4,
    perks: [
      '\u201cPresented by\u201d show billing',
      '2 spots per episode',
      'Name in show notes + site',
    ],
  },
  {
    id: 'daypart-sponsor',
    name: 'Daypart Sponsor',
    price: '$450/mo',
    spotsPerDay: 6,
    perks: [
      'Clean Daypart exclusivity',
      'Morning + midday windows',
      'Quarterly listener survey mention',
    ],
  },
] as const

/**
 * GET /api/sponsors — sponsors with nested campaigns plus proof-of-play
 * counters (playsTotal, playsToday against America/New_York midnight).
 */
export async function GET() {
  try {
    const dayStart = etDayStartUTC()
    const [sponsors, totals, todays] = await Promise.all([
      db.sponsor.findMany({
        include: { campaigns: { orderBy: { startAt: 'asc' } } },
        orderBy: { startAt: 'asc' },
      }),
      db.adPlay.groupBy({ by: ['campaignId'], _count: { _all: true } }),
      db.adPlay.groupBy({
        by: ['campaignId'],
        where: { playedAt: { gte: dayStart } },
        _count: { _all: true },
      }),
    ])

    const totalMap = new Map(totals.map((r) => [r.campaignId, r._count._all]))
    const todayMap = new Map(todays.map((r) => [r.campaignId, r._count._all]))

    return NextResponse.json({
      sponsors: sponsors.map((s) => toSponsorDTO(s, totalMap, todayMap)),
      packages: PACKAGES,
    })
  } catch (error) {
    console.error('[api/sponsors]', error)
    return NextResponse.json(
      { error: 'Failed to load sponsors' },
      { status: 500 },
    )
  }
}
