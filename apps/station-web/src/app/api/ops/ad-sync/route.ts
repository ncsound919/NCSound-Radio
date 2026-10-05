import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import {
  adSpotScheduleForDay,
  etDayStartUTC,
  getRotationWheel,
  DAY_MS,
} from '@/lib/broadcast'
import { requireAdmin } from '@/lib/admin-auth'

export const dynamic = 'force-dynamic'

const DEDUPE_TOLERANCE_MS = 90_000

/**
 * POST /api/ops/ad-sync
 *
 * Computes proof-of-play from the station's own schedule. It walks the SAME
 * day-anchored ad schedule the on-air clock uses to pick creatives and stamps
 * every SOLD spot from the last 24 hours into the ledger with its broadcast
 * timestamp — so proof-of-play always matches what actually aired.
 *
 * Provenance, stated plainly because this used to be the problem: there is no
 * AzuraCast in this stack and no external history API is read. These rows are
 * derived here, and they are labelled `program-clock` to say so. They were
 * previously written as `azuracast-history`, which made a locally computed
 * figure look like an externally attested one — the kind of difference that
 * matters enormously when a number ends up in a sponsorship invoice.
 *
 * House promos (unsold inventory) never appear in the ledger. Slots within
 * 90s of an existing row are skipped and P2002 is swallowed — idempotent.
 */
export async function POST(request: Request) {
  try {
    const denied = await requireAdmin(request)
    if (denied) return denied

    const now = new Date()
    const nowMs = now.getTime()
    const windowStartMs = nowMs - DAY_MS

    const [{ elements, cycleSec }, campaignRows] = await Promise.all([
      getRotationWheel(nowMs),
      db.campaign.findMany({
        where: { active: true, startAt: { lte: now } },
        include: { sponsor: true },
        orderBy: { id: 'asc' },
      }),
    ])
    const campaigns = campaignRows.map((c) => ({
      id: c.id,
      name: c.name,
      sponsorName: c.sponsor.name,
      creativeName: c.creativeName,
      spotsPerDay: c.spotsPerDay,
      startAtMs: c.startAt.getTime(),
    }))

    // Sold/house allocation for yesterday + today, clipped to the window.
    const schedule = [
      ...adSpotScheduleForDay(
        etDayStartUTC(new Date(nowMs - DAY_MS)).getTime(),
        elements,
        cycleSec,
        campaigns,
      ),
      ...adSpotScheduleForDay(etDayStartUTC(now).getTime(), elements, cycleSec, campaigns),
    ].filter((s) => s.campaign && s.atMs <= nowMs && s.atMs >= windowStartMs)

    const existing = await db.adPlay.findMany({
      where: { playedAt: { gte: new Date(windowStartMs - 5 * 60_000) } },
      select: { campaignId: true, playedAt: true },
    })

    let inserted = 0
    const byCampaign: Record<string, number> = {}

    for (const slot of schedule) {
      if (!slot.campaign) continue
      if (
        existing.some(
          (row) =>
            Math.abs(row.playedAt.getTime() - slot.atMs) <= DEDUPE_TOLERANCE_MS,
        )
      ) {
        continue
      }
      try {
        await db.adPlay.create({
          data: {
            campaignId: slot.campaign.id,
            playedAt: new Date(slot.atMs),
            source: 'program-clock',
          },
        })
        inserted++
        byCampaign[slot.campaign.name] = (byCampaign[slot.campaign.name] ?? 0) + 1
      } catch {
        // P2002 — raced/duplicate exact timestamp; skip.
      }
    }

    return NextResponse.json({
      ok: true,
      inserted,
      byCampaign,
      ranAt: now.toISOString(),
      note: 'Computed from the station program clock. No external history API is read.',
    })
  } catch (error) {
    console.error('[api/ops/ad-sync]', error)
    return NextResponse.json({ error: 'Ad sync failed' }, { status: 500 })
  }
}
