/**
 * Re-exported from @ncsound/station-core.
 *
 * These were originally declared here and duplicated again in station-web's
 * station-types.ts. station-core is now the single source of truth so the
 * engine, the ingest service and the station site cannot drift apart.
 * apps/dj-console/src/engine/types.ts re-exports from here.
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
} from "@ncsound/station-core";

export { CROSSFADER_CURVES, PITCH_FADER_RANGES } from "@ncsound/station-core";