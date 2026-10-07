import type { ElementKind, QueueEntry, TrackDTO } from "./track";
import type { MasterBusTelemetry, ScratchTelemetry, TransitionPreset } from "./track";

export type NowPlayingElement = {
  kind: ElementKind;
  campaignName?: string;
  sponsorName?: string;
  creativeName?: string;
};

export type WheelSlice = { kind: ElementKind; durSec: number };

export type LiveShowInfo = {
  id: string;
  name: string;
  host: string;
  description: string;
  kind: "LIVE" | "PLAYLIST";
  accent: string;
  startedAtIso: string;
  endsAtIso: string;
  minutesLeft: number;
};

export type Daypart = { clean: boolean; label: string };

export type StationIdentity = {
  name: string;
  tagline: string;
  timezone: string;
};

export type ListenerCounts = {
  current: number;
  peak24h: number;
  source: "icecast" | "estimated";
};

export type TrackProgress = {
  track: TrackDTO;
  startedAt: string;
  elapsed: number;
  duration: number;
  remaining: number;
  progress: number;
};

export type OnAirSnapshot = {
  current: TrackProgress;
  element: NowPlayingElement;
  daypart: Daypart;
  liveShow: LiveShowInfo | null;
  next: QueueEntry[];
  wheel: WheelSlice[];
  cycleIndex: number;
  cycleSec: number;
  serverTime: string;
};

export type TransitionState = {
  active: boolean;
  preset: TransitionPreset | null;
  fromTrackId: string | null;
  toTrackId: string | null;
  startedAt: string | null;
  endsAt: string | null;
  progress: number;
  harmonicMatch: string | null;
};

export type DeckSnapshot = {
  slot: 0 | 1;
  trackId: string | null;
  playing: boolean;
  bpm: number | null;
  key: string | null;
  positionSec: number;
  durationSec: number;
  speed: number;
  gainDb: number;
  lowDb: number;
  midDb: number;
  highDb: number;
  levelDb: number;
};

export type EngineState =
  | "offline"
  | "idle"
  | "loading"
  | "playing"
  | "transitioning"
  | "scratching"
  | "degraded"
  | "error";

export type EngineTelemetry = {
  masterPeakDb: number;
  masterRmsDb: number;
  limiterReductionDb: number;
  spectrum: number[];
  crossfader: number;
  crossfaderCurve: string;
  decks: DeckSnapshot[];
  scratch: ScratchTelemetry | null;
  master: MasterBusTelemetry;
  renderedAheadSec: number;
  /**
   * Milliseconds since the render tap last produced a block, or -1 when it never
   * has.
   *
   * `renderedAheadSec` is a derived estimate that saturates at both ends, so a
   * fully stalled pump pins it to -1 and reads as "slightly behind". This is a
   * direct observation: climbing into the thousands means the engine has stopped
   * producing audio while still reporting itself healthy, which is exactly the
   * state that went unnoticed for hours.
   */
  renderStallMs: number;
  cpuMsPerBlock: number;
  sampleRate: number;
};

export type AutopilotState = {
  enabled: boolean;
  vibeTemplateId: string | null;
  energyTarget: number;
  queueDepth: number;
  crateSize: number;
};

export type EngineStatus = {
  state: EngineState;
  onAir: OnAirSnapshot | null;
  transition: TransitionState;
  telemetry: EngineTelemetry | null;
  autopilot: AutopilotState;
  listeners: ListenerCounts;
  /**
   * The engine's upload into Liquidsoap's harbor, or null when publishing is off.
   *
   * The one link in the chain that used to go unreported. Every other link had a
   * field: the deck had `playing`, the bus had a meter, the mount had a listener
   * count. The engine could be uploading to nothing while all of them looked
   * healthy, and the only evidence was a line in Liquidsoap's own log —
   * `Not ready: need more buffering (0/529200)`.
   *
   * Read `backlogBytes`, not `connected`: writing to a socket never fails when the
   * peer is gone, so `connected` stays true while bytes queue for a reader that
   * never comes.
   */
  harbor: {
    connected: boolean;
    bytesSent: number;
    framesSent: number;
    /** Bytes queued with nothing draining them. Climbing means a dead peer. */
    backlogBytes: number;
    reconnects: number;
    lastError: string | null;
  } | null;
  uptimeSec: number;
  serverTime: string;
  lastError: string | null;
};

/**
 * "Is a listener hearing programme audio right now?"
 *
 * This was decided twice, differently, and the two answers disagreed in the
 * case that mattered:
 *
 *  - the station site called it live when the Icecast mount was connected and
 *    the engine had a track armed;
 *  - the DJ console called it on-air when the operator had not switched
 *    Liquidsoap to silence.
 *
 * Going off air satisfies the first and fails the second, so the listener-facing
 * site kept announcing "live" while the station was transmitting silence — and
 * `transport.stop` did the same, because the engine's own state string does not
 * change when it stops. Both surfaces were locally defensible and jointly wrong.
 *
 * So the answer is computed once, here, from all three inputs, and every
 * surface reads the same field.
 */
export type BroadcastState = {
  /** True only when all three components below are true. */
  onAir: boolean;
  /** Why not, when off. Empty string while on air. */
  reason: string;
  components: {
    /** The engine has audio armed and is rendering it. */
    enginePlaying: boolean;
    /** Liquidsoap's output is switched to the live feed, not to silence. */
    outputLive: boolean;
    /** Icecast has a connected source on the mount. */
    mountConnected: boolean;
  };
};

export type StreamEncoder = "mp3" | "opus" | "aac" | "none";

export type StreamMount = {
  mount: string;
  encoder: StreamEncoder;
  bitrateKbps: number;
  connected: boolean;
  connectedSince: string | null;
  listeners: number;
  peakListeners24h: number;
  bytesSent: number;
  lastMetadata: string | null;
};

export type StreamStatus = {
  /** Liquidsoap process is alive and the render pump is feeding it. */
  ingestHealthy: boolean;
  /** At least one Icecast mount is connected and receiving audio. */
  onAir: boolean;
  encoder: StreamEncoder;
  mounts: StreamMount[];
  liquidsoap: {
    reachable: boolean;
    version: string | null;
    uptimeSec: number | null;
    error: string | null;
  };
  icecast: {
    reachable: boolean;
    version: string | null;
    error: string | null;
  };
  updatedAt: string;
};