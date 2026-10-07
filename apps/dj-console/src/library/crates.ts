/**
 * Up Next queue, crates and export (plan 4.8, 4.9).
 *
 * Pure transforms; the controller persists the results. Exports are M3U8 for
 * players and CSV for a radio log.
 */
import type { HistoryEntry, LibraryTrack } from "./types";

export function enqueue(queue: string[], id: string): string[] {
  return queue.includes(id) ? queue : [...queue, id];
}

export function dequeueAt(queue: string[], index: number): string[] {
  if (index < 0 || index >= queue.length) return queue;
  return queue.filter((_, i) => i !== index);
}

/** The head of the queue, or null when empty. */
export function nextUp(queue: string[]): string | null {
  return queue.length ? queue[0] : null;
}

/** Absolute `#EXTINF` duration in seconds, or -1 when unknown (M3U8 convention). */
export function toM3U8(tracks: Array<Pick<LibraryTrack, "fileName" | "path" | "durationSec">>): string {
  const lines = ["#EXTM3U"];
  for (const t of tracks) {
    const title = (t.path ?? t.fileName).replace(/\.[a-z0-9]+$/i, "");
    lines.push(`#EXTINF:${t.durationSec != null ? Math.round(t.durationSec) : -1},${title}`);
    lines.push(t.path ?? t.fileName);
  }
  return `${lines.join("\n")}\n`;
}

function csvCell(v: string | number): string {
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toHistoryCsv(entries: HistoryEntry[]): string {
  const rows = [["played_at", "artist", "title", "bpm", "key", "duration_sec", "file"]];
  for (const e of entries) {
    rows.push([
      new Date(e.startedAtMs).toISOString(),
      e.artist,
      e.title,
      e.bpm ? e.bpm.toFixed(1) : "",
      e.key,
      e.durationSec ? e.durationSec.toFixed(1) : "",
      e.fileName,
    ]);
  }
  return `${rows.map((r) => r.map(csvCell).join(",")).join("\n")}\n`;
}

/** Filename like `ncsound-crate-20261006-2130.m3u8`. */
export function exportName(prefix: string, ext: string, now = new Date()): string {
  const stamp = now.toISOString().slice(0, 16).replace(/[-:T]/g, "");
  return `ncsound-${prefix}-${stamp}.${ext}`;
}
