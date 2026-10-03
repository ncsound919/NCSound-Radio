/**
 * The engine now lives in @ncsound/dj-engine; these types come from
 * @ncsound/station-core via that package. This file stays so existing
 * `./engine/types` imports in the console keep working.
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
} from "@ncsound/dj-engine/engine/types";

export { CROSSFADER_CURVES, PITCH_FADER_RANGES } from "@ncsound/dj-engine/engine/types";