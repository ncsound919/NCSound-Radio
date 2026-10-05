/**
 * The console's view of the station's music.
 *
 * The engine and the site now agree: the engine scans `NCSOUND_LIBRARY` and
 * the site mirrors that crate through `POST /api/library/sync`. The console
 * was the third copy, and a fourth thing entirely — it booted a synthesised
 * studio crate ("Midnight Warehouse" by "Sublevel 808") that exists nowhere
 * else, so the DJ was preparing a set from tracks the station does not have
 * and listeners will never hear.
 *
 * Two honest categories, never merged:
 *
 *  - **Engine crate** — the real library, read from `GET /ingest/crate`. This
 *    is what the station broadcasts. The booth cannot play these: they are
 *    files on the server's disk and the browser has no route to their audio.
 *  - **Booth tracks** — synthesised placeholders plus anything the DJ dropped
 *    in, playable locally for rehearsal. Clearly marked, never presented as
 *    station music.
 */

export type EngineCrateTrack = {
  id: string;
  title: string;
  artist: string;
  album: string | null;
  durationSec: number;
  bpm: number | null;
  key: string | null;
};

export type CrateSource = {
  tracks: EngineCrateTrack[];
  /** Why the list is empty, or null when it loaded. */
  error: string | null;
  loadedAt: string | null;
};

const EMPTY: CrateSource = { tracks: [], error: "not loaded yet", loadedAt: null };

/**
 * Read the engine's crate.
 *
 * Never resolves to a fabricated list. An unreachable engine and an empty
 * library are different states and the DJ needs to tell them apart before
 * planning a set.
 */
export async function fetchEngineCrate(signal?: AbortSignal): Promise<CrateSource> {
  try {
    const res = await fetch("/ingest/crate", { cache: "no-store", signal });
    if (!res.ok) {
      return { tracks: [], error: `ingest answered ${res.status}`, loadedAt: new Date().toISOString() };
    }
    const body = (await res.json()) as unknown;
    if (!Array.isArray(body)) {
      return { tracks: [], error: "ingest returned an unexpected crate shape", loadedAt: new Date().toISOString() };
    }
    const tracks = body.filter(isCrateTrack);
    return {
      tracks,
      error: null,
      loadedAt: new Date().toISOString(),
    };
  } catch (err) {
    return {
      tracks: [],
      error: err instanceof Error ? err.message : "could not reach the engine",
      loadedAt: new Date().toISOString(),
    };
  }
}

function isCrateTrack(value: unknown): value is EngineCrateTrack {
  if (typeof value !== "object" || value === null) return false;
  const t = value as Record<string, unknown>;
  return typeof t.id === "string" && typeof t.title === "string" && typeof t.artist === "string";
}

export function emptyCrateSource(): CrateSource {
  return EMPTY;
}

export function formatDuration(sec: number | null | undefined): string {
  if (sec == null || sec <= 0) return "--:--";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}
