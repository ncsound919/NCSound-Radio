/**
 * Persistence for the library's non-analysis data: track metadata, uploaded
 * audio bytes, directory handles, crates and small key/value meta (Up Next,
 * session history, the played-session set).
 */
import type { CrateRecord, HistoryEntry, LibraryTrack } from "./types";
import { idbDelete, idbGet, idbGetAll, idbPut } from "./db";

const TRACKS = "tracks" as const;
const BLOBS = "blobs" as const;
const HANDLES = "handles" as const;
const CRATES = "crates" as const;
const META = "meta" as const;

/* ---------- tracks ---------- */
export function getAllTracks(): Promise<LibraryTrack[]> {
  return idbGetAll<LibraryTrack>(TRACKS);
}
export function putTrack(track: LibraryTrack): Promise<void> {
  return idbPut(TRACKS, track);
}
export function removeTrack(id: string): Promise<void> {
  return idbDelete(TRACKS, id);
}

/* ---------- uploaded audio bytes ---------- */
export function putTrackBlob(id: string, blob: Blob): Promise<void> {
  return idbPut(BLOBS, { id, blob });
}
export async function getTrackBlob(id: string): Promise<Blob | undefined> {
  const row = await idbGet<{ id: string; blob: Blob }>(BLOBS, id);
  return row?.blob;
}
export function removeTrackBlob(id: string): Promise<void> {
  return idbDelete(BLOBS, id);
}

/* ---------- directory handles ---------- */
export function putHandle(id: string, handle: FileSystemDirectoryHandle): Promise<void> {
  return idbPut(HANDLES, { id, handle });
}
export async function getHandle(id: string): Promise<FileSystemDirectoryHandle | undefined> {
  const row = await idbGet<{ id: string; handle: FileSystemDirectoryHandle }>(HANDLES, id);
  return row?.handle;
}

/* ---------- crates ---------- */
export function getCrates(): Promise<CrateRecord[]> {
  return idbGetAll<CrateRecord>(CRATES);
}
export function putCrate(crate: CrateRecord): Promise<void> {
  return idbPut(CRATES, crate);
}

/* ---------- key/value meta ---------- */
export function getMeta<T>(key: string): Promise<T | undefined> {
  return idbGet<{ key: string; value: T }>(META, key).then((r) => r?.value);
}
export function putMeta<T>(key: string, value: T): Promise<void> {
  return idbPut(META, { key, value });
}

export const META_QUEUE = "up-next";
export const META_HISTORY = "history";
export const META_PLAYED = "played-session";

export type MetaQueue = string[];
export type MetaHistory = HistoryEntry[];
