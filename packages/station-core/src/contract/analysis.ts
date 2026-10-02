import type { TrackAnalysis } from "./track";

export type SliceKind = "word" | "syllable" | "transient";

export type Slice = {
  id: number;
  start: number;
  end: number;
  kind: SliceKind;
  text?: string | null;
  energy: number;
};

export type Grid = {
  bpm: number;
  beats: number[];
  downbeats: number[];
  swing: number;
  agreement: number;
};

export type SliceBank = {
  source_path: string;
  sr: number;
  slices: Slice[];
  vocal_onsets: number[];
};

export type AnalysisSource = "engine" | "essentia" | "madmom" | "demucs" | "manual";

export type AnalysisBundle = {
  version: 1;
  track_id: string;
  source_path: string;
  analyzed_at: string;
  analyzer: AnalysisSource;
  slice_bank: SliceBank | null;
  grid: Grid | null;
  stems: string[];
  analysis: TrackAnalysis | null;
};

export type StemKind = "vocals" | "drums" | "bass" | "other";

export type StemRef = {
  kind: StemKind;
  path: string;
  uri: string;
};

export type AnalysisJobStatus =
  | "queued"
  | "analyzing"
  | "stems"
  | "complete"
  | "failed";

export type AnalysisJob = {
  id: string;
  track_id: string;
  status: AnalysisJobStatus;
  progress: number;
  analyzer: AnalysisSource;
  error: string | null;
  bundle: AnalysisBundle | null;
  created_at: string;
  updated_at: string;
};