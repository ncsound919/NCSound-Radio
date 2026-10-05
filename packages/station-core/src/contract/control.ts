import type { AnalysisSource } from "./analysis";
import type {
  CrossfaderCurve,
  PitchFaderRange,
  ScratchPatternId,
  TransitionPreset,
} from "./track";
import type { EngineState, StreamStatus } from "./broadcast";

export type ActorRole = "ops" | "console" | "automation" | "system";

export type Actor = {
  id: string;
  role: ActorRole;
  label: string;
};

export type TransportCommand =
  | { type: "transport.play" }
  | { type: "transport.pause" }
  | { type: "transport.toggle" }
  | { type: "transport.stop" }
  /**
   * Flip the station's on-air switch without touching the engine.
   *
   * Distinct from `transport.stop`, which is an engine operation that also
   * drops the switch. These exist so an operator can go off air and come back
   * without restarting playback, and so "we are live but the operator muted
   * the output" is expressible rather than being indistinguishable from a dead
   * engine.
   */
  | { type: "transport.onAir"; enabled: boolean }
  | { type: "transport.offAir" };

export type MixingCommand =
  | {
      type: "mix.mixNext";
      presetId?: string;
      /**
       * Transition length in bars.
       *
       * Was absent from the contract entirely, which is why the dispatcher had
       * to guess: `runTransition` reads `p.bars || 2`, so every engine-side
       * transition ran at 2 bars regardless of what the operator chose.
       */
      bars?: number;
      curve?: "equal-power" | "linear" | "cut";
    }
  | { type: "mix.skip" }
  | { type: "mix.panic" }
  | { type: "mix.setCrossfader"; position: number }
  | { type: "mix.setCrossfaderCurve"; curve: CrossfaderCurve }
  | { type: "mix.setDeckVolume"; slot: 0 | 1; volume: number }
  | { type: "mix.setEq"; slot: 0 | 1; band: "low" | "mid" | "high"; db: number }
  | { type: "mix.setFilter"; slot: 0 | 1; bipolar: number }
  | { type: "mix.setMasterGain"; gain: number }
  | { type: "mix.setAutoGain"; enabled: boolean }
  | { type: "mix.setTransitionBars"; bars: number };

export type CueingCommand =
  | { type: "cue.track"; trackId: string; slot?: 0 | 1 }
  | { type: "cue.request"; requestId: string }
  | { type: "cue.seek"; slot: 0 | 1; seconds: number }
  | { type: "cue.hotCue"; slot: 0 | 1; cue: "intro" | "drop" | "breakdown" | "outro" }
  | { type: "cue.loop"; slot: 0 | 1; enabled: boolean };

export type SyncCommand =
  | { type: "sync.deck"; slot: 0 | 1; multiplier?: 1 | 2 | 0.5 }
  | { type: "sync.both"; targetBpm?: number }
  | { type: "sync.masterBpm"; bpm: number }
  | { type: "sync.phaseAlign"; slot?: 0 | 1 };

export type ScratchCommand =
  | { type: "scratch.pattern"; patternId: ScratchPatternId; deck?: 0 | 1 }
  | { type: "scratch.agent"; bars?: 2 | 4; style?: "sparse" | "medium" | "busy"; seed?: number; useLlm?: boolean }
  | { type: "scratch.stop" };

export type ImagingCommand = { type: "imaging.play"; jingleId: string };

export type AutopilotCommand =
  | { type: "autopilot.set"; enabled: boolean }
  | { type: "autopilot.setVibe"; templateId: string }
  | { type: "autopilot.resequence"; targetEnergy?: number }
  | { type: "autopilot.setEnergyTarget"; energy: number };

export type LibraryCommand =
  | { type: "library.load"; path: string; slot?: 0 | 1 }
  | { type: "library.analyze"; trackIds: string[]; analyzer?: AnalysisSource }
  | { type: "library.setPitchRange"; range: PitchFaderRange }
  | { type: "library.setPreset"; preset: TransitionPreset };

export type QueryCommand =
  | { type: "query.status" }
  | { type: "query.queue" }
  | { type: "query.crate" }
  | { type: "query.setlist" }
  | { type: "query.analysis"; trackId: string }
  | { type: "query.stream" };

export type DjCommand =
  | TransportCommand
  | MixingCommand
  | CueingCommand
  | SyncCommand
  | ScratchCommand
  | ImagingCommand
  | AutopilotCommand
  | LibraryCommand
  | QueryCommand;

export type CommandEnvelope<T extends DjCommand = DjCommand> = {
  id: string;
  issuedAt: string;
  actor: Actor;
  command: T;
};

export type CommandErrorCode =
  | "UNKNOWN_COMMAND"
  | "INVALID_PARAMS"
  | "ENGINE_OFFLINE"
  | "NO_SUCH_TRACK"
  | "NO_SUCH_REQUEST"
  | "DECK_BUSY"
  | "NOT_LOADED"
  | "RATE_LIMITED"
  | "UNAUTHORIZED"
  | "INTERNAL";

export type CommandResult<T = unknown> =
  | { id: string; ok: true; appliedAt: string; result?: T }
  | { id: string; ok: false; appliedAt: string; code: CommandErrorCode; error: string };

export type EngineEvent =
  | { type: "engine.status"; at: string; state: EngineState }
  | { type: "engine.onAir"; at: string; snapshot: unknown }
  | { type: "engine.telemetry"; at: string; telemetry: unknown }
  | { type: "engine.error"; at: string; message: string; fatal: boolean }
  | { type: "stream.status"; at: string; status: StreamStatus };

export type ServerEvent =
  | EngineEvent
  | { type: "command.result"; at: string; result: CommandResult }
  | { type: "connection.ready"; at: string; actor: Actor };

export const COMMAND_TYPES = [
  "transport.play",
  "transport.pause",
  "transport.toggle",
  "transport.stop",
  "transport.onAir",
  "transport.offAir",
  "mix.mixNext",
  "mix.skip",
  "mix.panic",
  "mix.setCrossfader",
  "mix.setCrossfaderCurve",
  "mix.setDeckVolume",
  "mix.setEq",
  "mix.setFilter",
  "mix.setMasterGain",
  "mix.setAutoGain",
  "mix.setTransitionBars",
  "cue.track",
  "cue.request",
  "cue.seek",
  "cue.hotCue",
  "cue.loop",
  "sync.deck",
  "sync.both",
  "sync.masterBpm",
  "sync.phaseAlign",
  "scratch.pattern",
  "scratch.agent",
  "scratch.stop",
  "imaging.play",
  "autopilot.set",
  "autopilot.setVibe",
  "autopilot.resequence",
  "autopilot.setEnergyTarget",
  "library.load",
  "library.analyze",
  "library.setPitchRange",
  "library.setPreset",
  "query.status",
  "query.queue",
  "query.crate",
  "query.setlist",
  "query.analysis",
  "query.stream",
] as const;

export type CommandType = (typeof COMMAND_TYPES)[number];