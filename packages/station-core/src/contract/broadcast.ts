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
  rightsGate: string;
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
  uptimeSec: number;
  serverTime: string;
  lastError: string | null;
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