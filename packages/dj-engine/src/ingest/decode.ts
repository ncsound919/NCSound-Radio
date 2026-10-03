/**
 * Decodes audio files from disk into AudioBuffers for the mixer.
 *
 * node-web-audio-api has no file loading and its decodeAudioData coverage is
 * uneven across container formats, so this shells out to ffmpeg and reads raw
 * s16le PCM back. ffmpeg is already a dependency of the WSL Liquidsoap stack
 * and is on PATH on Windows.
 *
 * Decoded buffers are cached by (path, mtime) so a crate reloaded on a schedule
 * does not re-decode the whole library every cycle.
 */

import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { analyze } from "../engine/analysis";
import type { TrackAnalysis } from "@ncsound/station-core";

export type DecodedTrack = {
  path: string;
  /** Studio id, used as the TrackDTO id the station reports. */
  id: string;
  title: string;
  artist: string;
  durationSec: number;
  sampleRate: number;
  channels: number;
  buffer: AudioBuffer;
  analysis: TrackAnalysis | null;
};

export type DecodeOptions = {
  sampleRate?: number;
  channels?: number;
  ffmpeg?: string;
  timeoutMs?: number;
};

const FFMPEG = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";

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

/** Decode one file. Runs the real analyser so BPM/key are measured, not guessed. */
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

  const { artist, title } = splitName(path);
  return {
    path,
    id: idForPath(path),
    title,
    artist: artist || "Unknown artist",
    durationSec: frames / sampleRate,
    sampleRate,
    channels,
    buffer,
    analysis: safeAnalyze(buffer),
  };
}

function splitName(path: string): { artist: string; title: string } {
  const base = path.replace(/\\/g, "/").split("/").pop() ?? path;
  const stem = base.replace(/\.[^.]+$/, "");
  const m =
    stem.match(/^\s*\d+[.\-_ ]+(.+?)\s+-\s+(.+)$/) ??
    stem.match(/^(.+?)\s+-\s+(.+)$/);
  if (m) return { artist: m[1].trim(), title: m[2].trim() };
  return { artist: "", title: stem.replace(/_/g, " ").trim() };
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
};

const AUDIO_EXT = new Set([".mp3", ".wav", ".flac", ".ogg", ".oga", ".m4a", ".aac", ".opus", ".aiff", ".aif"]);

/** Decode every audio file in a directory. Failures are reported, not thrown. */
export async function loadCrate(
  ctx: BaseAudioContext,
  dir: string,
  opts: DecodeOptions = {},
): Promise<CrateLoadResult> {
  const { readdir } = await import("node:fs/promises");
  const entries = (await readdir(dir, { withFileTypes: true }))
    .filter((e) => e.isFile())
    .map((e) => e.name)
    .filter((n) => AUDIO_EXT.has(("." + n.split(".").pop()?.toLowerCase()) as string))
    .sort();

  const tracks: DecodedTrack[] = [];
  const failed: Array<{ path: string; error: string }> = [];
  for (const name of entries) {
    const path = `${dir}/${name}`.replace(/\\/g, "/");
    try {
      await stat(path);
      tracks.push(await decodeTrack(ctx, path, opts));
    } catch (err) {
      failed.push({ path, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return { tracks, failed };
}
