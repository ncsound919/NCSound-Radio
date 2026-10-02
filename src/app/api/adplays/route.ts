import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { toAdPlayDTO } from '@/lib/broadcast'

export const dynamic = 'force-dynamic'

/**
 * GET /api/adplays?limit=50&campaignId=?
 * Proof-of-play ledger, newest first, with campaign + sponsor joined.
 * `total` and `last7Days` respect the campaignId filter when provided
 * (they are "full" counts, independent of the limit).
 */
export async function GET(request: Request) {
  try {
    const url = new URL(request.url)
    const rawLimit = Number.parseInt(url.searchParams.get('limit') ?? '50', 10)
    const limit = Number.isFinite(rawLimit)
      ? Math.min(200, Math.max(1, Math.floor(rawLimit)))
      : 50
    const campaignId = url.searchParams.get('campaignId')
    const where = campaignId ? { campaignId } : {}

    const [plays, total, last7Days] = await Promise.all([
      db.adPlay.findMany({
        where,
        include: { campaign: { include: { sponsor: true } } },
        orderBy: { playedAt: 'desc' },
        take: limit,
      }),
      db.adPlay.count({ where }),
      db.adPlay.count({
        where: { ...where, playedAt: { gte: new Date(Date.now() - 7 * 86_400_000) } },
      }),
    ])

    return NextResponse.json({
      plays: plays.map(toAdPlayDTO),
      total,
      last7Days,
    })
  } catch (error) {
    console.error('[api/adplays]', error)
    return NextResponse.json(
      { error: 'Failed to load ad plays' },
      { status: 500 },
    )
  }
}
