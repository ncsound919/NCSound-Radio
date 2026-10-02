import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import {
  computeListeners,
  etDayStartUTC,
  LAUNCH_UTC_MS,
} from '@/lib/broadcast'

export const dynamic = 'force-dynamic'

const DAY_MS = 86_400_000

/** The 8-item pre-launch checklist from the station operations plan. */
const CHECKLIST = [
  'Supported OS confirmed and a KVM VPS chosen',
  'AzuraCast installed, HTTPS working on desktop and mobile',
  'Rights gate enforced: no track uploaded without a CLEARED record',
  'Fallback playlist tested by stopping the main one',
  'Backups restored once as a test',
  'Dummy ad scheduled and its play captured in ad_plays',
  'Uptime alert tested',
  'Bandwidth projection done',
] as const

/**
 * GET /api/stats — ops dashboard rollup: library + rights-gate counts,
 * submission pipeline, sponsor MRR, proof-of-play, listeners, bandwidth
 * projection and uptime.
 */
export async function GET() {
  try {
    const nowMs = Date.now()

    const [
      tracks,
      clearedRightsIds,
      pendingRights,
      blocked,
      durationAgg,
      submissionGroups,
      activeSponsors,
      mrrAgg,
      adLast7Days,
      adToday,
    ] = await Promise.all([
      db.track.count({ where: { playlist: { not: 'Imaging' } } }),
      // Cleared library = music tracks whose rights record is CLEARED. Counting
      // CLEARED records alone overshoots when a submission was approved (record
      // issued) but the file has not landed on the wheel yet — the tile would
      // read "23 cleared / 22 tracks" forever. Count tracks, not records.
      db.rightsLog.findMany({ where: { status: 'CLEARED' }, select: { id: true } }),
      db.rightsLog.count({ where: { status: { in: ['PENDING', 'IN_REVIEW'] } } }),
      db.rightsLog.count({ where: { status: 'BLOCKED' } }),
      db.track.aggregate({
        _sum: { durationSec: true },
        where: { playlist: { not: 'Imaging' } },
      }),
      db.submission.groupBy({ by: ['status'], _count: { _all: true } }),
      db.sponsor.count({ where: { status: 'ACTIVE' } }),
      db.sponsor.aggregate({
        _sum: { monthlyRate: true },
        where: { status: 'ACTIVE' },
      }),
      db.adPlay.count({
        where: { playedAt: { gte: new Date(nowMs - 7 * DAY_MS) } },
      }),
      db.adPlay.count({ where: { playedAt: { gte: etDayStartUTC(new Date(nowMs)) } } }),
    ])

    const clearedIdSet = new Set(clearedRightsIds.map((r) => r.id))
    const musicTracks = await db.track.findMany({
      where: { playlist: { not: 'Imaging' } },
      select: { rightsId: true },
    })
    const cleared = musicTracks.filter((t) => clearedIdSet.has(t.rightsId)).length

    const subMap = new Map(
      submissionGroups.map((g) => [g.status, g._count._all]),
    )
    const submissionsTotal = submissionGroups.reduce(
      (acc, g) => acc + g._count._all,
      0,
    )

    const totalHours =
      Math.round(((durationAgg._sum.durationSec ?? 0) / 3600) * 10) / 10
    const listeners = computeListeners(nowMs)

    // 128kbps ≈ 0.058 GB per listener-hour; 0.15 = avg daily listening factor.
    const projectedGBDay =
      Math.round(0.058 * listeners.current * 24 * 0.15 * 10) / 10

    return NextResponse.json({
      library: {
        tracks,
        cleared,
        pendingRights,
        blocked,
        totalHours,
      },
      submissions: {
        total: submissionsTotal,
        pending: subMap.get('PENDING') ?? 0,
        inReview: subMap.get('IN_REVIEW') ?? 0,
        approved: subMap.get('APPROVED') ?? 0,
        declined: subMap.get('DECLINED') ?? 0,
      },
      sponsors: {
        active: activeSponsors,
        monthlyMRR: Math.round((mrrAgg._sum.monthlyRate ?? 0) / 100),
      },
      adplays: {
        last7Days: adLast7Days,
        today: adToday,
      },
      listeners,
      bandwidth: {
        kbps: 128,
        gbPerListenerHour: 0.058,
        projectedGBDay,
      },
      uptime: {
        streamOk: true,
        daysSinceLaunch: Math.max(0, Math.floor((nowMs - LAUNCH_UTC_MS) / DAY_MS)),
      },
      checklist: [...CHECKLIST],
    })
  } catch (error) {
    console.error('[api/stats]', error)
    return NextResponse.json({ error: 'Failed to load stats' }, { status: 500 })
  }
}
