import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { ingestStatus } from '@/lib/ingest'
import { etDayStartUTC, LAUNCH_UTC_MS } from '@/lib/broadcast'
import { currentAdmin } from '@/lib/admin-auth'

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
 * GET /api/stats — ops dashboard rollup: library counts,
 * submission pipeline, sponsor MRR, proof-of-play, listeners, bandwidth
 * projection and uptime.
 */
export async function GET(request: Request) {
  try {
    const nowMs = Date.now()

    /**
     * Public projection.
     *
     * The listener page's StatsStrip shows only live listener counts and the
     * crate size. The pipeline counts, sponsor MRR, proof-of-play totals and
     * the readiness internals are the owner's. Non-admins get only the four
     * public fields, computed directly, so the sensitive queries never run for
     * a listener.
     */
    if (!(await currentAdmin(request))) {
      const [tracks, durationAgg, live] = await Promise.all([
        db.track.count({ where: { playlist: { not: 'Imaging' } } }),
        db.track.aggregate({
          _sum: { durationSec: true },
          where: { playlist: { not: 'Imaging' } },
        }),
        ingestStatus(),
      ])
      const totalHours =
        Math.round(((durationAgg._sum.durationSec ?? 0) / 3600) * 10) / 10
      const listeners =
        live?.engine?.listeners ?? { current: null, peak24h: null, source: 'unavailable' as const }
      return NextResponse.json({ library: { tracks, totalHours }, listeners })
    }

    const [
      tracks,
      durationAgg,
      submissionGroups,
      activeSponsors,
      mrrAgg,
      adLast7Days,
      adToday,
      live,
    ] = await Promise.all([
      db.track.count({ where: { playlist: { not: 'Imaging' } } }),
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
    /**
     * The render pump, observed directly.
     *
     * `renderedAheadSec` saturates at both ends, so a fully stalled pump pins it
     * to -1 and reads as "slightly behind" rather than "producing nothing". This
     * is the signal that distinguishes the two.
     */
    /**
     * The upload into Liquidsoap.
     *
     * The link that had no field at all while it was broken. `connected` alone is
     * not enough — writing to a socket never fails when the peer is gone — so this
     * reports whether bytes are actually moving.
     */
    const harbor = live?.engine.harbor
    if (!harbor) {
      push('harbor', 'Uploading to Liquidsoap', 'unknown', 'publishing is disabled, so nothing is uploaded')
    } else {
      const moving = harbor.backlogBytes < 2 * 1024 * 1024
      push(
        'harbor',
        'Uploading to Liquidsoap',
        harbor.connected && moving ? 'ok' : 'problem',
        !harbor.connected
          ? `not connected${harbor.lastError ? `: ${harbor.lastError}` : ''}`
          : moving
            ? `${harbor.framesSent} frames sent, ${harbor.reconnects} reconnects`
            : `connected but nothing is reading: ${Math.round(harbor.backlogBytes / 1024)} KiB queued`,
      )
    }

    /**
     * Liquidsoap's own view of the engine's upload.
     *
     * Authoritative and free, unlike measuring the mount: `input.harbor`'s
     * connect/disconnect callbacks publish it, so ingest reads a fact rather than
     * inferring one. The client's own `connected` flag cannot answer this — after a
     * daemon restart it read `true` while the mount was silent.
     */
    const harborSource = live?.harborSource
    if (!harborSource) {
      push(
        'harbor-source',
        'Liquidsoap has the engine as a source',
        'unknown',
        'this Liquidsoap build reports no source state',
      )
    } else {
      push(
        'harbor-source',
        'Liquidsoap has the engine as a source',
        harborSource.onAir ? 'ok' : harborSource.onAir === null ? 'unknown' : 'problem',
        harborSource.onAir
          ? 'harbor reports a connected source'
          : harborSource.onAir === null
            ? (harborSource.error ?? 'could not be determined')
            : 'harbor reports no connected source, so nothing the engine renders can reach the mount',
      )
    }

    const stallMs = live?.engine.telemetry?.renderStallMs
    if (stallMs == null) {
      push('pump', 'Engine is producing audio', 'unknown', 'the engine reported no stall telemetry')
    } else {
      push(
        'pump',
        'Engine is producing audio',
        stallMs > 5000 ? 'problem' : 'ok',
        stallMs > 5000
          ? `the render tap has produced nothing for ${(stallMs / 1000).toFixed(1)}s`
          : `rendering; last block ${stallMs}ms ago`,
      )
    }

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
