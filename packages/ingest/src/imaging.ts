/**
 * Station imaging for the headless engine.
 *
 * `imaging.play` has been in the contract since day one, but the dispatcher
 * only ever returned "no imaging library is configured" because nothing in the
 * repository supplied a `playImaging` implementation. The console could not
 * have used one anyway: sweepers were synthesised in the browser and played
 * only through the local booth graph, so a sweeper fired from the console
 * never reached the stream.
 *
 * This closes the loop. An imaging id resolves to a file under the configured
 * directory, is decoded once, and is laid over the engine's master bus with a
 * music duck. A missing directory or an unknown id throws with a message that
 * names what was searched, so the operator sees a real cause rather than a
 * generic failure.
 */

import { readdir, stat } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";
import { decodeTrack, type DecodeOptions, type HeadlessEngine } from "@ncsound/dj-engine";
import { CommandFailure } from "./commands";

const AUDIO_EXTENSIONS = new Set([
  ".mp3",
  ".wav",
  ".flac",
  ".ogg",
  ".oga",
  ".m4a",
  ".aac",
  ".opus",
  ".webm",
  ".aiff",
  ".aif",
]);

export type ImagingOptions = {
  engine: HeadlessEngine;
  /** Directory holding the station's sweepers, stingers and ids. */
  dir: string;
  /** Decode settings; must match the crate so ffmpeg is configured once. */
  decode?: DecodeOptions;
};

/** Returns the handler to hand to `IngestService` as `playImaging`. */
export function createImagingPlayer(opts: ImagingOptions): (jingleId: string) => Promise<void> {
  const dir = resolve(opts.dir);
  const buffers = new Map<string, AudioBuffer>();

  return async function playImaging(jingleId: string): Promise<void> {
    const wanted = jingleId.trim();
    if (!wanted) throw new CommandFailure("INVALID_PARAMS", "imaging id was empty");

    const path = await resolveImagingFile(dir, wanted);
    const cached = buffers.get(path);
    const buffer =
      cached ??
      (await decodeTrack(opts.engine.mixer.ctx, path, {
        ...opts.decode,
        // Jingles are not crate tracks: they must not be written into or read
        // from the analysis cache keyed by library-relative paths.
        cacheDir: undefined,
        readTags: false,
      })).buffer;
    if (!buffer) throw new CommandFailure("INTERNAL", `could not decode imaging file ${path}`);
    if (!cached) buffers.set(path, buffer);

    const fired = opts.engine.mixer.playJingle(buffer);
    if (!fired.ok) throw new CommandFailure("INTERNAL", fired.message);
  };
}

/** Map an imaging id to a file, or explain exactly what was searched. */
async function resolveImagingFile(dir: string, wanted: string): Promise<string> {
  let entries: string[];
  try {
    const info = await stat(dir);
    if (!info.isDirectory()) throw new Error("not a directory");
    entries = await readdir(dir);
  } catch {
    throw new CommandFailure(
      "INVALID_PARAMS",
      `no imaging library at ${dir} (set NCSOUND_JINGLES to a directory of mp3/wav files)`,
    );
  }

  const audio = entries.filter((name) => AUDIO_EXTENSIONS.has(extname(name).toLowerCase()));
  const norm = wanted.replace(/\\/g, "/").toLowerCase();
  const wantedStem = norm.replace(/\.[a-z0-9]+$/, "");
  const stem = (name: string) => name.toLowerCase().replace(/\.[a-z0-9]+$/, "");

  const exact = audio.find((name) => name.toLowerCase() === norm);
  const byStem = audio.find((name) => stem(name) === wantedStem);
  // The console's sweeper grid is keyed "sw-top-hour" while operators tend to
  // name the file "top-hour.mp3". Treat the `sw-` prefix as optional on either
  // side rather than making one of them always fail.
  const byLooseStem = audio.find(
    (name) => stem(name).replace(/^sw-/, "") === wantedStem.replace(/^sw-/, ""),
  );
  const match = exact ?? byStem ?? byLooseStem;

  if (!match) {
    const available = audio
      .map((name) => name.replace(/\.[a-z0-9]+$/i, ""))
      .sort()
      .slice(0, 20);
    throw new CommandFailure(
      "INVALID_PARAMS",
      `no imaging file for "${wanted}" in ${dir}` +
        (available.length ? `; available: ${available.join(", ")}` : "; directory has no audio files"),
    );
  }

  // `readdir` already confined this to `dir`; the guard keeps an id like
  // "../../secrets" from being accepted as a stem match after normalisation.
  const path = join(dir, match);
  if (!path.startsWith(dir + sep)) {
    throw new CommandFailure("INVALID_PARAMS", `imaging id "${wanted}" escapes the imaging directory`);
  }
  return path;
}


/**
 * The imaging library's playable files, for the console's pads.
 *
 * `id` is the file stem, which `imaging.play` resolves (exact name or stem).
 * An unset or unreadable directory reports why instead of an empty list, so
 * the console can say "no imaging library" rather than "no jingles".
 */
export async function listImaging(dir: string | null): Promise<{ items: Array<{ id: string; file: string }>; reason: string | null }> {
  if (!dir) return { items: [], reason: "no imaging library configured (set NCSOUND_JINGLES)" };
  try {
    const names = await readdir(resolve(dir));
    const items = names
      .filter((n) => AUDIO_EXTENSIONS.has(extname(n).toLowerCase()))
      .sort((a, b) => a.localeCompare(b))
      .map((file) => ({ id: file.replace(/\.[^.]+$/, ""), file }));
    return { items, reason: items.length ? null : `no audio files in ${resolve(dir)}` };
  } catch {
    return { items: [], reason: `imaging directory not readable: ${resolve(dir)}` };
  }
}
