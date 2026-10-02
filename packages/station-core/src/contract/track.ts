export type ElementKind = "MUSIC" | "STATION_ID" | "AD_SPOT" | "TALK";

export type TrackDTO = {
  id: string;
  title: string;
  artist: string;
  album: string | null;
  durationSec: number;
  rightsId: string;
  explicit: boolean;
  playlist: string;
  bpm: number | null;
};

export type QueueEntry = TrackDTO & {
  elementKind: ElementKind;
  sponsorName?: string | null;
};

export type CuePoints = {
  intro: number;
  drop: number;
  breakdown: number;
  outro: number;
};

export type WaveformBands = {
  low: Float32Array;
  mid: Float32Array;
  high: Float32Array;
  peaks: Float32Array;
  energyCurve: Float32Array;
};

export type EnergyTier = "Warmup" | "Groove" | "Peak Time" | "Anthem";

export type TrackAcousticMetadata = {
  genre: string;
  energyTier: EnergyTier;
  tags: string[];
  mood: string;
  harmonicMood: string;
  parsedFromTag: boolean;
};

export type TrackAnalysis = {
  bpm: number;
  firstBeat: number;
  key?: string;
  keyName?: string;
  energy?: number;
  rmsDb?: number;
  autoGainDb?: number;
  cuePoints?: CuePoints;
  waveform?: WaveformBands;
  categorization?: TrackAcousticMetadata;
};

export type CrossfaderCurve = "blend" | "dip" | "cut";

export type PitchFaderRange = 4 | 8 | 16 | 50;

export type TransitionStyle =
  | "auto"
  | "drop-cut"
  | "bass-swap"
  | "filter-riser"
  | "vinyl-brake"
  | "backspin"
  | "echo-out"
  | "spin-whip"
  | "blend";

export type TransitionPreset = {
  id: string;
  name: string;
  bars: number;
  curve: "equal-power" | "linear" | "cut";
  filterSweep?: boolean;
  bassSwap?: boolean;
  style?: TransitionStyle;
};

export type ScratchPatternId =
  | "baby"
  | "flare"
  | "transformer"
  | "chirp"
  | "crab"
  | "tear"
  | "backspin"
  | "uzis";

export type ScratchSourceMode = "vinyl" | "slip" | "incoming" | "cut";
export type ScratchQuantizeMode = "1/16" | "1/8" | "instant";
export type ScratchCutMode = "mag-four" | "smooth";
export type BattleSampleId = "auto" | "fresh" | "ahhh" | "cut" | "scratch" | "drop";

export type ScratchPattern = {
  id: ScratchPatternId;
  name: string;
  subtitle: string;
  beats: number;
  clicksPerBeat: number;
  description: string;
};

export type ScratchTelemetry = {
  active: boolean;
  patternId: ScratchPatternId | "manual" | "agent" | null;
  patternName: string;
  deck: 0 | 1;
  progress: number;
  velocity: number;
  displacement: number;
  faderOpen: boolean;
  faderGain: number;
  anchorSec?: number;
  headSec?: number;
  cutSampleLabel?: string;
  trackModCount?: number;
  curveSamples: Float32Array;
  gateSamples: Float32Array;
};

export type MasterBusTelemetry = {
  masterPeakDb: number;
  limiterReductionDb: number;
  autoGainEnabled: boolean;
  splitCueEnabled: boolean;
  micActive: boolean;
  recordingActive: boolean;
  recordingElapsedSec: number;
};

export type PartyTemplate = {
  id: string;
  name: string;
  energyCurve: number[];
  transition: string;
};

export type PhaseDifferenceInfo = {
  phaseDiffBeats: number;
  phaseDiffMs: number;
  inPhase: boolean;
  masterBeatProgress: number;
  deckBeatProgress: number;
};

export type SetlistEntry = {
  index: number;
  playedAtIso: string;
  elapsedSessionMin: number;
  title: string;
  artist: string;
  fileName: string;
  bpm: number;
  key: string;
  energy: number;
  transitionPreset: string;
  harmonicMatch: string;
};

export const CROSSFADER_CURVES: CrossfaderCurve[] = ["blend", "dip", "cut"];
export const PITCH_FADER_RANGES: PitchFaderRange[] = [4, 8, 16, 50];