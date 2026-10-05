/**
 * NCSound Radio "NCSound Radio" — backend broadcast-engine helpers.
 * ---------------------------------------------------------------
 * Simulated AutoDJ implementing the station's PROGRAM CLOCK: the "what's on
 * air right now" decision is a pure, deterministic function of the wall clock
 * over an element wheel (music blocks → station IDs → ad breaks). Every
 * poller sees the same element for the same second, and PlayLog rows
 * accumulate as the API is polled.
 *
 * Programming rules enforced here:
 *  - Rights gate: only library tracks ever reach the wheel; the request line
 *    refuses anything without a CLEARED rights record.
 *  - Clean Daypart 06:00–19:00 ET: explicit tracks are held out of rotation.
 *  - Fallback tracks sit on the bench and only join the wheel when a listener
 *    shout pulls them in (request weight > 0) — zero dead air insurance.
 *  - Ad breaks carry sold sponsor creatives (matched to the nightly-sync
 *    ledger formula) or house promos for unsold inventory.
 *
 * Also hosts small shared helpers used by the API routes:
 * America/New_York wall-clock math, listener simulation and
 * Prisma-row -> DTO mappers (backend-only; the frontend imports the
 * DTO types from station-types.ts).
 */

import { db } from '@/lib/db'
import type {
  AdPlay,
  Campaign,
  PlayLog,
  RightsLog,
  Show,
  Sponsor,
  Submission,
  Track,
} from '@prisma/client'
import type {
  AdPlayDTO,
  CampaignDTO,
  RightsDTO,
  ShowDTO,
  SponsorDTO,
  SubmissionDTO,
  TrackDTO,
} from '@/lib/station-types'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const STATION_TIMEZONE = 'America/New_York'

/** Epoch anchor for the rotation clock: 2025-01-01T00:00:00Z. */
const ROTATION_ANCHOR_MS = Date.UTC(2025, 0, 1)
/** Silence gap inserted after every element in the cycle. */
const TRACK_GAP_SEC = 12
/** Songs per music block before an imaging ID or ad break. */
const BLOCK_SIZE = 3
/**
 * Program-clock cadence after each music block (round-robin):
 *   block 0 → station ID · block 1 → ad break (2 spots) · block 2 → talk/spotlight.
 * Mirrors the hourly clock: Music → Station ID → Talk → Music → Ad break.
 */
const BREAK_PATTERN: Array<'STATION_ID' | 'AD_BREAK' | 'TALK'> = [
  'STATION_ID',
  'AD_BREAK',
  'TALK',
]
/** Duration of a single ad spot (two spots per break). */
const AD_SPOT_SEC = 30
/** Rotation wheel cache TTL (nowplaying is polled every ~10s). */
const ROTATION_CACHE_TTL_MS = 60_000
/** Listener-simulation bucket: fresh deterministic noise every 15s. */
/** Station launch date for uptime math: 2025-10-01. */
export const LAUNCH_UTC_MS = Date.UTC(2025, 9, 1)

export const DAY_MS = 24 * 3600 * 1000

// ---------------------------------------------------------------------------
// AutoDJ rotation engine — program clock
// ---------------------------------------------------------------------------

export type ElementKind = 'MUSIC' | 'STATION_ID' | 'AD_SPOT' | 'TALK'

export type AdCampaignInfo = {
  id: string
  name: string
  sponsorName: string
  creativeName: string
  spotsPerDay: number
  startAtMs: number
}

export type RotationElement = {
  kind: ElementKind
  track: Track | null
  campaign: AdCampaignInfo | null
  durSec: number
}

type WheelCache = {
  elements: RotationElement[]
  cycleSec: number
  fetchedAt: number
}

/** Show-table cache (the live-show takeover polls this every 10s). */
type ShowCache = { shows: Show[]; fetchedAt: number }

const globalForRotation = globalThis as unknown as {
  ncsoundRotationCache: WheelCache | undefined
  ncsoundShowCache: ShowCache | undefined
}

/**
 * House-promo creative pool — unsold ad-break inventory rotates through these
 * instead of airing a single canned spot (deterministic pick per slot).
 *
 * Every line here is copy the operator has to be willing to broadcast. The
 * studio-line promo previously quoted "(910) 555-0191", a fictional US
 * exchange number, which meant a station could put a dead phone number on the
 * air in an ad break. Unsold inventory is still inventory — it should say
 * something true, or say nothing.
 */
export const HOUSE_PROMOS: Array<{ title: string; line: string }> = [
  { title: 'House promo — submit your track', line: 'Artists: send your music through the rights gate on this site.' },
  { title: 'House promo — listener requests open', line: 'Request a track from the request line while you listen.' },
  { title: 'House promo — sponsor this daypart', line: 'Daypart sponsorship available — enquire on the station site.' },
]

/** Deterministic house-promo variant for a slot instant. */
export function housePromoForSlot(slotMs: number): { title: string; line: string } {
  const bucket = Math.floor(slotMs / 600_000) // rotates every 10 minutes of airtime
  return HOUSE_PROMOS[stringHash(`house-${bucket}`) % HOUSE_PROMOS.length]
}

/**
 * Listener-request weights (last 7 days): trackId -> request count.
 * Feeds both the request-weighted rotation and the "heat" readouts.
 */
export async function getRequestWeights(nowMs: number = Date.now()): Promise<Map<string, number>> {
  const since = new Date(nowMs - 7 * 86_400_000)
  const groups = await db.trackRequest.groupBy({
    by: ['trackId'],
    where: { createdAt: { gte: since } },
    _count: { trackId: true },
  })
  return new Map(groups.map((g) => [g.trackId, g._count.trackId]))
}

/**
 * Absolute AD_SPOT instants (ms) whose element slot starts inside [fromMs, toMs].
 * Derived from the same anchor/cycle math as computeOnAir, so an instant here
 * IS the broadcast time of that spot.
 */
export function adBreakSpotInstants(
  elements: RotationElement[],
  cycleSec: number,
  fromMs: number,
  toMs: number,
): Array<{ atMs: number; elementIndex: number }> {
  if (elements.length === 0 || cycleSec <= 0) return []
  const offsets: number[] = []
  let acc = 0
  for (const e of elements) {
    offsets.push(acc)
    acc += (e.durSec + TRACK_GAP_SEC) * 1000
  }
  const cycleMs = cycleSec * 1000
  const firstCycle = Math.floor((fromMs - ROTATION_ANCHOR_MS) / cycleMs)
  const lastCycle = Math.floor((toMs - ROTATION_ANCHOR_MS) / cycleMs)
  const out: Array<{ atMs: number; elementIndex: number }> = []
  for (let c = firstCycle; c <= lastCycle; c++) {
    for (let i = 0; i < elements.length; i++) {
      if (elements[i].kind !== 'AD_SPOT') continue
      const atMs = ROTATION_ANCHOR_MS + c * cycleMs + offsets[i]
      if (atMs >= fromMs && atMs <= toMs) out.push({ atMs, elementIndex: i })
    }
  }
  return out.sort((a, b) => a.atMs - b.atMs)
}

/**
 * Sold/house allocation for one ET day of ad-break spots, in time order.
 *
 * Sold spots are spread evenly across the whole day (Bresenham on the spot
 * index — never bunched into the small hours) and assigned round-robin to
 * campaigns while each campaign's spotsPerDay budget lasts; everything else
 * airs as a house promo (unsold inventory, never ledgered).
 *
 * This is THE shared schedule: the on-air clock picks the creative it airs
 * from it, and the nightly ad-sync ledger pull writes exactly its sold rows.
 */
export function adSpotScheduleForDay(
  dayStartMs: number,
  elements: RotationElement[],
  cycleSec: number,
  campaigns: AdCampaignInfo[],
): Array<{ atMs: number; campaign: AdCampaignInfo | null }> {
  const instants = adBreakSpotInstants(elements, cycleSec, dayStartMs, dayStartMs + DAY_MS)
  const M = instants.length
  if (M === 0) return []
  const budgets = campaigns.map((c) => Math.max(0, c.spotsPerDay))
  const totalSold = Math.min(M, budgets.reduce((a, b) => a + b, 0))
  const remaining = [...budgets]
  const out: Array<{ atMs: number; campaign: AdCampaignInfo | null }> = []
  let s = 0
  for (let k = 0; k < M; k++) {
    let campaign: AdCampaignInfo | null = null
    if (
      s < totalSold &&
      Math.floor(((k + 1) * totalSold) / M) > Math.floor((k * totalSold) / M)
    ) {
      for (let attempt = 0; attempt < campaigns.length; attempt++) {
        const j = (s + attempt) % campaigns.length
        if (remaining[j] > 0) {
          const candidate = campaigns[j]
          remaining[j]--
          s++
          // Spots before the campaign's flight start stay unsold (house).
          if (candidate.startAtMs <= instants[k].atMs) campaign = candidate
          break
        }
      }
    }
    out.push({ atMs: instants[k].atMs, campaign })
  }
  return out
}

/** Find the schedule entry for an absolute spot start (± half a slot gap). */
export function campaignForAdSlot(
  slotStartMs: number,
  schedule: Array<{ atMs: number; campaign: AdCampaignInfo | null }>,
): AdCampaignInfo | null {
  const TOL_MS = (TRACK_GAP_SEC * 1000) / 2
  for (const s of schedule) {
    if (Math.abs(s.atMs - slotStartMs) <= TOL_MS) return s.campaign
  }
  return null
}

/** Clean Daypart window: 06:00–18:59 ET (explicit lyrics held). */
export function isCleanDaypart(nowMs: number = Date.now()): boolean {
  const wc = etWallClock(new Date(nowMs))
  return wc.hour >= 6 && wc.hour < 19
}

/**
 * Build the program-clock wheel. Cached 60s so every poller sees the same
 * element order within a window; listener shouts re-sort the front of the
 * music blocks on the next refresh.
 */
export async function getRotationWheel(nowMs: number = Date.now()): Promise<{
  elements: RotationElement[]
  cycleSec: number
}> {
  const cached = globalForRotation.ncsoundRotationCache
  if (
    cached &&
    Array.isArray(cached.elements) &&
    cached.elements.length > 0 &&
    typeof cached.cycleSec === 'number' &&
    Date.now() - cached.fetchedAt < ROTATION_CACHE_TTL_MS
  ) {
    return cached
  }

  const clean = isCleanDaypart(nowMs)

  const [rows, weights, imagingRows, talkRows, campaignRows] = await Promise.all([
    db.track.findMany({ orderBy: { seedOrder: 'asc' } }),
    getRequestWeights(nowMs),
    db.track.findMany({ where: { playlist: 'Imaging' }, orderBy: { seedOrder: 'asc' } }),
    db.track.findMany({ where: { playlist: 'Talk' }, orderBy: { seedOrder: 'asc' } }),
    db.campaign.findMany({
      where: { active: true, startAt: { lte: new Date(nowMs) } },
      include: { sponsor: true },
      orderBy: { id: 'asc' },
    }),
  ])

  const campaigns: AdCampaignInfo[] = campaignRows.map((c) => ({
    id: c.id,
    name: c.name,
    sponsorName: c.sponsor.name,
    creativeName: c.creativeName,
    spotsPerDay: c.spotsPerDay,
    startAtMs: c.startAt.getTime(),
  }))

  // Music pool: everything except Imaging and Talk; Fallback tracks wait on
  // the bench unless a listener shout pulls them in. Daypart filter on top.
  let pool = rows.filter(
    (t) =>
      t.playlist !== 'Imaging' &&
      t.playlist !== 'Talk' &&
      (t.playlist !== 'Fallback' || (weights.get(t.id) ?? 0) > 0),
  )
  if (pool.length === 0) pool = rows.filter((t) => t.playlist !== 'Imaging' && t.playlist !== 'Talk')
  if (clean) {
    const cleanPool = pool.filter((t) => !t.explicit)
    if (cleanPool.length > 0) pool = cleanPool
  }

  // Request-weighted ordering: top-3 hottest lead the wheel, the rest hold
  // seed order (stable — equal weights never reshuffle).
  const promoted = pool
    .filter((t) => (weights.get(t.id) ?? 0) > 0)
    .sort(
      (a, b) => (weights.get(b.id) ?? 0) - (weights.get(a.id) ?? 0) || a.seedOrder - b.seedOrder,
    )
    .slice(0, 3)
  const promotedIds = new Set(promoted.map((t) => t.id))
  const music = [...promoted, ...pool.filter((t) => !promotedIds.has(t.id))]

  if (music.length === 0) {
    throw new Error('Rotation library is empty')
  }

  const elements: RotationElement[] = []
  let blockIndex = 0
  for (let m = 0; m < music.length; m += BLOCK_SIZE) {
    for (let k = m; k < Math.min(m + BLOCK_SIZE, music.length); k++) {
      elements.push({
        kind: 'MUSIC',
        track: music[k],
        campaign: null,
        durSec: music[k].durationSec,
      })
    }
    // Program clock: station ID → ad break → talk/spotlight, round-robin.
    const breakKind = BREAK_PATTERN[blockIndex % BREAK_PATTERN.length]
    if (breakKind === 'AD_BREAK') {
      for (let spot = 0; spot < 2; spot++) {
        elements.push({ kind: 'AD_SPOT', track: null, campaign: null, durSec: AD_SPOT_SEC })
      }
    } else if (breakKind === 'TALK' && talkRows.length > 0) {
      const talkTrack = talkRows[Math.floor(blockIndex / BREAK_PATTERN.length) % talkRows.length]
      elements.push({
        kind: 'TALK',
        track: talkTrack,
        campaign: null,
        durSec: talkTrack.durationSec,
      })
    } else if (imagingRows.length > 0) {
      const idTrack = imagingRows[blockIndex % imagingRows.length]
      elements.push({
        kind: 'STATION_ID',
        track: idTrack,
        campaign: null,
        durSec: idTrack.durationSec,
      })
    }
    blockIndex++
  }

  const cycleSec = elements.reduce((acc, e) => acc + e.durSec + TRACK_GAP_SEC, 0)

  globalForRotation.ncsoundRotationCache = { elements, cycleSec, fetchedAt: Date.now() }
  return { elements, cycleSec }
}

export type OnAir = {
  element: RotationElement
  /** Absolute slot start instant — used as the PlayLog playedAt (music/ID). */
  startedAt: Date
  /** Seconds elapsed inside the element window (floored). */
  elapsed: number
  /** Element duration in seconds. */
  duration: number
  /** Seconds remaining in the element window. */
  remaining: number
  /** 0..1 playback progress. */
  progress: number
  /** Index of the element inside the wheel. */
  index: number
}

/**
 * Deterministic "what's on air now" from the wall clock over the element
 * wheel. Each element occupies `durSec + 12s gap` inside one repeating
 * cycle. If the clock sits in the inter-element gap we clamp elapsed to the
 * full duration (progress 1) — the UI reads that as "cueing up next".
 */
export function computeOnAir(
  elements: RotationElement[],
  cycleSec: number,
  nowMs: number = Date.now(),
): OnAir {
  if (elements.length === 0 || cycleSec <= 0) {
    throw new Error('Rotation wheel is empty')
  }
  const cycleMs = cycleSec * 1000
  const position = (((nowMs - ROTATION_ANCHOR_MS) % cycleMs) + cycleMs) % cycleMs
  // Start of the CURRENT cycle in absolute time — the wall-clock instant the
  // wheel last wrapped. Slot starts are true broadcast instants (this is what
  // PlayLog/ad_plays key on and what the ad schedule must match exactly).
  const cycleStartMs = nowMs - position

  let slotStart = 0
  for (let i = 0; i < elements.length; i++) {
    const element = elements[i]
    const slotLenMs = (element.durSec + TRACK_GAP_SEC) * 1000
    if (position < slotStart + slotLenMs) {
      const elapsedRaw = Math.max(0, (position - slotStart) / 1000)
      const elapsed = Math.min(Math.floor(elapsedRaw), element.durSec)
      return {
        element,
        startedAt: new Date(cycleStartMs + slotStart),
        elapsed,
        duration: element.durSec,
        remaining: Math.max(0, element.durSec - elapsed),
        progress: element.durSec > 0 ? Math.min(1, elapsedRaw / element.durSec) : 0,
        index: i,
      }
    }
    slotStart += slotLenMs
  }

  // Unreachable (modulo guarantees a slot hit) — safe fallback.
  const last = elements[elements.length - 1]
  return {
    element: last,
    startedAt: new Date(cycleStartMs),
    elapsed: 0,
    duration: last.durSec,
    remaining: last.durSec,
    progress: 0,
    index: elements.length - 1,
  }
}

/** Next `count` elements in the wheel, wrapping around. */
export function getUpNextElements(
  elements: RotationElement[],
  index: number,
  count = 3,
): RotationElement[] {
  if (elements.length === 0) return []
  const out: RotationElement[] = []
  for (let k = 1; k <= count; k++) {
    out.push(elements[(index + k) % elements.length])
  }
  return out
}

// ---------------------------------------------------------------------------
// Scheduled-show takeover (live programming)
// ---------------------------------------------------------------------------

/** Cached 30s: one Show-table read per ~3 nowplaying polls. */
export async function getActiveShow(nowMs: number = Date.now()): Promise<Show | null> {
  const cached = globalForRotation.ncsoundShowCache
  let shows: Show[]
  if (cached && Array.isArray(cached.shows) && Date.now() - cached.fetchedAt < 30_000) {
    shows = cached.shows
  } else {
    shows = await db.show.findMany({
      orderBy: [
        { dayOfWeek: 'asc' },
        { startHour: 'asc' },
        { startMinute: 'asc' },
      ],
    })
    globalForRotation.ncsoundShowCache = { shows, fetchedAt: Date.now() }
  }

  const wc = etWallClock(new Date(nowMs))
  return (
    shows.find((s) => {
      if (!s.active || s.dayOfWeek !== wc.dayOfWeek) return false
      const startMin = s.startHour * 60 + s.startMinute
      return wc.minuteOfDay >= startMin && wc.minuteOfDay < startMin + s.durationMin
    }) ?? null
  )
}

// ---------------------------------------------------------------------------
// Listener simulation (deterministic, "breathes" with the day)
// ---------------------------------------------------------------------------

/** 32-bit integer hash (murmur-style finalizer) — deterministic. */
function hash32(input: number): number {
  let x = Math.imul(input ^ 0x9e3779b9, 0x85ebca6b)
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35)
  x ^= x >>> 16
  return x >>> 0
}

/** Deterministic string hash (djb2 with 32-bit wrapping). */
export function stringHash(input: string): number {
  let h = 5381
  for (let i = 0; i < input.length; i++) {
    h = (Math.imul(h, 33) ^ input.charCodeAt(i)) >>> 0
  }
  return h >>> 0
}

// ---------------------------------------------------------------------------
// PlayLog accumulation
// ---------------------------------------------------------------------------

/**
 * Insert the current track slot into song history. Safe to call on every
 * poll: unique(trackId, playedAt) + swallowed P2002 makes it idempotent.
 */
export async function maybeLogPlays(
  trackId: string,
  startedAt: Date,
  source = 'AUTODJ',
): Promise<void> {
  try {
    await db.playLog.create({
      data: { trackId, playedAt: startedAt, source },
    })
  } catch {
    // P2002 unique-violation — this slot is already logged; ignore.
  }
}

/**
 * Proof-of-play: log a SOLD sponsor spot at its broadcast instant. Safe on
 * every poll — unique(campaignId, playedAt) + swallowed P2002. The nightly
 * ad-sync backfills any slots missed while nobody was polling.
 */
export async function maybeLogAdPlay(
  campaignId: string,
  playedAt: Date,
  source = 'AUTODJ',
): Promise<void> {
  try {
    await db.adPlay.create({
      data: { campaignId, playedAt, source },
    })
  } catch {
    // P2002 — this spot is already ledgered; ignore.
  }
}

// ---------------------------------------------------------------------------
// America/New_York wall-clock helpers
// ---------------------------------------------------------------------------

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
}

export type EtWallClock = {
  year: number
  month: number // 1-12
  day: number // 1-31
  dayOfWeek: number // 0=Sun..6=Sat
  hour: number // 0-23
  minute: number
  minuteOfDay: number
  weekdayShort: string
}

/** Wall-clock fields for the station timezone via Intl (DST-safe). */
export function etWallClock(date: Date = new Date()): EtWallClock {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: STATION_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  })
  const parts: Record<string, string> = {}
  for (const p of fmt.formatToParts(date)) parts[p.type] = p.value
  const hour = Number.parseInt(parts.hour ?? '0', 10) % 24
  const minute = Number.parseInt(parts.minute ?? '0', 10)
  return {
    year: Number.parseInt(parts.year ?? '1970', 10),
    month: Number.parseInt(parts.month ?? '1', 10),
    day: Number.parseInt(parts.day ?? '1', 10),
    dayOfWeek: WEEKDAY_INDEX[parts.weekday ?? 'Sun'] ?? 0,
    hour,
    minute,
    minuteOfDay: hour * 60 + minute,
    weekdayShort: parts.weekday ?? 'Sun',
  }
}

/** UTC offset (minutes, e.g. -300 EST / -240 EDT) for the station timezone. */
export function etOffsetMinutes(date: Date = new Date()): number {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: STATION_TIMEZONE,
    timeZoneName: 'longOffset',
  })
  const name =
    fmt.formatToParts(date).find((p) => p.type === 'timeZoneName')?.value ??
    'GMT-05:00'
  const m = /GMT([+-])(\d{1,2})(?::(\d{2}))?/.exec(name)
  if (!m) return -300
  const sign = m[1] === '-' ? -1 : 1
  return sign * (Number.parseInt(m[2], 10) * 60 + (m[3] ? Number.parseInt(m[3], 10) : 0))
}

/**
 * The UTC instant corresponding to "local midnight today" in the station
 * timezone (handles EST/EDT). Used for playsToday-style counters and the
 * day-anchored sold-ad-slot schedule.
 */
export function etDayStartUTC(date: Date = new Date()): Date {
  const wc = etWallClock(date)
  return new Date(Date.UTC(wc.year, wc.month - 1, wc.day) - etOffsetMinutes(date) * 60_000)
}

// ---------------------------------------------------------------------------
// Prisma-row -> DTO mappers (shared by the API routes)
// ---------------------------------------------------------------------------

export function toTrackDTO(t: Track): TrackDTO {
  return {
    id: t.id,
    title: t.title,
    artist: t.artist,
    album: t.album,
    durationSec: t.durationSec,
    rightsId: t.rightsId,
    explicit: t.explicit,
    playlist: t.playlist,
    bpm: t.bpm,
  }
}

export function toShowDTO(s: Show): ShowDTO {
  return {
    id: s.id,
    name: s.name,
    slug: s.slug,
    description: s.description,
    host: s.host,
    dayOfWeek: s.dayOfWeek,
    startHour: s.startHour,
    startMinute: s.startMinute,
    durationMin: s.durationMin,
    explicit: s.explicit,
    kind: s.kind === 'LIVE' ? 'LIVE' : 'PLAYLIST',
    accent: s.accent,
    active: s.active,
  }
}

export function toSubmissionDTO(s: Submission): SubmissionDTO {
  return {
    id: s.id,
    artistName: s.artistName,
    email: s.email,
    trackTitle: s.trackTitle,
    genre: s.genre,
    explicit: s.explicit,
    city: s.city,
    state: s.state,
    socials: s.socials,
    fileName: s.fileName,
    fileSize: s.fileSize,
    notes: s.notes,
    status: s.status as SubmissionDTO['status'],
    agreementVersion: s.agreementVersion,
    agreementAcceptedAt: s.agreementAcceptedAt?.toISOString() ?? null,
    agreementIp: s.agreementIp,
    reviewNotes: s.reviewNotes,
    reviewedAt: s.reviewedAt?.toISOString() ?? null,
    rightsId: s.rightsId,
    createdAt: s.createdAt.toISOString(),
  }
}

export function toRightsDTO(r: RightsLog): RightsDTO {
  return {
    id: r.id,
    trackTitle: r.trackTitle,
    artistName: r.artistName,
    owner: r.owner,
    sampleStatus: r.sampleStatus as RightsDTO['sampleStatus'],
    explicitFlag: r.explicitFlag,
    status: r.status as RightsDTO['status'],
    source: r.source as RightsDTO['source'],
    ownerProof: r.ownerProof,
    clearedAt: r.clearedAt?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString(),
  }
}

export function toCampaignDTO(
  c: Campaign,
  playsTotal: number,
  playsToday: number,
): CampaignDTO {
  return {
    id: c.id,
    name: c.name,
    spotsPerDay: c.spotsPerDay,
    creativeName: c.creativeName,
    startAt: c.startAt.toISOString(),
    endAt: c.endAt?.toISOString() ?? null,
    active: c.active,
    playsTotal,
    playsToday,
  }
}

export function toAdPlayDTO(
  p: PlayLogLike & { campaign: Campaign & { sponsor: Sponsor } },
): AdPlayDTO {
  return {
    id: p.id,
    campaignId: p.campaignId,
    campaignName: p.campaign.name,
    sponsorName: p.campaign.sponsor.name,
    playedAt: p.playedAt.toISOString(),
    source: p.source,
  }
}

// AdPlay structurally matches this shape; alias keeps the mapper readable.
type PlayLogLike = AdPlay

export function toSponsorDTO(
  s: Sponsor & { campaigns: Campaign[] },
  playsTotalByCampaign: Map<string, number>,
  playsTodayByCampaign: Map<string, number>,
): SponsorDTO {
  return {
    id: s.id,
    name: s.name,
    contact: s.contact,
    tier: s.tier as SponsorDTO['tier'],
    monthlyRate: s.monthlyRate,
    status: s.status as SponsorDTO['status'],
    startAt: s.startAt.toISOString(),
    endAt: s.endAt?.toISOString() ?? null,
    campaigns: s.campaigns.map((c) =>
      toCampaignDTO(
        c,
        playsTotalByCampaign.get(c.id) ?? 0,
        playsTodayByCampaign.get(c.id) ?? 0,
      ),
    ),
  }
}

/** Map a PlayLog row (with track) to the HistoryResponse entry shape. */
export function toHistoryEntry(p: PlayLog & { track: Track }): {
  id: string
  playedAt: string
  source: string
  track: TrackDTO
} {
  return {
    id: p.id,
    playedAt: p.playedAt.toISOString(),
    source: p.source,
    track: toTrackDTO(p.track),
  }
}
