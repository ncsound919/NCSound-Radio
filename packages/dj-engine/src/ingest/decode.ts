/**
 * Decodes audio files from disk into AudioBuffers for the mixer.
 *
 * node-web-audio-api has no file loading and its decodeAudioData coverage is
 * uneven across container formats, so this shells out to ffmpeg and reads raw
 * s16le PCM back. ffmpeg is already a dependency of the WSL Liquidsoap stack;
 * on Windows it is resolved through `NCSOUND_FFMPEG` (or must be on PATH),
 * because a bare `ffmpeg.exe` is not guaranteed to be installed.
 *
 * Memory is the constraint that shaped this file. A real library is not eight
 * short clips: 66 tracks decoded to 48 kHz stereo float32 is about 4.8 GB of
 * AudioBuffer, which does not fit alongside the rest of the station on a 16 GB
 * machine. So a track is described by its path and its analysis, and its PCM is
 * only materialised when a deck is about to play it.
 *
 * Analysis is cached to disk, because it needs the decoded buffer but does not
 * need to keep it. The first scan of a new library pays for the analysis; every
 * start after that reads small JSON files and decodes nothing until playback
 * asks for it.
 */

import { spawn } from "node:child_process";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { analyze } from "../engine/analysis";
import type { TrackAnalysis } from "@ncsound/station-core";

export type DecodedTrack = {
  path: string;
  /** Studio id, used as the TrackDTO id the station reports. */
  id: string;
  title: string;
  artist: string;
  album: string | null;
  durationSec: number;
  sampleRate: number;
  channels: number;
  /**
   * Decoded PCM, or null until materialised. Callers that hand a track to the
   * mixer must call materialize() first; a buffer left null here is the normal
   * state for a crate that is loaded but idle.
   */
  buffer: AudioBuffer | null;
  analysis: TrackAnalysis | null;
};

export type DecodeOptions = {
  sampleRate?: number;
  channels?: number;
  ffmpeg?: string;
  timeoutMs?: number;
  /** Directory for the on-disk analysis cache. Omit to disable caching. */
  cacheDir?: string;
  /** Library root, used to derive artist/album from the directory layout. */
  rootDir?: string;
  /** Probe embedded tags. Off skips 66 ffprobe spawns. */
  readTags?: boolean;
};

/**
 * Resolve an ffmpeg-family binary. `NCSOUND_FFMPEG` / `NCSOUND_FFPROBE` let a
 * portable build outside PATH be used; `ffprobe` falls back to a sibling of
 * `NCSOUND_FFMPEG` when only that is set.
 */
function resolveBinary(kind: "ffmpeg" | "ffprobe"): string {
  const exe = process.platform === "win32" ? ".exe" : "";
  const explicit =
    kind === "ffmpeg" ? process.env.NCSOUND_FFMPEG : process.env.NCSOUND_FFPROBE;
  if (explicit) return explicit;
  const ffmpeg = process.env.NCSOUND_FFMPEG;
  if (kind === "ffprobe" && ffmpeg) return ffmpeg.replace(/ffmpeg(\.exe)?$/i, `ffprobe${exe}`);
  return `${kind}${exe}`;
}

const FFMPEG = resolveBinary("ffmpeg");

export function idForPath(path: string): string {
  // Stable across runs so the station's PlayLog rows keep matching.
  let h = 5381;
  for (let i = 0; i < path.length; i++) h = ((h << 5) + h + path.charCodeAt(i)) >>> 0;
  return `t${h.toString(36)}`;
}

async function run(
  bin: string,
  args: string[],
  timeoutMs: number,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    const out: Buffer[] = [];
    let err = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`${bin} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on("data", (d) => out.push(d as Buffer));
    child.stderr.on("data", (d) => (err += d.toString()));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(new Error(`${bin} failed to start: ${e.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(`${bin} exited ${code}: ${err.slice(0, 300)}`));
      else resolve(Buffer.concat(out));
    });
  });
}

/** Decode one file's PCM. Runs the real analyser when no cached analysis exists. */
export async function decodeTrack(
  ctx: BaseAudioContext,
  path: string,
  opts: DecodeOptions = {},
): Promise<DecodedTrack> {
  const sampleRate = opts.sampleRate ?? ctx.sampleRate;
  const channels = opts.channels ?? 2;
  const bin = opts.ffmpeg ?? FFMPEG;
  const timeoutMs = opts.timeoutMs ?? 120_000;

  const raw = await run(
    bin,
    [
      "-v", "error",
      "-i", path,
      "-f", "s16le",
      "-acodec", "pcm_s16le",
      "-ac", String(channels),
      "-ar", String(sampleRate),
      "pipe:1",
    ],
    timeoutMs,
  );

  const bytesPerFrame = channels * 2;
  const frames = Math.floor(raw.length / bytesPerFrame);
  if (frames === 0) throw new Error(`decoded 0 frames from ${path}`);

  const buffer = ctx.createBuffer(channels, frames, sampleRate);
  for (let c = 0; c < channels; c++) {
    const view = new Int16Array(frames);
    for (let i = 0; i < frames; i++) {
      view[i] = raw.readInt16LE(i * bytesPerFrame + c * 2);
    }
    // AudioBuffer wants float samples in [-1, 1].
    const f = buffer.getChannelData(c);
    for (let i = 0; i < frames; i++) f[i] = view[i] / 32768;
  }

  const { artist, title, album } = await describeTrack(path, opts.rootDir ?? ".", opts.readTags !== false);
  const track: DecodedTrack = {
    path,
    id: idForPath(path),
    title,
    artist: artist || "Unknown artist",
    album,
    durationSec: frames / sampleRate,
    sampleRate,
    channels,
    buffer,
    analysis: null,
  };

  // Cache-first: a library analysed before is not re-analysed just because its
  // PCM had to be decoded again.
  const cached = opts.cacheDir ? await readMetaCache(path, opts.cacheDir) : null;
  track.analysis = cached?.analysis ?? safeAnalyze(buffer);

  if (opts.cacheDir && !cached) {
    await writeMetaCache(
      path,
      {
        analysis: track.analysis as TrackAnalysis,
        title: track.title,
        artist: track.artist,
        album: track.album,
        durationSec: track.durationSec,
      },
      opts.cacheDir,
    );
  }

  return track;
}

/**
 * Ensure a track has decoded PCM, decoding it if necessary.
 *
 * This is the call every mixer hand-off must go through. It is safe to call
 * repeatedly: a track that already has a buffer returns immediately.
 */
export async function materialize(
  track: DecodedTrack,
  ctx: BaseAudioContext,
  opts: DecodeOptions = {},
): Promise<DecodedTrack> {
  if (track.buffer) return track;
  const decoded = await decodeTrack(ctx, track.path, opts);
  // Keep the identity fields from the scan so a reload cannot renumber the set.
  track.durationSec = decoded.durationSec;
  track.sampleRate = decoded.sampleRate;
  track.channels = decoded.channels;
  track.buffer = decoded.buffer;
  track.analysis = decoded.analysis ?? track.analysis;
  return track;
}

/**
 * Everything cached per file, so a restart reads one small JSON per track
 * instead of decoding and re-analysing the whole library.
 */
type TrackMeta = {
  analysis: TrackAnalysis;
  title: string;
  artist: string;
  album: string | null;
  durationSec: number;
};

/**
 * Read embedded tags with ffprobe, returning null when the file carries none.
 *
 * Best-effort by design: plenty of real libraries have been produced by tools
 * that strip tags, and spawning ffprobe per file is only worth it once because
 * the result is cached alongside the analysis.
 */
async function probeTags(
  path: string,
): Promise<{ title?: string; artist?: string; album?: string } | null> {
  const bin = resolveBinary("ffprobe");
  let doc: { format?: { tags?: Record<string, string> } };
  try {
    const raw = await run(
      bin,
      ["-v", "error", "-show_entries", "format_tags", "-of", "json", path],
      10_000,
    );
    doc = JSON.parse(raw.toString()) as typeof doc;
  } catch {
    return null;
  }

  const tags = doc.format?.tags;
  if (!tags) return null;

  // ffprobe casing varies by container and tag version.
  const pick = (key: string) => {
    for (const k of [key, key.toLowerCase(), key.toUpperCase()]) {
      const v = tags[k];
      if (typeof v === "string" && v.trim()) return v.trim();
    }
    return undefined;
  };

  const title = pick("title");
  const artist = pick("artist");
  const album = pick("album");
  if (!title && !artist && !album) return null;
  return {
    ...(title ? { title } : {}),
    ...(artist ? { artist } : {}),
    ...(album ? { album } : {}),
  };
}

/**
 * Work out artist, album and title for a file.
 *
 * Order of preference, because each is right in a different real library:
 *   1. Embedded tags, when the file has them.
 *   2. <Artist>/<Album>/<Track>.mp3 directory layout. Filenames like
 *      "1.Intro.mp3" carry no artist at all and the folder is the only place
 *      the information exists - parsing the filename produced "Unknown artist"
 *      for every track in a library that was perfectly well organised.
 *   3. An "Artist - Title" filename pattern.
 *   4. The filename stem as the title.
 */
async function describeTrack(
  path: string,
  rootDir: string,
  useTags: boolean,
): Promise<{ title: string; artist: string; album: string | null }> {
  const norm = (p: string) => p.replace(/\\/g, "/");
  const root = norm(rootDir).replace(/\/+$/, "");
  const full = norm(path);
  const rel = full.startsWith(root) ? full.slice(root.length) : full;

  const parts = rel.split("/").filter(Boolean);
  const base = parts[parts.length - 1] ?? "";
  const stem = base.replace(/\.[^.]+$/, "");
  // Strip a leading track number: "01. Intro", "1 - Intro", "01_Intro".
  const stemNoNum = stem.replace(/^\s*\d+\s*[.\-_)\]]?\s*/, "");
  const titleFromName = (stemNoNum || stem).replace(/_/g, " ").trim();

  const albumDir = parts.length >= 2 ? parts[parts.length - 2] : null;
  const artistDir = parts.length >= 3 ? parts[parts.length - 3] : null;

  const m = stem.match(/^\s*\d+[.\-_ ]+(.+?)\s+-\s+(.+)$/) ?? stem.match(/^(.+?)\s+-\s+(.+)$/);

  const fallback = {
    title: titleFromName || (m?.[2]?.trim() ?? stem.trim()),
    artist: artistDir ?? m?.[1]?.trim() ?? "",
    album: albumDir,
  };

  if (!useTags) return fallback;
  const tags = await probeTags(path);
  if (!tags) return fallback;
  return {
    title: tags.title ?? fallback.title,
    artist: tags.artist ?? fallback.artist,
    album: tags.album ?? fallback.album,
  };
}

/**
 * Analysis is synchronous and main-thread and only reads the first 90s, so a
 * failed or very long track must not take the station down with it.
 */
function safeAnalyze(buffer: AudioBuffer): TrackAnalysis | null {
  try {
    return analyze(buffer);
  } catch {
    return null;
  }
}

export type CrateLoadResult = {
  tracks: DecodedTrack[];
  failed: Array<{ path: string; error: string }>;
  /** Set when the library root itself could not be read. */
  libraryError?: string;
};

/** The library root is missing or unreadable, as opposed to a bad file. */
export class LibraryUnreadableError extends Error {
  constructor(
    readonly dir: string,
    readonly cause: string,
  ) {
    super(`cannot read library directory ${dir}: ${cause}`);
    this.name = "LibraryUnreadableError";
  }
}

const AUDIO_EXT = new Set([".mp3", ".wav", ".flac", ".ogg", ".oga", ".m4a", ".aac", ".opus", ".aiff", ".aif"]);

function isAudioName(name: string): boolean {
  const ext = name.slice(name.lastIndexOf(".")).toLowerCase();
  return AUDIO_EXT.has(ext);
}

// ---- analysis cache -------------------------------------------------------

/** Cache key: file identity plus size and mtime, so an edited file re-analyses. */
async function analysisKey(path: string): Promise<string> {
  const s = await stat(path);
  return `${s.size.toString(36)}-${Math.floor(s.mtimeMs).toString(36)}`;
}

async function readMetaCache(path: string, cacheDir: string): Promise<TrackMeta | null> {
  try {
    const key = await analysisKey(path);
    const raw = await readFile(join(cacheDir, `${idForPath(path)}-${key}.json`), "utf8");
    const parsed = JSON.parse(raw) as TrackMeta;
    // A cache entry that cannot drive playback or sequencing is worse than none.
    if (typeof parsed?.analysis?.bpm !== "number") return null;
    if (typeof parsed?.analysis?.firstBeat !== "number") return null;
    if (typeof parsed?.title !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}

async function writeMetaCache(path: string, meta: TrackMeta, cacheDir: string): Promise<void> {
  try {
    const key = await analysisKey(path);
    await mkdir(cacheDir, { recursive: true });
    await writeFile(join(cacheDir, `${idForPath(path)}-${key}.json`), JSON.stringify(meta));
  } catch {
    /* the cache is an optimisation; never fail a load because of it */
  }
}

// ---- scanning -------------------------------------------------------------

/**
 * Walk a library directory for audio files.
 *
 * Recursive, because real music libraries are organised in artist/album
 * subfolders. The previous implementation filtered on `isFile()` at the top
 * level only, so a library of 66 tracks arranged in subdirectories reported
 * zero tracks and the station silently fell back to a single synthesised loop.
 */
export async function scanLibrary(
  ctx: BaseAudioContext,
  dir: string,
  opts: DecodeOptions = {},
): Promise<CrateLoadResult> {
  const found: string[] = [];

  async function walk(current: string): Promise<void> {
    let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch (err) {
      // A missing library is an operator error, not a crash. Throwing here
      // took the whole service down - a typo in the path meant no broadcast at
      // all, which is worse than broadcasting the fallback crate with the cause
      // recorded for ops to see.
      throw new LibraryUnreadableError(current, (err as Error).message);
    }
    // Sort within each level so the crate order is stable across runs.
    const sorted = [...entries].sort((a, b) => a.name.localeCompare(b.name));
    for (const e of sorted) {
      const full = join(current, e.name);
      if (e.isDirectory()) {
        await walk(full);
      } else if (e.isFile() && isAudioName(e.name)) {
        found.push(full.replace(/\\/g, "/"));
      }
    }
  }

  let libraryError: string | undefined;
  try {
    await walk(dir.replace(/[\\/]+$/, ""));
  } catch (err) {
    if (err instanceof LibraryUnreadableError) {
      libraryError = err.message;
    } else {
      throw err;
    }
  }

  const tracks: DecodedTrack[] = [];
  const failed: Array<{ path: string; error: string }> = [];

  for (const path of found) {
    try {
      const cached = opts.cacheDir ? await readMetaCache(path, opts.cacheDir) : null;

      if (cached) {
        // Everything the station needs for sequencing and display, no PCM held.
        tracks.push({
          path,
          id: idForPath(path),
          title: cached.title,
          artist: cached.artist,
          album: cached.album ?? null,
          durationSec: cached.durationSec,
          sampleRate: opts.sampleRate ?? ctx.sampleRate,
          channels: opts.channels ?? 2,
          buffer: null,
          analysis: cached.analysis,
        });
        continue;
      }

      // Cache miss: decode, analyse, describe, and keep the buffer. This is the
      // slow path and happens once per file for the life of the cache.
      tracks.push(await decodeTrack(ctx, path, opts));
    } catch (err) {
      failed.push({ path, error: err instanceof Error ? err.message : String(err) });
    }
  }

  return { tracks, failed, libraryError };
}

/** Backwards-compatible alias: scanning is now the crate load. */
export async function loadCrate(
  ctx: BaseAudioContext,
  dir: string,
  opts: DecodeOptions = {},
): Promise<CrateLoadResult> {
  return scanLibrary(ctx, dir, opts);
}
