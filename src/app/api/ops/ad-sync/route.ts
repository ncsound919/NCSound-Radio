import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { stringHash } from '@/lib/broadcast'

export const dynamic = 'force-dynamic'

const DAY_MS = 24 * 3600 * 1000
const DEDUPE_TOLERANCE_MS = 90_000

/**
 * POST /api/ops/ad-sync
 * Simulates the nightly "AzuraCast song history -> ad_plays" pull: every
 * ACTIVE campaign whose flight started gets its spotsPerDay slots stamped
 * into the last 24h at deterministic, evenly-spread timestamps (offset by a
 * hash of the campaign id). Slots within 90s of an existing row are skipped,
 * and P2002 on insert is swallowed — the ledger stays idempotent.
 */
export async function POST() {
  try {
    const now = new Date()
    const nowMs = now.getTime()
    const windowStartMs = nowMs - DAY_MS

    const campaigns = await db.campaign.findMany({
      where: { active: true, startAt: { lte: now } },
    })

    let inserted = 0
    const byCampaign: Record<string, number> = {}

    for (const campaign of campaigns) {
      const spots = Math.max(1, campaign.spotsPerDay)
      const intervalMs = DAY_MS / spots
      const offsetMs = stringHash(campaign.id) % Math.max(1, Math.floor(intervalMs))

      const existing = await db.adPlay.findMany({
        where: {
          campaignId: campaign.id,
          playedAt: { gte: new Date(windowStartMs - 5 * 60_000) },
        },
        select: { playedAt: true },
      })
      const existingMs = existing.map((row) => row.playedAt.getTime())

      let campaignInserted = 0
      for (let slot = 0; slot < spots; slot++) {
        const playedAtMs = Math.round(
          windowStartMs + offsetMs + slot * intervalMs,
        )
        if (
          existingMs.some((ts) => Math.abs(ts - playedAtMs) <= DEDUPE_TOLERANCE_MS)
        ) {
          continue
        }
        try {
          await db.adPlay.create({
            data: {
              campaignId: campaign.id,
              playedAt: new Date(playedAtMs),
              source: 'azuracast-history',
            },
          })
          campaignInserted++
        } catch {
          // P2002 — raced/duplicate exact timestamp; skip.
        }
      }

      inserted += campaignInserted
      byCampaign[campaign.name] = campaignInserted
    }

    return NextResponse.json({
      ok: true,
      inserted,
      byCampaign,
      ranAt: now.toISOString(),
      note: 'Nightly sync from AzuraCast song history (simulated in sandbox)',
    })
  } catch (error) {
    console.error('[api/ops/ad-sync]', error)
    return NextResponse.json({ error: 'Ad sync failed' }, { status: 500 })
  }
}
