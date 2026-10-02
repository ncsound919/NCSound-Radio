/**
 * WAVC 91.3 "Carolina Waves" — SHARED TYPES / API CONTRACT
 * ---------------------------------------------------------
 * This file is the single source of truth for every agent.
 * Backend returns these shapes; frontend imports these types.
 */

export type TrackDTO = {
  id: string
  title: string
  artist: string
  album: string | null
  durationSec: number
  rightsId: string
  explicit: boolean
  playlist: string
  bpm: number | null
}

/** Program-clock element kinds: songs, imaging IDs, ad-break spots, talk segments. */
export type ElementKind = 'MUSIC' | 'STATION_ID' | 'AD_SPOT' | 'TALK'

/** What the AutoDJ is airing right now (mirrors the broadcast engine). */
export type NowPlayingElement = {
  kind: ElementKind
  campaignName?: string
  sponsorName?: string
  creativeName?: string
}

/** A queue entry: a real track, an imaging ID, a talk segment, or an (ad/house) spot. */
export type QueueEntry = TrackDTO & {
  elementKind: ElementKind
  sponsorName?: string | null
}

/** The scheduled show currently on air (player-bar / hero takeover). */
export type LiveShowInfo = {
  id: string
  name: string
  host: string
  description: string
  kind: 'LIVE' | 'PLAYLIST'
  accent: string
  startedAtIso: string
  endsAtIso: string
  /** Minutes until the show hands the wheel back to AutoDJ. */
  minutesLeft: number
}

export type NowPlayingResponse = {
  station: {
    name: string
    tagline: string
    bitrateKbps: number
    timezone: string
    rightsGate: string
  }
  current: {
    track: TrackDTO
    startedAt: string // ISO
    elapsed: number // seconds
    duration: number // seconds
    remaining: number // seconds
    progress: number // 0..1
  }
  /** Program-clock element currently airing (music / station ID / ad spot / talk). */
  element: NowPlayingElement
  /** Clean Daypart state: explicit tracks are held 6 AM–7 PM ET. */
  daypart: { clean: boolean; label: string }
  /** Scheduled show on air right now (any kind) — null when AutoDJ owns the wheel. */
  liveShow: LiveShowInfo | null
  next: QueueEntry[]
  /** Request heat (7-day listener requests): trackId -> count, only > 0 entries. */
  heat: Record<string, number>
  /** Who shouted for the current/upcoming music tracks (max 3 names each). */
  requestedBy: Record<string, string[]>
  listeners: {
    current: number
    peak24h: number
  }
  mode: 'simulated' | 'live'
  streamUrl: string | null
  serverTime: string
}

export type ListenerPoint = { t: string; v: number }

export type ListenersHistoryResponse = {
  points: ListenerPoint[]
  current: number
  peak24h: number
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
  listeners: { current: number; peak24h: number }
  bandwidth: { kbps: number; gbPerListenerHour: number; projectedGBDay: number }
  uptime: { streamOk: boolean; daysSinceLaunch: number }
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
  timezone: string
  serverTime: string
}

export const TAB_IDS = ['on-air', 'schedule', 'submit', 'rights', 'sponsors', 'ops'] as const
export type TabId = (typeof TAB_IDS)[number]

export const AGREEMENT_VERSION = 'v1.1'
