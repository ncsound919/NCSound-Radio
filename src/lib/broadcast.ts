/**
 * WAVC 91.3 "Carolina Waves" — backend broadcast-engine helpers.
 * ---------------------------------------------------------------
 * Simulated AutoDJ: the "what's on air right now" decision is a pure,
 * deterministic function of the wall clock over the Track library
 * (ordered by seedOrder, skipping the Imaging playlist). Every poller
 * sees the same track for the same second, and PlayLog rows accumulate
 * as the API is polled.
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
/** Silence gap inserted after every track in the rotation cycle. */
const TRACK_GAP_SEC = 12
/** Rotation library cache TTL (nowplaying is polled every ~10s). */
const ROTATION_CACHE_TTL_MS = 60_000
/** Listener-simulation bucket: fresh deterministic noise every 15s. */
const LISTENER_BUCKET_MS = 15_000
/** Station launch date for uptime math: 2025-10-01. */
export const LAUNCH_UTC_MS = Date.UTC(2025, 9, 1)

// ---------------------------------------------------------------------------
// AutoDJ rotation engine
// ---------------------------------------------------------------------------

type RotationCache = { tracks: Track[]; fetchedAt: number }

const globalForRotation = globalThis as unknown as {
  wavcRotationCache: RotationCache | undefined
}

/** Rotation library (everything except Imaging), cached for 60s. */
export async function getRotationTracks(): Promise<Track[]> {
  const now = Date.now()
  const cached = globalForRotation.wavcRotationCache
  if (cached && now - cached.fetchedAt < ROTATION_CACHE_TTL_MS) {
    return cached.tracks
  }
  const tracks = await db.track.findMany({
    where: { playlist: { not: 'Imaging' } },
    orderBy: { seedOrder: 'asc' },
  })
  globalForRotation.wavcRotationCache = { tracks, fetchedAt: now }
  return tracks
}

export type OnAir = {
  track: Track
  /** Index of the current track inside the rotation array. */
  index: number
  /** Slot start instant (ISO-able Date) — used as the PlayLog playedAt. */
  startedAt: Date
  /** Seconds elapsed inside the track window (floored). */
  elapsed: number
  /** Track duration in seconds. */
  duration: number
  /** Seconds remaining in the track window. */
  remaining: number
  /** 0..1 playback progress. */
  progress: number
}

/**
 * Deterministic "what's on air now" from the wall clock.
 * Each track occupies `durationSec + 12s gap` inside one repeating cycle.
 * Position = (now - anchor) mod cycleTotal. If the clock currently sits in
 * the inter-track gap we clamp elapsed to the full duration (progress 1).
 */
export function computeOnAir(tracks: Track[], nowMs: number = Date.now()): OnAir {
  if (tracks.length === 0) {
    throw new Error('Rotation library is empty')
  }
  const cycleMs = tracks.reduce(
    (acc, t) => acc + (t.durationSec + TRACK_GAP_SEC) * 1000,
    0,
  )
  const position =
    (((nowMs - ROTATION_ANCHOR_MS) % cycleMs) + cycleMs) % cycleMs

  let slotStart = 0
  for (let i = 0; i < tracks.length; i++) {
    const track = tracks[i]
    const slotLenMs = (track.durationSec + TRACK_GAP_SEC) * 1000
    if (position < slotStart + slotLenMs) {
      const elapsedRaw = Math.max(0, (position - slotStart) / 1000)
      const elapsed = Math.min(Math.floor(elapsedRaw), track.durationSec)
      return {
        track,
        index: i,
        startedAt: new Date(ROTATION_ANCHOR_MS + slotStart),
        elapsed,
        duration: track.durationSec,
        remaining: Math.max(0, track.durationSec - elapsed),
        progress:
          track.durationSec > 0
            ? Math.min(1, elapsedRaw / track.durationSec)
            : 0,
      }
    }
    slotStart += slotLenMs
  }

  // Unreachable (modulo guarantees a slot hit) — safe fallback.
  const last = tracks[tracks.length - 1]
  return {
    track: last,
    index: tracks.length - 1,
    startedAt: new Date(ROTATION_ANCHOR_MS),
    elapsed: 0,
    duration: last.durationSec,
    remaining: last.durationSec,
    progress: 0,
  }
}

/** Next `count` tracks in the rotation, wrapping around the array. */
export function getUpNext(tracks: Track[], index: number, count = 3): Track[] {
  if (tracks.length === 0) return []
  const out: Track[] = []
  for (let k = 1; k <= count; k++) {
    out.push(tracks[(index + k) % tracks.length])
  }
  return out
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

/**
 * Simulated listeners: circadian curve over the ET day (evening peak)
 * plus deterministic noise that changes every 15 seconds. Never < 3.
 */
export function computeListeners(nowMs: number = Date.now()): {
  current: number
  peak24h: number
} {
  const wc = etWallClock(new Date(nowMs))
  const hoursIntoDay = wc.minuteOfDay / 60
  // Peak around 20:00 ET (sin argument = pi/2 when hoursIntoDay - 14 = 6).
  const circadian = 26 * Math.sin((2 * Math.PI * (hoursIntoDay - 14)) / 24)
  const bucket = Math.floor(nowMs / LISTENER_BUCKET_MS)
  const noise = ((hash32(bucket) % 1000) / 1000 - 0.5) * 12
  const current = Math.max(3, Math.round(38 + circadian + noise))
  const peak24h = Math.round(current * 2) + 44
  return { current, peak24h }
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
 * timezone (handles EST/EDT). Used for playsToday-style counters.
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
