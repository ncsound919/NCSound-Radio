import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { etOffsetMinutes } from '@/lib/broadcast'
import type {
  ElementKind,
  ListenBackEntry,
  ListenBackResponse,
} from '@/lib/station-types'

export const dynamic = 'force-dynamic'

const MAX_ENTRIES = 200
const MAX_WINDOW_DAYS = 21

/**
 * GET /api/shows/listenback?slug=…&date=YYYY-MM-DD
 * Rebuilds what actually aired during a past show window from the two
 * logs: PlayLog (music / station IDs / talk) + ad_plays (sold sponsor
 * spots). Windows are resolved in station time (America/New_York, DST-safe),
 * exactly like the scheduled-show takeover math.
 */
export async function GET(request: NextRequest) {
  try {
    const slug = (request.nextUrl.searchParams.get('slug') ?? '').trim().slice(0, 80)
    const date = (request.nextUrl.searchParams.get('date') ?? '').trim()
    if (!slug || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return NextResponse.json(
        { error: 'Missing or invalid parameters — need slug and date=YYYY-MM-DD' },
        { status: 400 },
      )
    }

    const show = await db.show.findUnique({ where: { slug } })
    if (!show) {
      return NextResponse.json({ error: 'Show not found' }, { status: 404 })
    }

    // Resolve the ET calendar date + show start into absolute UTC instants
    // (noon-UTC probe pins the right EST/EDT offset for that date).
    const [y, m, d] = date.split('-').map((p) => Number.parseInt(p, 10))
    if (!y || !m || !d || m < 1 || m > 12 || d < 1 || d > 31) {
      return NextResponse.json({ error: 'Invalid date' }, { status: 400 })
    }
    const probe = new Date(Date.UTC(y, m - 1, d, 12))
    const offsetMin = etOffsetMinutes(probe)
    const startMin = show.startHour * 60 + show.startMinute
    const windowStartMs = Date.UTC(y, m - 1, d) + startMin * 60_000 - offsetMin * 60_000
    const windowEndMs = windowStartMs + show.durationMin * 60_000

    const nowMs = Date.now()
    // Guard rails: no future windows, no archaeology beyond ~3 weeks
    // (the play log is the older bound — it only has what it has).
    if (windowStartMs > nowMs) {
      return NextResponse.json({ error: 'That occurrence has not aired yet' }, { status: 400 })
    }
    if (nowMs - windowEndMs > MAX_WINDOW_DAYS * 86_400_000) {
      return NextResponse.json(
        { error: `Listen back reaches ${MAX_WINDOW_DAYS} days into the log` },
        { status: 400 },
      )
    }
    const endCapMs = Math.min(windowEndMs, nowMs)

    const [plays, adPlays] = await Promise.all([
      db.playLog.findMany({
        where: { playedAt: { gte: new Date(windowStartMs), lt: new Date(endCapMs) } },
        orderBy: { playedAt: 'asc' },
        select: {
          playedAt: true,
          source: true,
          track: { select: { title: true, artist: true, playlist: true } },
        },
      }),
      db.adPlay.findMany({
        where: { playedAt: { gte: new Date(windowStartMs), lt: new Date(endCapMs) } },
        orderBy: { playedAt: 'asc' },
        select: {
          playedAt: true,
          campaign: { select: { name: true, sponsor: { select: { name: true } } } },
        },
      }),
    ])

    const entries: ListenBackEntry[] = []
    for (const p of plays) {
      const kind: ElementKind =
        p.track.playlist === 'Imaging' ? 'STATION_ID' : p.track.playlist === 'Talk' ? 'TALK' : 'MUSIC'
      entries.push({
        at: p.playedAt.toISOString(),
        kind,
        title: p.track.title,
        artist: p.track.artist,
        source: p.source,
      })
    }
    for (const a of adPlays) {
      entries.push({
        at: a.playedAt.toISOString(),
        kind: 'AD_SPOT',
        title: a.campaign.name,
        artist: a.campaign.sponsor.name,
        source: 'AD-LEDGER',
        campaignName: a.campaign.name,
      })
    }
    entries.sort((x, y) => x.at.localeCompare(y.at))

    const trimmed = entries.slice(0, MAX_ENTRIES)
    const body: ListenBackResponse = {
      show: {
        slug: show.slug,
        name: show.name,
        host: show.host,
        kind: show.kind === 'LIVE' ? 'LIVE' : 'PLAYLIST',
      },
      date,
      windowStart: new Date(windowStartMs).toISOString(),
      windowEnd: new Date(windowEndMs).toISOString(),
      entries: trimmed,
      counts: {
        music: trimmed.filter((e) => e.kind === 'MUSIC').length,
        ids: trimmed.filter((e) => e.kind === 'STATION_ID').length,
        talk: trimmed.filter((e) => e.kind === 'TALK').length,
        ads: trimmed.filter((e) => e.kind === 'AD_SPOT').length,
      },
      serverTime: new Date(nowMs).toISOString(),
    }
    return NextResponse.json(body)
  } catch (error) {
    console.error('[api/shows/listenback GET]', error)
    return NextResponse.json({ error: 'Failed to load the program log' }, { status: 500 })
  }
}
