import { evaluateHarmonicMatch } from "@ncsound/dj-engine/sync";
import type { EnergyTier, TrackAcousticMetadata, TrackAnalysis, WaveformBands } from "./types";

export interface ParsedAudioMetadata {
  title?: string;
  artist?: string;
  genre?: string;
  album?: string;
  bpm?: number;
  key?: string;
  comment?: string;
  year?: string;
  source: "id3v2" | "id3v1" | "mp4" | "vorbis" | "wav-info" | "filename" | "synth";
}

export interface CrateIndexRecord {
  id: string;
  name: string;
  artist: string;
  genre: string;
  tags: string[];
  energyTier: EnergyTier;
  mood: string;
  harmonicMood: string;
  bpm: number;
  key: string;
  keyName: string;
  energy: number;
  rmsDb: number;
  autoGainDb: number;
  durationSec: number;
  cuePoints?: {
    intro: number;
    drop: number;
    breakdown: number;
    outro: number;
  };
  waveformLow: number[];
  waveformMid: number[];
  waveformHigh: number[];
  waveformPeaks: number[];
  waveformEnergy: number[];
  fileBlob?: Blob;
  fileName?: string;
  playCount: number;
  lastPlayedAtMs?: number;
  dateAddedMs: number;
}

export interface CrateSearchFilters {
  query: string;
  activeKey?: string;
  harmonicOnly?: boolean;
  genre?: string;
  energyTier?: EnergyTier | "all";
  bpmMin?: number;
  bpmMax?: number;
  sortBy?:
    | "smart"
    | "bpm-asc"
    | "bpm-desc"
    | "key"
    | "energy-desc"
    | "energy-asc"
    | "title"
    | "artist"
    | "recent";
  targetEnergy?: number;
}

const ID3_GENRES = [
  "Blues", "Classic Rock", "Country", "Dance", "Disco", "Funk", "Grunge", "Hip-Hop",
  "Jazz", "Metal", "New Age", "Oldies", "Other", "Pop", "R&B", "Rap", "Reggae",
  "Rock", "Techno", "Industrial", "Alternative", "Ska", "Death Metal", "Pranks",
  "Soundtrack", "Euro-Techno", "Ambient", "Trip-Hop", "Vocal", "Jazz+Funk", "Fusion",
  "Trance", "Classical", "Instrumental", "Acid", "House", "Game", "Sound Clip", "Gospel",
  "Noise", "AlternRock", "Bass", "Soul", "Punk", "Space", "Meditative", "Instrumental Pop",
  "Instrumental Rock", "Ethnic", "Gothic", "Darkwave", "Techno-Industrial", "Electronic",
  "Pop-Folk", "Eurodance", "Dream", "Southern Rock", "Comedy", "Cult", "Gangsta", "Top 40",
  "Christian Rap", "Pop/Funk", "Jungle", "Native American", "Cabaret", "New Wave", "Psychadelic",
  "Rave", "Showtunes", "Trailer", "Lo-Fi", "Tribal", "Acid Punk", "Acid Jazz", "Polka",
  "Retro", "Musical", "Rock & Roll", "Hard Rock", "Folk", "Folk-Rock", "National Folk",
  "Swing", "Fast Fusion", "Bebob", "Latin", "Revival", "Celtic", "Bluegrass", "Avantgarde",
  "Gothic Rock", "Progressive Rock", "Psychedelic Rock", "Symphonic Rock", "Slow Rock",
  "Big Band", "Chorus", "Easy Listening", "Acoustic", "Humour", "Speech", "Chanson",
  "Opera", "Chamber Music", "Sonata", "Symphony", "Booty Bass", "Primus", "Porn Groove",
  "Satire", "Slow Jam", "Club", "Tango", "Samba", "Folklore", "Ballad", "Power Ballad",
  "Rhythmic Soul", "Freestyle", "Duet", "Punk Rock", "Drum Solo", "Acapella", "Euro-House",
  "Dance Hall", "Goa", "Drum & Bass", "Club-House", "Hardcore", "Terror", "Indie", "BritPop",
  "Afro-Punk", "Polsk Punk", "Beat", "Christian Gangsta", "Heavy Metal", "Black Metal",
  "Crossover", "Contemporary Christian", "Christian Rock", "Merengue", "Salsa", "Thrash Metal",
  "Anime", "JPop", "Synthpop",
];

// Helper to decode text safely
function decodeTextBytes(bytes: Uint8Array, encodingByte = 0): string {
  if (!bytes.length) return "";
  try {
    if (encodingByte === 1 || encodingByte === 2) {
      // UTF-16 with BOM or without
      return new TextDecoder("utf-16").decode(bytes).replace(/\0+$/, "").trim();
    }
    if (encodingByte === 3) {
      // UTF-8
      return new TextDecoder("utf-8").decode(bytes).replace(/\0+$/, "").trim();
    }
    // Default ISO-8859-1
    return new TextDecoder("iso-8859-1").decode(bytes).replace(/\0+$/, "").trim();
  } catch {
    let s = "";
    for (let i = 0; i < bytes.length; i++) {
      if (bytes[i] >= 32 && bytes[i] <= 126) s += String.fromCharCode(bytes[i]);
    }
    return s.trim();
  }
}

/**
 * Intelligent filename parser that extracts artist, title, remix, BPM and Camelot keys.
 * Handles patterns like "01. Sublevel - Warehouse Groove (Club Mix) [124 BPM] [8A].mp3"
 */
export function parseFilenameMetadata(filename: string): ParsedAudioMetadata {
  let cleanName = filename.replace(/\.[^/.]+$/, ""); // strip extension
  // Strip leading track numbers like "01 ", "01. ", "01 - ", "A1 "
  cleanName = cleanName.replace(/^([0-9]{1,3}|[A-D][0-9]?)[.\s_-]+/i, "");

  let bpm: number | undefined;
  let key: string | undefined;
  let artist: string | undefined;
  let title: string | undefined;
  let comment: string | undefined;

  // Extract bracketed/parenthesized BPM e.g. [124 BPM] or (126bpm)
  const bpmMatch = /[[({]\s*(\d{2,3}(?:\.\d{1,2})?)\s*(?:bpm|tempo)?\s*[\])}]/i.exec(cleanName);
  if (bpmMatch) {
    bpm = parseFloat(bpmMatch[1]);
    cleanName = cleanName.replace(bpmMatch[0], "").trim();
  }

  // Extract Camelot key like [8A], (11B), or [8A-124]
  const keyMatch = /[[({]\s*((?:[1-9]|1[0-2])[AB])\s*[\])}]/i.exec(cleanName);
  if (keyMatch) {
    key = keyMatch[1].toUpperCase();
    cleanName = cleanName.replace(keyMatch[0], "").trim();
  }

  // Extract remix / edit in parentheses e.g. (Extended Mix), [Club Edit]
  const mixMatch = /[[({]([^\])}]+(?:mix|dub|edit|remix|version|vocal|instrumental)[^\])}]*)[\])}]/i.exec(cleanName);
  if (mixMatch) {
    comment = mixMatch[1].trim();
  }

  // Split on " - " for Artist - Title
  if (cleanName.includes(" - ")) {
    const parts = cleanName.split(" - ");
    artist = parts[0].trim();
    title = parts.slice(1).join(" - ").trim();
  } else if (cleanName.includes("_-_")) {
    const parts = cleanName.split("_-_");
    artist = parts[0].replace(/_/g, " ").trim();
    title = parts.slice(1).join(" - ").replace(/_/g, " ").trim();
  } else {
    title = cleanName.replace(/[_-]+/g, " ").trim();
  }

  return {
    title: title || cleanName,
    artist: artist || "Unknown Artist",
    bpm,
    key,
    comment,
    source: "filename",
  };
}

/**
 * Parses ID3v2 header and text frames (TIT2, TPE1, TALB, TCON, TBPM, TKEY, COMM).
 */
export function parseId3v2(view: DataView): Partial<ParsedAudioMetadata> | null {
  if (view.byteLength < 10) return null;
  // Header: ID3 (3 bytes)
  if (
    view.getUint8(0) !== 0x49 ||
    view.getUint8(1) !== 0x44 ||
    view.getUint8(2) !== 0x33
  ) {
    return null;
  }
  const version = view.getUint8(3); // 3 for v2.3, 4 for v2.4
  // Syncsafe 4-byte size
  const tagSize =
    ((view.getUint8(6) & 0x7f) << 21) |
    ((view.getUint8(7) & 0x7f) << 14) |
    ((view.getUint8(8) & 0x7f) << 7) |
    (view.getUint8(9) & 0x7f);

  const maxOffset = Math.min(view.byteLength, 10 + tagSize);
  let offset = 10;
  const result: Partial<ParsedAudioMetadata> = { source: "id3v2" };

  while (offset + 10 < maxOffset) {
    const frameId = String.fromCharCode(
      view.getUint8(offset),
      view.getUint8(offset + 1),
      view.getUint8(offset + 2),
      view.getUint8(offset + 3)
    );
    if (!/^[A-Z0-9]{4}$/.test(frameId)) break;

    let frameSize = 0;
    if (version === 4) {
      // Syncsafe in v2.4
      frameSize =
        ((view.getUint8(offset + 4) & 0x7f) << 21) |
        ((view.getUint8(offset + 5) & 0x7f) << 14) |
        ((view.getUint8(offset + 6) & 0x7f) << 7) |
        (view.getUint8(offset + 7) & 0x7f);
    } else {
      frameSize = view.getUint32(offset + 4, false);
    }

    offset += 10;
    if (frameSize <= 0 || offset + frameSize > maxOffset) break;

    const encoding = view.getUint8(offset);
    const contentBytes = new Uint8Array(view.buffer, view.byteOffset + offset + 1, Math.max(0, frameSize - 1));
    const val = decodeTextBytes(contentBytes, encoding);

    if (val) {
      if (frameId === "TIT2") result.title = val;
      else if (frameId === "TPE1") result.artist = val;
      else if (frameId === "TALB") result.album = val;
      else if (frameId === "TCON") {
        // Resolve numeric genres like "(17)" or numeric strings
        const numMatch = /^\(?(\d+)\)?$/.exec(val.trim());
        if (numMatch) {
          const idx = parseInt(numMatch[1], 10);
          result.genre = ID3_GENRES[idx] || val;
        } else {
          result.genre = val;
        }
      } else if (frameId === "TBPM") {
        const parsed = parseFloat(val);
        if (!isNaN(parsed) && parsed > 40 && parsed < 240) result.bpm = parsed;
      } else if (frameId === "TKEY") {
        result.key = val;
      } else if (frameId === "COMM" || frameId === "TIT3") {
        result.comment = val;
      }
    }
    offset += frameSize;
  }

  return result;
}

/**
 * Parses ID3v1 tags (last 128 bytes of an MP3 file).
 */
export function parseId3v1(buffer: ArrayBuffer): Partial<ParsedAudioMetadata> | null {
  if (buffer.byteLength < 128) return null;
  const view = new DataView(buffer, buffer.byteLength - 128, 128);
  if (
    view.getUint8(0) !== 0x54 || // T
    view.getUint8(1) !== 0x41 || // A
    view.getUint8(2) !== 0x47    // G
  ) {
    return null;
  }
  const bytes = new Uint8Array(buffer, buffer.byteLength - 128, 128);
  const title = decodeTextBytes(bytes.subarray(3, 33));
  const artist = decodeTextBytes(bytes.subarray(33, 63));
  const album = decodeTextBytes(bytes.subarray(63, 93));
  const genreIndex = bytes[127];
  const genre = ID3_GENRES[genreIndex] || undefined;

  return {
    title: title || undefined,
    artist: artist || undefined,
    album: album || undefined,
    genre,
    source: "id3v1",
  };
}

/**
 * Reads metadata tags from MP4 / M4A metadata atoms (ilst atom).
 */
export function parseMp4Atoms(view: DataView): Partial<ParsedAudioMetadata> | null {
  if (view.byteLength < 64) return null;
  const max = Math.min(view.byteLength - 8, 65536);
  const res: Partial<ParsedAudioMetadata> = { source: "mp4" };
  let found = false;

  // Scan for common MP4 text atoms
  for (let i = 0; i < max; i++) {
    const tag = String.fromCharCode(
      view.getUint8(i),
      view.getUint8(i + 1),
      view.getUint8(i + 2),
      view.getUint8(i + 3)
    );
    if (tag === "\xa9nam" || tag === "\xa9ART" || tag === "\xa9gen" || tag === "tmpo") {
      // Typically followed by data atom: size(4), 'data'(4), type(4), flags(4)
      const dataOffset = i + 4;
      if (dataOffset + 16 < view.byteLength) {
        const atomLen = view.getUint32(dataOffset, false);
        const dataTag = String.fromCharCode(
          view.getUint8(dataOffset + 4),
          view.getUint8(dataOffset + 5),
          view.getUint8(dataOffset + 6),
          view.getUint8(dataOffset + 7)
        );
        if (dataTag === "data" && atomLen > 16) {
          const payloadLen = Math.min(atomLen - 16, 256);
          const raw = new Uint8Array(view.buffer, view.byteOffset + dataOffset + 16, payloadLen);
          if (tag === "tmpo" && payloadLen >= 2) {
            res.bpm = (raw[0] << 8) | raw[1];
            found = true;
          } else {
            const txt = decodeTextBytes(raw, 3);
            if (txt) {
              if (tag === "\xa9nam") res.title = txt;
              else if (tag === "\xa9ART") res.artist = txt;
              else if (tag === "\xa9gen") res.genre = txt;
              found = true;
            }
          }
        }
      }
    }
  }
  return found ? res : null;
}

/**
 * Universal metadata parser: inspects raw file bytes for ID3v2, ID3v1, MP4, and merges with filename parsing.
 */
export async function parseAudioFileMetadata(file: File): Promise<ParsedAudioMetadata> {
  const fromFilename = parseFilenameMetadata(file.name);
  try {
    // Read first 64KB for ID3v2 or MP4 headers, and last 128 bytes for ID3v1
    const headSlice = await file.slice(0, Math.min(file.size, 65536)).arrayBuffer();
    const headView = new DataView(headSlice);

    const id3v2 = parseId3v2(headView);
    if (id3v2 && (id3v2.title || id3v2.artist || id3v2.genre)) {
      return {
        title: id3v2.title || fromFilename.title,
        artist: id3v2.artist || fromFilename.artist,
        genre: id3v2.genre || fromFilename.genre,
        bpm: id3v2.bpm || fromFilename.bpm,
        key: id3v2.key || fromFilename.key,
        album: id3v2.album,
        comment: id3v2.comment || fromFilename.comment,
        source: "id3v2",
      };
    }

    const mp4 = parseMp4Atoms(headView);
    if (mp4 && (mp4.title || mp4.artist || mp4.genre)) {
      return {
        title: mp4.title || fromFilename.title,
        artist: mp4.artist || fromFilename.artist,
        genre: mp4.genre || fromFilename.genre,
        bpm: mp4.bpm || fromFilename.bpm,
        key: fromFilename.key,
        source: "mp4",
      };
    }

    if (file.size > 256) {
      const tailSlice = await file.slice(file.size - 128, file.size).arrayBuffer();
      const id3v1 = parseId3v1(tailSlice);
      if (id3v1 && (id3v1.title || id3v1.artist)) {
        return {
          title: id3v1.title || fromFilename.title,
          artist: id3v1.artist || fromFilename.artist,
          genre: id3v1.genre || fromFilename.genre,
          album: id3v1.album,
          bpm: fromFilename.bpm,
          key: fromFilename.key,
          source: "id3v1",
        };
      }
    }
  } catch {
    // Fall back to filename metadata if byte parsing fails
  }

  return fromFilename;
}

/**
 * Intelligent acoustic genre, mood, and vibe categorizer based on DSP audio analysis.
 */
export function categorizeTrackAcoustics(
  analysis: TrackAnalysis,
  parsedMeta?: Partial<ParsedAudioMetadata>
): TrackAcousticMetadata {
  const bpm = analysis.bpm;
  const energy = analysis.energy ?? 0.7;
  const wf = analysis.waveform;
  const rmsDb = analysis.rmsDb ?? -14;

  // 1. Determine Energy Tier
  let energyTier: EnergyTier = "Groove";
  if (energy < 0.40) energyTier = "Warmup";
  else if (energy < 0.65) energyTier = "Groove";
  else if (energy < 0.84) energyTier = "Peak Time";
  else energyTier = "Anthem";

  // 2. Spectral energy ratios if waveform exists
  let lowRatio = 0.45;
  let midRatio = 0.35;
  let highRatio = 0.20;
  if (wf) {
    let sLow = 0, sMid = 0, sHigh = 0;
    const n = wf.low.length;
    for (let i = 0; i < n; i++) {
      sLow += wf.low[i];
      sMid += wf.mid[i];
      sHigh += wf.high[i];
    }
    const sum = Math.max(1e-6, sLow + sMid + sHigh);
    lowRatio = sLow / sum;
    midRatio = sMid / sum;
    highRatio = sHigh / sum;
  }

  // 3. Acoustic Genre Auto-Classification (if ID3 is missing or generic)
  let genre = parsedMeta?.genre?.trim() || "";
  let parsedFromTag = true;

  if (
    !genre ||
    /^(audio|music|other|unknown|user stem|stem|custom|track)$/i.test(genre)
  ) {
    parsedFromTag = false;
    if (bpm >= 164) {
      genre = "Drum & Bass";
    } else if (bpm >= 138 && bpm < 164) {
      genre = lowRatio > 0.48 ? "Dubstep / Bass Music" : "Peak Techno";
    } else if (bpm >= 130 && bpm < 138) {
      genre = lowRatio > 0.46 ? "Hard Groove / Techno" : "Electro Breakbeat";
    } else if (bpm >= 125 && bpm < 130) {
      genre = lowRatio > 0.44 ? "Tech House" : "Club House";
    } else if (bpm >= 118 && bpm < 125) {
      genre = midRatio > 0.38 ? "Melodic Deep House" : "Deep House";
    } else if (bpm >= 108 && bpm < 118) {
      genre = "Nu-Disco / Indie Dance";
    } else if (bpm >= 80 && bpm < 108) {
      genre = "Hip-Hop / Boom-Bap";
    } else {
      genre = "Ambient / Downtempo";
    }
  }

  // 4. Acoustic Characteristic Tags
  const tags: string[] = [];
  if (lowRatio > 0.44) tags.push("Sub Heavy");
  if (midRatio > 0.37) tags.push("Melodic Lead");
  if (highRatio > 0.23) tags.push("Crisp Highs");
  if (bpm >= 120 && bpm <= 134) tags.push("4/4 Club Grid");
  else if (bpm >= 164 || (bpm >= 96 && bpm <= 108)) tags.push("Syncopated Breaks");

  if (rmsDb > -11) tags.push("High Density");
  else if (rmsDb < -16) tags.push("Dynamic Range");

  // 5. Harmonic Mood
  const isMinor = analysis.key?.endsWith("A") ?? true;
  const harmonicMood = isMinor ? "Dark & Driving (Minor)" : "Bright & Uplifting (Major)";
  const mood =
    energyTier === "Anthem"
      ? "Peak Festival Energy"
      : energyTier === "Peak Time"
        ? "Club Floor Filler"
        : energyTier === "Groove"
          ? "Hypnotic Rhythm"
          : "Warm Deep Atmosphere";

  return {
    genre,
    energyTier,
    tags,
    mood,
    harmonicMood,
    parsedFromTag,
  };
}

// =========================================================================
// INDEXEDDB PERSISTENCE (party_dj_crate_v2)
// =========================================================================
const DB_NAME = "PartyDjStudioCrateDB_v2";
const DB_VERSION = 1;
const STORE_NAME = "crate_tracks";

function openCrateDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      return reject(new Error("IndexedDB not supported in this environment"));
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: "id" });
        store.createIndex("bpm", "bpm", { unique: false });
        store.createIndex("key", "key", { unique: false });
        store.createIndex("genre", "genre", { unique: false });
        store.createIndex("energyTier", "energyTier", { unique: false });
        store.createIndex("dateAddedMs", "dateAddedMs", { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/**
 * Persists an analyzed track into the browser's IndexedDB crate cache.
 */
export async function persistTrackToIndexedDb(record: CrateIndexRecord): Promise<void> {
  try {
    const db = await openCrateDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      const store = tx.objectStore(STORE_NAME);
      const req = store.put(record);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  } catch {
    // Non-fatal if IndexedDB storage is unavailable
  }
}

/**
 * Loads all persisted tracks from IndexedDB.
 */
export async function loadPersistedCrateTracks(): Promise<CrateIndexRecord[]> {
  try {
    const db = await openCrateDb();
    return await new Promise<CrateIndexRecord[]>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readonly");
      const store = tx.objectStore(STORE_NAME);
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return [];
  }
}

/**
 * Deletes a single track from the persistent IndexedDB crate.
 */
export async function removeTrackFromIndexedDb(trackId: string): Promise<void> {
  try {
    const db = await openCrateDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      const store = tx.objectStore(STORE_NAME);
      const req = store.delete(trackId);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  } catch {
    // ignore
  }
}

/**
 * Clears all user-imported tracks from the persistent IndexedDB crate.
 */
export async function clearIndexedDbCrate(): Promise<void> {
  try {
    const db = await openCrateDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      const store = tx.objectStore(STORE_NAME);
      const req = store.clear();
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  } catch {
    // ignore
  }
}

// =========================================================================
// ADVANCED MULTI-TOKEN, RANGE & FUZZY SEARCH ENGINE
// =========================================================================

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const v0 = new Int32Array(b.length + 1);
  const v1 = new Int32Array(b.length + 1);
  for (let i = 0; i <= b.length; i++) v0[i] = i;
  for (let i = 0; i < a.length; i++) {
    v1[0] = i + 1;
    for (let j = 0; j < b.length; j++) {
      const cost = a[i] === b[j] ? 0 : 1;
      v1[j + 1] = Math.min(v1[j] + 1, v0[j + 1] + 1, v0[j] + cost);
    }
    for (let j = 0; j <= b.length; j++) v0[j] = v1[j];
  }
  return v1[b.length];
}

export interface CrateSearchResultItem<T> {
  item: T;
  relevanceScore: number;
  harmonicScore: number;
  harmonicLabel: string;
  matchedFields: string[];
}

export interface CrateSearchCandidate {
  id: string;
  name: string;
  artist: string;
  genre: string;
  tags?: string[];
  energyTier?: EnergyTier;
  analysis: TrackAnalysis;
  dateAddedMs?: number;
}

/**
 * Advanced multi-token query parser and fuzzy search engine.
 * Supports syntax like:
 * - `genre:house bpm:120-128 energy:>70%`
 * - `artist:sublevel`
 * - `key:8a` or `harmonic:active`
 * - `bpm:124+-3`
 * - free-text multi-token fuzzy matching
 */
export function searchAndFilterCrate<T extends CrateSearchCandidate>(
  tracks: T[],
  filters: CrateSearchFilters
): CrateSearchResultItem<T>[] {
  const q = (filters.query || "").trim().toLowerCase();
  const tokens = q.match(/(?:[^\s"]+|"[^"]*")+/g)?.map(t => t.replace(/^"|"$/g, "")) || [];

  const activeKey = filters.activeKey;
  const targetEnergy = filters.targetEnergy ?? 0.75;

  const results: CrateSearchResultItem<T>[] = [];

  for (const track of tracks) {
    const analysis = track.analysis;
    const cat = analysis.categorization;
    const bpm = analysis.bpm;
    const key = analysis.key || "";
    const energy = analysis.energy ?? 0.75;
    const genre = (track.genre || cat?.genre || "").toLowerCase();
    const artist = (track.artist || "").toLowerCase();
    const name = (track.name || "").toLowerCase();
    const tags = (track.tags || cat?.tags || []).map(t => t.toLowerCase());
    const tier = (track.energyTier || cat?.energyTier || "").toLowerCase();

    // 1. Harmonic match check
    const harm = evaluateHarmonicMatch(activeKey, key);
    if (filters.harmonicOnly && harm.score < 80) {
      continue;
    }

    // 2. Quick UI Category filter
    if (filters.genre && filters.genre !== "all") {
      const gFilter = filters.genre.toLowerCase();
      if (!genre.includes(gFilter) && !tags.some(t => t.includes(gFilter))) {
        continue;
      }
    }

    // 3. Energy tier filter
    if (filters.energyTier && filters.energyTier !== "all") {
      const filterTier = filters.energyTier.toLowerCase();
      if (tier !== filterTier) {
        continue;
      }
    }

    // 4. BPM min/max bounds filter
    if (filters.bpmMin !== undefined && bpm < filters.bpmMin) continue;
    if (filters.bpmMax !== undefined && bpm > filters.bpmMax) continue;

    // 5. Query token filtering & scoring
    let matchAll = true;
    let relevance = 0;
    const matchedFields: string[] = [];

    for (const token of tokens) {
      // Operator: bpm:120-130 or bpm:120..130 or bpm:>124 or bpm:<130 or bpm:124+-2
      if (token.startsWith("bpm:")) {
        const val = token.slice(4).trim();
        const rangeMatch = /^(\d+)[-..](\d+)$/.exec(val);
        const gtMatch = /^>(\d+)$/.exec(val);
        const ltMatch = /^<(\d+)$/.exec(val);
        const pmMatch = /^(\d+)(?:\+-|±)(\d+)$/.exec(val);

        if (rangeMatch) {
          const lo = parseFloat(rangeMatch[1]);
          const hi = parseFloat(rangeMatch[2]);
          if (bpm < lo || bpm > hi) { matchAll = false; break; }
          relevance += 15;
          matchedFields.push(`BPM ${lo}-${hi}`);
        } else if (gtMatch) {
          const th = parseFloat(gtMatch[1]);
          if (bpm <= th) { matchAll = false; break; }
          relevance += 12;
          matchedFields.push(`BPM >${th}`);
        } else if (ltMatch) {
          const th = parseFloat(ltMatch[1]);
          if (bpm >= th) { matchAll = false; break; }
          relevance += 12;
          matchedFields.push(`BPM <${th}`);
        } else if (pmMatch) {
          const center = parseFloat(pmMatch[1]);
          const tol = parseFloat(pmMatch[2]);
          if (Math.abs(bpm - center) > tol) { matchAll = false; break; }
          relevance += 18;
          matchedFields.push(`BPM ${center}±${tol}`);
        } else {
          const targetBpm = parseFloat(val);
          if (isNaN(targetBpm) || Math.abs(bpm - targetBpm) > 3.5) { matchAll = false; break; }
          relevance += 20;
          matchedFields.push(`BPM ~${targetBpm}`);
        }
        continue;
      }

      // Operator: key:8A
      if (token.startsWith("key:")) {
        const kVal = token.slice(4).toUpperCase().trim();
        if (key.toUpperCase() !== kVal) { matchAll = false; break; }
        relevance += 25;
        matchedFields.push(`Key ${kVal}`);
        continue;
      }

      // Operator: harmonic:8A or harmonic:active
      if (token.startsWith("harmonic:")) {
        const compareKey = token.slice(9).trim().toLowerCase() === "active" ? activeKey : token.slice(9).trim();
        const hMatch = evaluateHarmonicMatch(compareKey, key);
        if (hMatch.score < 80) { matchAll = false; break; }
        relevance += hMatch.score * 0.25;
        matchedFields.push(hMatch.label);
        continue;
      }

      // Operator: genre:house
      if (token.startsWith("genre:")) {
        const gVal = token.slice(6).trim();
        if (!genre.includes(gVal)) { matchAll = false; break; }
        relevance += 20;
        matchedFields.push(`Genre: ${gVal}`);
        continue;
      }

      // Operator: artist:sublevel
      if (token.startsWith("artist:")) {
        const aVal = token.slice(7).trim();
        if (!artist.includes(aVal)) { matchAll = false; break; }
        relevance += 22;
        matchedFields.push(`Artist: ${aVal}`);
        continue;
      }

      // Operator: title:warehouse
      if (token.startsWith("title:")) {
        const tVal = token.slice(6).trim();
        if (!name.includes(tVal)) { matchAll = false; break; }
        relevance += 22;
        matchedFields.push(`Title: ${tVal}`);
        continue;
      }

      // Operator: energy:>70% or energy:peak
      if (token.startsWith("energy:") || token.startsWith("tier:")) {
        const eVal = token.split(":")[1].trim();
        const num = parseFloat(eVal.replace(/[>%]/g, ""));
        if (!isNaN(num)) {
          const ratio = num > 1 ? num / 100 : num;
          if (energy < ratio - 0.05) { matchAll = false; break; }
          relevance += 15;
          matchedFields.push(`Energy >${Math.round(ratio * 100)}%`);
        } else {
          if (!tier.includes(eVal) && !(cat?.mood || "").toLowerCase().includes(eVal)) {
            matchAll = false;
            break;
          }
          relevance += 15;
          matchedFields.push(`Tier: ${eVal}`);
        }
        continue;
      }

      // Operator: tag:punchy or vibe:sub
      if (token.startsWith("tag:") || token.startsWith("vibe:")) {
        const tagVal = token.split(":")[1].trim();
        if (!tags.some(t => t.includes(tagVal))) { matchAll = false; break; }
        relevance += 18;
        matchedFields.push(`Tag: ${tagVal}`);
        continue;
      }

      // Free-text keyword match across fields
      let tokenMatched = false;
      if (name.includes(token)) {
        relevance += 25;
        tokenMatched = true;
        matchedFields.push("Title");
      }
      if (artist.includes(token)) {
        relevance += 20;
        tokenMatched = true;
        matchedFields.push("Artist");
      }
      if (genre.includes(token)) {
        relevance += 16;
        tokenMatched = true;
        matchedFields.push("Genre");
      }
      if (key.toLowerCase() === token) {
        relevance += 22;
        tokenMatched = true;
        matchedFields.push("Key");
      }
      if (Math.abs(bpm - parseFloat(token)) < 1.0) {
        relevance += 20;
        tokenMatched = true;
        matchedFields.push("BPM");
      }
      if (tags.some(t => t.includes(token))) {
        relevance += 14;
        tokenMatched = true;
        matchedFields.push("Tag");
      }
      if (tier.includes(token)) {
        relevance += 12;
        tokenMatched = true;
        matchedFields.push("Tier");
      }

      // Typo-tolerance check if no direct match and token length >= 4
      if (!tokenMatched && token.length >= 4) {
        const words = `${name} ${artist} ${genre}`.split(/[\s_-]+/);
        for (const word of words) {
          if (word.length >= 4 && levenshtein(token, word) <= 1) {
            relevance += 10;
            tokenMatched = true;
            matchedFields.push(`~${word}`);
            break;
          }
        }
      }

      if (!tokenMatched) {
        matchAll = false;
        break;
      }
    }

    if (!matchAll) continue;

    // Bonus for Camelot harmony and energy fit
    relevance += (harm.score * 0.25);
    const energyFit = 1 - Math.abs(energy - targetEnergy);
    relevance += (energyFit * 15);

    results.push({
      item: track,
      relevanceScore: +relevance.toFixed(2),
      harmonicScore: harm.score,
      harmonicLabel: harm.label,
      matchedFields,
    });
  }

  // Sorting
  const sortBy = filters.sortBy || "smart";
  results.sort((a, b) => {
    if (sortBy === "bpm-asc") return a.item.analysis.bpm - b.item.analysis.bpm;
    if (sortBy === "bpm-desc") return b.item.analysis.bpm - a.item.analysis.bpm;
    if (sortBy === "key") {
      const ka = a.item.analysis.key || "8A";
      const kb = b.item.analysis.key || "8A";
      const na = parseInt(ka, 10) + (ka.endsWith("B") ? 12 : 0);
      const nb = parseInt(kb, 10) + (kb.endsWith("B") ? 12 : 0);
      return na - nb;
    }
    if (sortBy === "energy-desc") return (b.item.analysis.energy ?? 0) - (a.item.analysis.energy ?? 0);
    if (sortBy === "energy-asc") return (a.item.analysis.energy ?? 0) - (b.item.analysis.energy ?? 0);
    if (sortBy === "title") return a.item.name.localeCompare(b.item.name);
    if (sortBy === "artist") return a.item.artist.localeCompare(b.item.artist);
    if (sortBy === "recent") return (b.item.dateAddedMs ?? 0) - (a.item.dateAddedMs ?? 0);
    // "smart"
    return b.relevanceScore - a.relevanceScore;
  });

  return results;
}
