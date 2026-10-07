/**
 * The library's data model (plan phase 4).
 *
 * A `LibraryTrack` is metadata only: the audio lives in IndexedDB (an uploaded
 * blob), on disk behind a directory handle, or on the station (fetched from
 * ingest). Kept deliberately small so 10,000 rows fit in memory for search.
 */
import type { TrackAnalysis } from "@ncsound/dj-engine/engine/types";
import type { DeckWaveform } from "../audio/waveform";

export type LibrarySourceKind = "files" | "folder" | "station" | "r2";

export type TrackStatus = "unindexed" | "queued" | "analysing" | "ready" | "failed";

export type LibraryTrack = {
  id: string;
  source: LibrarySourceKind;
  fileName: string;
  /** Directory-relative path (folder source) or the station path. */
  path?: string;
  /** Key into the `handles` store for a folder track. */
  handleId?: string;
  /** Engine crate id for a station track. */
  stationId?: string;
  /** Object key in the Cloudflare R2 `ncsound-media` bucket. */
  r2Key?: string;
  title: string;
  artist: string;
  album?: string;
  size: number;
  lastModified: number;
  /** Measured once decoding completes; null until then. */
  durationSec: number | null;
  bpm: number | null;
  key: string | null;
  rating: number;
  status: TrackStatus;
  /** Why indexing failed; only set when status is "failed". */
  error?: string;
  /** Key into the analysis cache once a result exists. */
  cacheKey?: string;
  dateAddedMs: number;
  /** Set the first time the track is audible this session. */
  playedAtMs?: number;
};

/** A cached, fully analysed track. Structured-cloneable (Float32Arrays included). */
export type AnalysisRecord = {
  cacheKey: string;
  durationSec: number;
  analysis: TrackAnalysis;
  waveform: DeckWaveform;
  analysedAtMs: number;
};

export type AnalyzeRequest = {
  id: string;
  channels: Float32Array[];
  sampleRate: number;
};

export type AnalyzeResponse =
  | { id: string; analysis: TrackAnalysis; waveform: DeckWaveform }
  | { id: string; error: string };

export type CrateRecord = { name: string; trackIds: string[]; updatedAtMs: number };

export type HistoryEntry = {
  trackId: string;
  title: string;
  artist: string;
  fileName: string;
  bpm: number;
  key: string;
  startedAtMs: number;
  durationSec: number;
};
