/**
 * The station-web public HTTP contract, as the listener app sees it.
 *
 * These mirror `apps/station-web/src/lib/station-types.ts`. They are duplicated
 * here deliberately: the app must not import from the Next.js app. Primitive
 * domain types (StationIdentity, TrackDTO, QueueEntry, …) are imported from
 * `@ncsound/station-core` so there is still one source for those.
 *
 * When a route's response grows a field, add it here too — this file is what the
 * app typechecks against.
 */

import type {
  Daypart,
  LiveShowInfo,
  NowPlayingElement,
  QueueEntry,
  StationIdentity,
  TrackDTO,
  WheelSlice,
} from "@ncsound/station-core";

// --- /api/stream -----------------------------------------------------------

export type StreamQuality = "hi" | "mobile";

export type StreamMount = {
  path: string;
  bitrateKbps: number;
  codec: string;
  label: string;
  /** Absolute URL, built by the server from the configured base. */
  url: string;
};

export type StreamDescriptor = {
  baseUrl: string;
  live: StreamMount;
  mobile: StreamMount;
  /** Reserved for the adaptive-bitrate path; null until it exists. */
  hls: string | null;
  updatedAt: string;
};

// --- /api/video ------------------------------------------------------------

export type VideoShow = {
  id: string;
  name: string;
  host: string;
  kind: "LIVE" | "PLAYLIST";
  isVideo: boolean;
};

export type VideoDescriptor = {
  /** False when STREAM_* env is unset — the app must then hide all video UI. */
  configured: boolean;
  live: boolean;
  inputId: string | null;
  videoId: string | null;
  hls: string | null;
  dash: string | null;
  dvrHls: string | null;
  player: string | null;
  /** Prompt the listener only when a LIVE show is on air AND the feed is live. */
  promote: boolean;
  show: VideoShow | null;
  reason: string | null;
  updatedAt: string;
};

// --- /api/nowplaying -------------------------------------------------------

export type NowPlayingMode = "live" | "standby" | "offline";

export type NowPlayingComponents = {
  enginePlaying: boolean;
  outputLive: boolean;
  mountConnected: boolean;
};

/**
 * A normalised now-playing document.
 *
 * The live response carries `element`, `daypart`, `engine` and `stream`; the
 * 503 offline body omits them. They are optional here so a caller reads one
 * shape and narrows on `mode` rather than on which fields happen to exist.
 */
export type NowPlaying = {
  station: StationIdentity & { bitrateKbps: number };
  mode: NowPlayingMode;
  current: {
    track: TrackDTO;
    startedAt: string;
    elapsed: number;
    duration: number;
    remaining: number;
    progress: number;
  } | null;
  next: QueueEntry[];
  element?: NowPlayingElement;
  daypart?: Daypart;
  liveShow?: LiveShowInfo | null;
  standbyReason?: string | null;
  /** Present when `mode` is "offline". */
  offlineReason?: string;
  broadcastComponents?: NowPlayingComponents | null;
  heat?: Record<string, number>;
  requestedBy?: Record<string, string[]>;
  wheel?: WheelSlice[];
  cycleIndex?: number;
  cycleSec?: number;
  /** Counts are null when unknown — never 0-as-a-lie. */
  listeners: { current: number | null; peak24h: number | null; source?: string };
  engine?: {
    state: string;
    crateSize: number;
    autopilot: boolean;
    uptimeSec: number;
    lastError: string | null;
    spectrum: number[];
  };
  stream?: {
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
  streamUrl: string | null;
  serverTime: string;
};

// --- /api/schedule ---------------------------------------------------------

export type ShowDTO = {
  id: string;
  name: string;
  slug: string;
  description: string;
  host: string;
  dayOfWeek: number;
  startHour: number;
  startMinute: number;
  durationMin: number;
  explicit: boolean;
  kind: "PLAYLIST" | "LIVE";
  accent: string;
  active: boolean;
};

export type Schedule = {
  timezone: string;
  now: { dayOfWeek: number; minutes: number; label: string };
  shows: ShowDTO[];
  currentShowId: string | null;
};

// --- /api/requests ---------------------------------------------------------

export type RequestTopEntry = {
  trackId: string;
  title: string;
  artist: string;
  explicit: boolean;
  count: number;
  lastRequestedAt: string;
};

export type RequestRecentEntry = {
  id: string;
  listenerName: string;
  note: string | null;
  trackTitle: string;
  trackArtist: string;
  createdAt: string;
};

export type Requests = {
  top: RequestTopEntry[];
  recent: RequestRecentEntry[];
  totalToday: number;
  totalAllTime: number;
};

export type PostRequestInput = {
  trackId: string;
  listenerName: string;
  note?: string | null;
};

export type TrackRequestResult = {
  ok: true;
  request: {
    id: string;
    trackId: string;
    listenerName: string;
    note: string | null;
    createdAt: string;
  };
  count: number;
  message: string;
};

// --- /api/tracks -----------------------------------------------------------

export type LibraryTrack = {
  id: string;
  title: string;
  artist: string;
  playlist: string;
  durationSec: number;
  explicit: boolean;
};

export type Tracks = { tracks: LibraryTrack[] };
