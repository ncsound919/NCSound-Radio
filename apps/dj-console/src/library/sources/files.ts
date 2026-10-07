/**
 * Local file source (plan 4.2): drag-drop / file picker.
 *
 * Bytes are stored as Blobs in IndexedDB by the controller, keyed by track id.
 * Tags come from the existing `parseAudioFileMetadata` (ID3v1/v2, MP4).
 */
import { parseAudioFileMetadata } from "../../engine/crateIndexer";
import type { LibraryTrack } from "../types";
import { makeId } from "../hash";

const AUDIO_RE = /\.(mp3|wav|aiff?|flac|ogg|oga|m4a|aac|opus|webm)$/i;

export function isAudioFile(file: { name: string; type?: string }): boolean {
  return (file.type ?? "").startsWith("audio/") || AUDIO_RE.test(file.name);
}

export async function trackFromFile(file: File): Promise<LibraryTrack> {
  const meta = await parseAudioFileMetadata(file);
  const id = makeId("file", `${file.name}|${file.size}|${file.lastModified}`);
  return {
    id,
    source: "files",
    fileName: file.name,
    title: meta.title?.trim() || file.name.replace(/\.[a-z0-9]+$/i, ""),
    artist: meta.artist?.trim() || "Unknown artist",
    album: meta.album,
    size: file.size,
    lastModified: file.lastModified,
    durationSec: null,
    bpm: meta.bpm ?? null,
    key: meta.key ?? null,
    rating: 0,
    status: "unindexed",
    dateAddedMs: Date.now(),
  };
}

export async function tracksFromFiles(files: FileList | File[]): Promise<Array<{ track: LibraryTrack; file: File }>> {
  const out: Array<{ track: LibraryTrack; file: File }> = [];
  for (const file of Array.from(files)) {
    if (!isAudioFile(file)) continue;
    out.push({ track: await trackFromFile(file), file });
  }
  return out;
}
