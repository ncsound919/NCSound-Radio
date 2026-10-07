/**
 * Station source (plan 4.3): the engine's crate, read through ingest.
 *
 * `GET /crate` and `GET /crate/audio/<id>.wav` are loopback-only by design, so
 * this only works when the console runs on the station computer. Off-station it
 * reports that plainly instead of trying and failing.
 */
import type { LibraryTrack } from "../types";
import { makeId } from "../hash";

export type StationCrateItem = {
  id: string;
  title: string;
  artist: string;
  album: string | null;
  durationSec: number;
  bpm: number | null;
  key: string | null;
  path: string;
};

export class StationUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StationUnavailable";
  }
}

const BASE = "/ingest";

export async function fetchStationCrate(base = BASE): Promise<StationCrateItem[]> {
  let res: Response;
  try {
    res = await fetch(`${base}/crate`, { headers: { accept: "application/json" } });
  } catch (e) {
    throw new StationUnavailable(
      `Station library unavailable: ingest is not reachable (${e instanceof Error ? e.message : "network error"}).`,
    );
  }
  if (res.status === 403 || res.status === 401) {
    throw new StationUnavailable("Station library is only available on the station computer.");
  }
  if (!res.ok) throw new StationUnavailable(`Station library unavailable: ingest replied ${res.status}.`);
  const body = (await res.json()) as unknown;
  if (!Array.isArray(body)) throw new StationUnavailable("Station library returned an unexpected payload.");
  return body as StationCrateItem[];
}

export function stationAudioUrl(id: string, base = BASE): string {
  return `${base}/crate/audio/${encodeURIComponent(id)}.wav`;
}

export function stationTrack(item: StationCrateItem): LibraryTrack {
  return {
    id: makeId("station", item.id),
    source: "station",
    stationId: item.id,
    fileName: item.title ? `${item.artist} - ${item.title}` : item.id,
    path: item.path,
    title: item.title || item.id,
    artist: item.artist || "Unknown artist",
    album: item.album ?? undefined,
    size: 0,
    lastModified: 0,
    durationSec: item.durationSec || null,
    bpm: item.bpm ?? null,
    key: item.key ?? null,
    rating: 0,
    // The engine already analysed these; the console still runs its own pass
    // once the audio is fetched, because /crate carries no waveform.
    status: "unindexed",
    dateAddedMs: Date.now(),
  };
}
