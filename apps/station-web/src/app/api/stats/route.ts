import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { ingestStatus } from '@/lib/ingest'
import { etDayStartUTC, LAUNCH_UTC_MS } from '@/lib/broadcast'

export const dynamic = 'force-dynamic'

const DAY_MS = 86_400_000

/**
 * A readiness item that is either measured true, measured false, or unknown.
 *
 * `unknown` is not `false`. A check whose inputs are unavailable must not render
 * as a confident tick or a confident cross — that is the same defect as the
 * confident `0` this project has been removing.
 */
type ReadinessState = 'ok' | 'problem' | 'unknown'

type ReadinessItem = {
  id: string
  label: string
  state: ReadinessState
  /** What was actually observed. Always populated, including when unknown. */
  detail: string
}

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
      live,
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
      ingestStatus(),
    ])

    const clearedIdSet = new Set(clearedRightsIds.map((r) => r.id))
    const musicTracks = await db.track.findMany({
      where: { playlist: { not: 'Imaging' } },
      select: { rightsId: true },
    })
    const cleared = musicTracks.filter((t) => clearedIdSet.has(t.rightsId)).length

    /**
     * Readiness, measured.
     *
     * This replaces a hardcoded 8-item pre-launch checklist whose progress was
     * stored in `localStorage` and drawn next to the label as though the station
     * had measured itself. Two of those items ("uptime alert tested", "backups
     * restored") cannot be measured from here at all, so they are not invented
     * — they are simply absent. Every item below is derived from a value this
     * request actually fetched.
     */
    const readiness: ReadinessItem[] = []
    const push = (id: string, label: string, state: ReadinessState, detail: string) =>
      readiness.push({ id, label, state, detail })

    if (!live) {
      push('engine', 'Engine reachable', 'unknown', 'ingest did not answer, so nothing can be measured')
    } else {
      // `live.engine`, not the later `engine` binding: readiness is computed
      // before that alias exists.
      // `live.engine.telemetry.decks`, not `live.engine.decks`: the decks live
      // under telemetry. Reading the wrong path yields undefined, and `?? []`
      // then turns "I could not find this" into "no deck is rolling" — a
      // confident false alarm, which is the defect this panel exists to remove.
      const deckTelemetry = live.engine.telemetry?.decks
      if (!deckTelemetry) {
        push('engine', 'Engine has audio cued', 'unknown', 'the engine reported no deck telemetry')
      } else {
        const rolling = deckTelemetry.some((d) => d.playing)
        push(
          'engine',
          'Engine has audio cued',
          rolling ? 'ok' : 'problem',
          rolling
            ? `deck rolling: ${deckTelemetry.find((d) => d.playing)?.trackId ?? 'unknown'}`
            : 'no deck is rolling, so the station has nothing to broadcast',
        )
      }
      push(
        'sequencer',
        'Sequencer running',
        live.engine.autopilot.enabled ? 'ok' : 'problem',
        live.engine.autopilot.enabled
          ? `sequencing ${live.engine.autopilot.crateSize} crate tracks`
          : 'autopilot is off, so the station stops dead at the end of this track',
      )
      push(
        'library',
        'Crate has playable audio',
        live.engine.autopilot.crateSize > 0 ? 'ok' : 'problem',
        `${live.engine.autopilot.crateSize} tracks in the engine crate`,
      )
    }

    const rStream = live?.stream ?? null
    if (!rStream) {
      push('icecast', 'Icecast reachable', 'unknown', 'no stream status was returned')
    } else {
      push(
        'icecast',
        'Icecast reachable',
        rStream.icecast.reachable ? 'ok' : 'problem',
        rStream.icecast.reachable
          ? `reporting version ${rStream.icecast.version ?? 'unknown'}`
          : (rStream.icecast.error ?? 'unreachable'),
      )
      const connected = rStream.mounts.filter((m) => m.connected).length
      push(
        'mount',
        'A mount has a connected source',
        connected > 0 ? 'ok' : 'problem',
        `${connected} of ${rStream.mounts.length} mounts connected`,
      )
    }

    const b = live?.broadcast
    push(
      'broadcast',
      'Output switched on air',
      !b ? 'unknown' : b.components.outputLive ? 'ok' : 'problem',
      !b
        ? 'no broadcast verdict was returned'
        : b.onAir
          ? 'engine playing, output live, source connected'
          : (b.reason || 'not broadcasting'),
    )

    /**
     * The check that would have caught the five-hour outage: does the mount
     * actually carry audio? Everything above can be healthy while this is
     * silent.
     */
    const wd = live?.watchdog
    if (!wd || !wd.last) {
      push(
        'delivery',
        'Audio reaching listeners',
        'unknown',
        wd?.enabled === false
          ? 'the delivery watchdog is disabled, so this is not being measured'
          : 'the watchdog has not taken a measurement yet',
      )
    } else {
      push(
        'delivery',
        'Audio reaching listeners',
        wd.last.verdict === 'audible' ? 'ok' : wd.last.verdict === 'silent' ? 'problem' : 'unknown',
        wd.last.verdict === 'audible'
          ? `mount mean ${wd.last.meanDb?.toFixed(1)} dBFS at ${new Date(wd.last.measuredAt).toLocaleTimeString()}`
          : wd.last.verdict === 'silent'
            ? `mount silent at ${wd.last.meanDb?.toFixed(1)} dBFS${wd.holdingBecause ? ` — ${wd.holdingBecause}` : ''}`
            : `could not read the mount: ${wd.last.error ?? 'unknown'}`,
      )
    }

    push(
      'rights',
      'Every library track has a rights record',
      tracks === 0 ? 'unknown' : cleared === tracks ? 'ok' : 'problem',
      tracks === 0
        ? 'no music tracks synced yet'
        : `${cleared} of ${tracks} cleared${blocked > 0 ? `, ${blocked} blocked` : ''}`,
    )

    const subMap = new Map(
      submissionGroups.map((g) => [g.status, g._count._all]),
    )
    const submissionsTotal = submissionGroups.reduce(
      (acc, g) => acc + g._count._all,
      0,
    )

    const totalHours =
      Math.round(((durationAgg._sum.durationSec ?? 0) / 3600) * 10) / 10

    // Listeners come from Icecast via the engine. When ingest is unreachable
    // they are reported as null rather than filled in from a curve: a stats
    // tile that always shows a number is worse than one that shows a dash.
    const engine = live?.engine ?? null
    const stream = live?.stream ?? null
    const listeners =
      engine?.listeners ?? { current: null, peak24h: null, source: 'unavailable' as const }
    const streamOk = stream?.onAir === true

    /**
     * Pending submissions are deliberately NOT a readiness item.
     *
     * An earlier draft counted them, which made the panel permanently red on any
     * station that was successfully receiving submissions — a working intake
     * queue reported as a fault. The queue is surfaced where it belongs, in the
     * review section; readiness describes whether the station can broadcast.
     */

    // 128kbps ~= 0.058 GB per listener-hour; 0.15 = avg daily listening factor.
    const projectedGBDay =
      listeners.current == null
        ? null
        : Math.round(0.058 * listeners.current * 24 * 0.15 * 10) / 10

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
      engine: engine
        ? {
            reachable: true,
            state: engine.state,
            crateSize: engine.autopilot.crateSize,
            autopilot: engine.autopilot.enabled,
            uptimeSec: engine.uptimeSec,
            lastError: engine.lastError,
          }
        : { reachable: false, state: 'unreachable', crateSize: 0, autopilot: false, uptimeSec: 0, lastError: 'DJ engine is not reachable' },
      stream: stream
        ? {
            reachable: stream.icecast.reachable,
            onAir: stream.onAir,
            encoder: stream.encoder,
            icecast: stream.icecast.version,
            mounts: stream.mounts,
          }
        : { reachable: false, onAir: false, encoder: 'none', icecast: null, mounts: [] },
      bandwidth: {
        kbps: 128,
        gbPerListenerHour: 0.058,
        projectedGBDay,
      },
      uptime: {
        // Real, from Icecast's own view of whether a source is connected.
        streamOk,
        icecastReachable: stream?.icecast.reachable ?? false,
        daysSinceLaunch: Math.max(0, Math.floor((nowMs - LAUNCH_UTC_MS) / DAY_MS)),
      },
      readiness,
    })
  } catch (error) {
    console.error('[api/stats]', error)
    return NextResponse.json({ error: 'Failed to load stats' }, { status: 500 })
  }
}
