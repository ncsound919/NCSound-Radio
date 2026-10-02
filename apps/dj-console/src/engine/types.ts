/**
 * Re-exported from @wavc/station-core.
 *
 * These were originally declared here and duplicated in station-web's
 * station-types.ts. station-core is now the single source of truth so the
 * engine, the ingest service and the station site cannot drift apart.
 */

export type {
  BattleSampleId,
  CrossfaderCurve,
  CuePoints,
  ElementKind,
  EnergyTier,
  MasterBusTelemetry,
  PartyTemplate,
  PhaseDifferenceInfo,
  PitchFaderRange,
  QueueEntry,
  ScratchCutMode,
  ScratchPattern,
  ScratchPatternId,
  ScratchQuantizeMode,
  ScratchSourceMode,
  ScratchTelemetry,
  SetlistEntry,
  TrackAcousticMetadata,
  TrackAnalysis,
  TrackDTO,
  TransitionPreset,
  TransitionStyle,
  WaveformBands,
} from "@wavc/station-core";

export { CROSSFADER_CURVES, PITCH_FADER_RANGES } from "@wavc/station-core";