/**
 * NCSound Radio "NCSound Radio" — station-web HTTP view models.
 * ---------------------------------------------------------
 * The cross-process domain contract (tracks, elements, on-air snapshots,
 * engine status, stream status, control commands) lives in @ncsound/station-core
 * and is re-exported here so existing `@/lib/station-types` imports keep
 * working. This file owns only the shapes that are specific to this site's
 * API surface and its database.
 */

import type {
  Daypart,
  ElementKind,
  LiveShowInfo,
  ListenerCounts,
  QueueEntry,
  StationIdentity,
  StreamEncoder,
  TrackDTO,
  WheelSlice,
} from "@ncsound/station-core";

export type {
  Daypart,
  ElementKind,
  LiveShowInfo,
  ListenerCounts,
  NowPlayingElement,
  QueueEntry,
  StationIdentity,
  StreamEncoder,
  StreamMount,
  StreamStatus,
  TrackDTO,
  WheelSlice,
} from "@ncsound/station-core";

/**
 * Live broadcast view of the station.
 *
 * `current` is nullable because the engine can be reachable and still have
 * nothing loaded (standby), and can be entirely absent (offline). Every
 * consumer must handle null: an earlier version of this file declared it
 * non-null, so `data?.current.track` typechecked and then threw at runtime.
 *
 * `listeners.current` is nullable too. When the engine is unreachable the count
 * is unknown, and unknown must render as a dash rather than 0.
 */
export type NowPlayingResponse = {
  station: StationIdentity & { bitrateKbps: number }
  current: {
    track: TrackDTO;
    startedAt: string;
    elapsed: number;
    duration: number;
    remaining: number;
    progress: number;
  } | null;
  element: import("@ncsound/station-core").NowPlayingElement;
  daypart: Daypart;
  /** Always null until a scheduled show is actually taken into account. */
  liveShow: LiveShowInfo | null;
  next: QueueEntry[];
  heat: Record<string, number>;
  requestedBy: Record<string, string[]>;
  /** Program-clock slices. A single MUSIC slice while autopilot is running. */
  wheel: WheelSlice[];
  cycleIndex: number;
  cycleSec: number;
  listeners: { current: number | null; peak24h: number | null; source: string };
  /** Headless engine state, as reported by the ingest service. */
  engine: {
    state: string;
    crateSize: number;
    autopilot: boolean;
    uptimeSec: number;
    lastError: string | null;
  };
  /** Icecast mount state, or null when the engine has not polled yet. */
  stream: {
    onAir: boolean;
    encoder: string;
    icecast: string | null;
    mounts: Array<{
      mount: string;
      bitrateKbps: number;
      listeners: number;
      peakListeners24h: number;
      lastMetadata: string | null;
    }>;
  } | null;
  /**
   * live      - engine playing and Icecast has the stream
   * standby   - engine reachable, nothing loaded yet
   * offline   - engine not reachable; arrives with HTTP 503
   */
  mode: "live" | "standby" | "offline";
  /** Real public mount URL, or null when nothing is encoded. */
  streamUrl: string | null;
  /** Present on the 503 response so the UI can say why. */
  offlineReason?: string;
  serverTime: string;
};

/** The 503 body, returned when the DJ engine cannot be reached. */
export type NowPlayingOfflineResponse = {
  station: StationIdentity & { bitrateKbps: number };
  current: null;
  next: [];
  heat: Record<string, number>;
  requestedBy: Record<string, string[]>;
  wheel: [];
  cycleIndex: 0;
  cycleSec: 0;
  listeners: { current: null; peak24h: null };
  mode: "offline";
  offlineReason: string;
  streamUrl: null;
  serverTime: string;
};

export type ListenerPoint = { t: string; v: number }

/**
 * Real Icecast samples. The series only covers the life of the ingest process,
 * so `partial` is true unless a full 24 hours has been recorded. Render a short
 * series as short; do not stretch two points across a "last 24h" axis.
 */
export type ListenersHistoryResponse = {
  points: ListenerPoint[]
  current: number | null
  peak24h: number | null
  partial: boolean
  /** When recording began. Null when nothing has been sampled yet. */
  recordedSince: string | null
  /** Set on the 503 response. */
  reason?: string
  timezone: string
  serverTime: string
}

export type HistoryResponse = {
  plays: Array<{ id: string; playedAt: string; source: string; track: TrackDTO }>
}

export type ShowDTO = {
  id: string
  name: string
  slug: string
  description: string
  host: string
  dayOfWeek: number // 0=Sun..6=Sat
  startHour: number
  startMinute: number
  durationMin: number
  explicit: boolean
  kind: 'PLAYLIST' | 'LIVE'
  accent: string
  active: boolean
}

export type ScheduleResponse = {
  timezone: string
  now: { dayOfWeek: number; minutes: number; label: string }
  shows: ShowDTO[]
  currentShowId: string | null
}

/** One row of a past show's program log (the "listen back" ledger view). */
export type ListenBackEntry = {
  /** ISO instant the element started. */
  at: string
  kind: ElementKind
  title: string
  /** Music/ID/talk artist; for ad spots this is the sponsor name. */
  artist?: string
  /** PlayLog source (AUTODJ / LIVE DJ / PRODUCED) or AD-LEDGER for spots. */
  source?: string
  campaignName?: string | null
}

/** GET /api/shows/listenback — what actually aired during a past show window. */
export type ListenBackResponse = {
  show: { slug: string; name: string; host: string; kind: 'LIVE' | 'PLAYLIST' }
  /** ET calendar date of the occurrence (YYYY-MM-DD). */
  date: string
  windowStart: string
  windowEnd: string
  entries: ListenBackEntry[]
  counts: { music: number; ids: number; talk: number; ads: number }
  serverTime: string
}

/** Minimal public status row for the artist "track my submission" lookup. */
export type SubmissionLookupEntry = {
  trackTitle: string
  genre: string
  status: 'PENDING' | 'IN_REVIEW' | 'APPROVED' | 'DECLINED'
  /** Present once the A&R desk opened a rights record for the track. */
  rightsId: string | null
  createdAt: string
  reviewedAt: string | null
}

export type SubmissionLookupResponse = {
  submissions: SubmissionLookupEntry[]
}

export type SubmissionDTO = {
  id: string
  artistName: string
  email: string
  trackTitle: string
  genre: string
  explicit: boolean
  city: string | null
  state: string | null
  socials: string | null
  fileName: string | null
  fileSize: number | null
  notes: string | null
  status: 'PENDING' | 'IN_REVIEW' | 'APPROVED' | 'DECLINED'
  agreementVersion: string
  agreementAcceptedAt: string | null
  agreementIp: string | null
  reviewNotes: string | null
  reviewedAt: string | null
  rightsId: string | null
  createdAt: string
}

export type RightsDTO = {
  id: string
  trackTitle: string
  artistName: string
  owner: string
  sampleStatus: 'PENDING' | 'CLEARED' | 'UNCLEARED'
  explicitFlag: boolean
  status: 'PENDING' | 'IN_REVIEW' | 'CLEARED' | 'BLOCKED'
  source: 'SUBMISSION' | 'CORE'
  ownerProof: string | null
  clearedAt: string | null
  createdAt: string
}

export type CampaignDTO = {
  id: string
  name: string
  spotsPerDay: number
  creativeName: string
  startAt: string
  endAt: string | null
  active: boolean
  playsTotal: number
  playsToday: number
}

export type SponsorDTO = {
  id: string
  name: string
  contact: string
  tier: 'ON_AIR_SPOT' | 'SHOW_SPONSOR' | 'DAYPART_SPONSOR'
  monthlyRate: number // cents
  status: 'ACTIVE' | 'PENDING' | 'ENDED'
  startAt: string
  endAt: string | null
  campaigns: CampaignDTO[]
}

export type SponsorsResponse = {
  sponsors: SponsorDTO[]
  packages: Array<{ id: string; name: string; price: string; perks: string[]; spotsPerDay: number }>
}

export type AdPlayDTO = {
  id: string
  campaignId: string
  campaignName: string
  sponsorName: string
  playedAt: string
  source: string
}

export type AdPlaysResponse = {
  plays: AdPlayDTO[]
  total: number
  last7Days: number
}

export type StatsResponse = {
  library: { tracks: number; cleared: number; pendingRights: number; blocked: number; totalHours: number }
  submissions: { total: number; pending: number; inReview: number; approved: number; declined: number }
  sponsors: { active: number; monthlyMRR: number }
  adplays: { last7Days: number; today: number }
  /**
   * Real Icecast counts. current/peak24h are null when the engine is
   * unreachable, and source is "unavailable" in that case. Do not substitute a
   * number: an ops dashboard that always shows a figure cannot be trusted to
   * report a real one.
   */
  listeners: { current: number | null; peak24h: number | null; source: "icecast" | "unavailable" }
  engine: {
    reachable: boolean
    state: string
    crateSize: number
    autopilot: boolean
    uptimeSec: number
    lastError: string | null
  }
  stream: {
    reachable: boolean
    onAir: boolean
    encoder: string
    icecast: string | null
    mounts: Array<{
      mount: string
      bitrateKbps: number
      listeners: number
      peakListeners24h: number
      lastMetadata: string | null
    }>
  }
  bandwidth: { kbps: number; gbPerListenerHour: number; projectedGBDay: number | null }
  uptime: { streamOk: boolean; icecastReachable: boolean; daysSinceLaunch: number }
  checklist: string[]
}

// ---- Player/store shared enums ----
export type PlayerState = {
  isPlaying: boolean
  volume: number // 0..1
  previewSynth: boolean // true = WebAudio studio preview, false = silent UI
}

// ---- Listener request line ----
export type RequestTopEntry = {
  trackId: string
  title: string
  artist: string
  rightsId: string
  explicit: boolean
  count: number
  lastRequestedAt: string
}

export type RequestRecentEntry = {
  id: string
  listenerName: string
  note: string | null
  trackTitle: string
  trackArtist: string
  createdAt: string
}

export type RequestsResponse = {
  top: RequestTopEntry[]
  recent: RequestRecentEntry[]
  totalToday: number
  totalAllTime: number
}

export type TrackRequestResponse = {
  ok: true
  request: { id: string; trackId: string; listenerName: string; note: string | null; createdAt: string }
  count: number
  message: string
}

export type ShareResult = 'shared' | 'copied' | 'failed'

export type TracksResponse = {
  tracks: Array<{
    id: string
    title: string
    artist: string
    playlist: string
    durationSec: number
    explicit: boolean
    rightsId: string
  }>
}

/** One row of The Wave Chart — most-heard cleared tracks over the trailing week. */
export type ChartEntry = {
  trackId: string
  rank: number
  title: string
  artist: string
  rightsId: string
  playlist: string
  explicit: boolean
  /** Spins in the trailing 7 days (any source). */
  spins7d: number
  /** Listener shouts in the trailing 7 days. */
  shouts7d: number
  /** Last spin ISO timestamp (null = logged request heat but no recent spin). */
  lastPlayedAt: string | null
  /** True when this entry is spinning on the wheel right now. */
  onAirNow: boolean
  /**
   * Rank in the previous comparable window (the 7 days ending 24h ago).
   * null = the track was not charting then — a NEW entry this week.
   */
  prevRank: number | null
}

/** One row of the all-time Hall of Fame — most spins since the station launched. */
export type AllTimeEntry = {
  trackId: string
  rank: number
  title: string
  artist: string
  rightsId: string
  /** Every logged spin since launch (music + imaging never mix — imaging never charts). */
  totalSpins: number
  firstPlayedAt: string | null
  lastPlayedAt: string | null
}

/** One artist row of "Artists of the Week" — spins aggregated across their tracks. */
export type ArtistEntry = {
  artist: string
  spins7d: number
  /** Distinct tracks of theirs that charted in the window. */
  trackCount: number
  /** Their most-spun track this week. */
  topTrackTitle: string
  /** Share of all music spins this week, 0..100. */
  sharePct: number
}

/** One track row inside the artist detail profile. */
export type ArtistTrackRow = {
  trackId: string
  title: string
  rightsId: string
  playlist: string
  explicit: boolean
  /** Spins in the trailing 7 days. */
  spins7d: number
  /** Every logged spin since launch. */
  totalSpins: number
  /** Listener shouts in the trailing 7 days. */
  shouts7d: number
  /** Rank on this week's Wave Chart (null = not charting this week). */
  chartRank: number | null
  /** True when this track is spinning on the wheel right now. */
  onAirNow: boolean
  lastPlayedAt: string | null
}

/** A recent on-air spin for the artist detail profile. */
export type ArtistRecentSpin = {
  title: string
  playedAt: string
  source: string
}

/** Public artist profile behind the Wave Chart — earned entirely from the ledger. */
export type ArtistDetailResponse = {
  /** The canonical artist string as stored on the tracks (may differ in case from the request). */
  artist: string
  found: boolean
  trackCount: number
  spins7d: number
  totalSpins: number
  /** Share of all music spins in the trailing 7 days, 0..100. */
  sharePct: number
  firstPlayedAt: string | null
  lastPlayedAt: string | null
  /** The artist's cleared tracks, most-spun first. */
  tracks: ArtistTrackRow[]
  /** The 8 most recent ledger spins of their music. */
  recent: ArtistRecentSpin[]
  /** Roster + submission extras (genres, home, socials, first seen). */
  profile?: ArtistProfile | null
  serverTime: string
}

/**
 * Station-identity extras behind an artist profile — joined from the Artist
 * roster + their submissions (never ops data, never email).
 */
export type ArtistProfile = {
  /** Distinct submission genres, most common first (cap 4). */
  genres: string[]
  city: string | null
  state: string | null
  instagram: string | null
  soundcloud: string | null
  /** How many submissions they've sent through the pipeline. */
  submissions: number
  /** Earliest submission instant — "on the waves since". */
  firstSeenAt: string | null
}

/** The entry that climbed the most versus the previous window. */
export type ChartMover = {
  trackId: string
  title: string
  artist: string
  /** Positive = positions climbed. */
  delta: number
  rank: number
}

export type ChartsResponse = {
  week: ChartEntry[]
  /** Total PlayLog rows (music + imaging) in the trailing 7 days. */
  totalSpins7d: number
  /** Biggest week-over-week climber (null = too little history or no climb ≥ 2). */
  mover: ChartMover | null
  /** Hall of Fame — top 5 tracks by spins since launch. */
  allTime: AllTimeEntry[]
  /** Artists of the Week — top 4 artists by 7-day music spins. */
  topArtists: ArtistEntry[]
  /** Total MUSIC PlayLog rows in the trailing 7 days (share denominator). */
  musicSpins7d: number
  timezone: string
  serverTime: string
}

export const TAB_IDS = ['on-air', 'schedule', 'submit', 'rights', 'sponsors', 'ops'] as const
export type TabId = (typeof TAB_IDS)[number]

export const AGREEMENT_VERSION = 'v1.1'
