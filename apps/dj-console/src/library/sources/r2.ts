/**
 * R2 source (Cloudflare integration, phase 2).
 *
 * The music library in Cloudflare R2. The catalog comes from the `ncsound-api`
 * Worker (`GET /library`, which lists the bucket); the bytes stream from the
 * same Worker (`/audio/<key>`, Range-capable). There is no local disk in the
 * path, so this is the same library from any machine.
 */
import type { LibraryTrack } from "../types";
import { makeId } from "../hash";

export type R2ObjectItem = {
  key: string;
  fileName: string;
  album: string | null;
  size: number;
  uploaded: string;
  contentType: string | null;
};

const AUDIO_RE = /\.(mp3|wav|aiff?|flac|ogg|oga|m4a|aac|opus|webm)$/i;
const API_KEY = "ncsound.console.r2.api";
const TOKEN_KEY = "ncsound.console.r2.token";

export const DEFAULT_R2_API = "https://ncsound-api.tap4500.workers.dev";

export class R2Unavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "R2Unavailable";
  }
}

function read(key: string, fallback: string): string {
  try {
    return (localStorage.getItem(key) || fallback).replace(/\/+$/, "");
  } catch {
    return fallback;
  }
}

export const r2ApiBase = (): string => read(API_KEY, DEFAULT_R2_API);

/** The Worker's LIBRARY_TOKEN, kept only in this browser. Empty = Worker is open. */
export const r2Token = (): string => read(TOKEN_KEY, "");
export function setR2Token(token: string): void {
  try {
    if (token.trim()) localStorage.setItem(TOKEN_KEY, token.trim());
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* private mode: the token lasts until reload */
  }
}
export function r2Headers(): Record<string, string> {
  const t = r2Token();
  return t ? { authorization: `Bearer ${t}` } : {};
}

export async function fetchR2Catalog(api = r2ApiBase()): Promise<R2ObjectItem[]> {
  let res: Response;
  try {
    res = await fetch(`${api}/library`, { headers: { accept: "application/json", ...r2Headers() }, cache: "no-store" });
  } catch (e) {
    throw new R2Unavailable(
      `R2 library unavailable: ncsound-api is not reachable (${e instanceof Error ? e.message : "network error"}).`,
    );
  }
  if (res.status === 401) throw new R2Unavailable("R2 library refused: set the R2 token in Settings.");
  if (!res.ok) throw new R2Unavailable(`R2 library unavailable: ncsound-api replied ${res.status}.`);
  const body = (await res.json()) as { objects?: unknown };
  if (!Array.isArray(body.objects)) throw new R2Unavailable("R2 library returned an unexpected payload.");
  return (body.objects as R2ObjectItem[]).filter((o) => typeof o?.key === "string" && AUDIO_RE.test(o.key));
}

/** Audio is served by the Worker (Range support, token gate), not the rate-limited r2.dev URL. */
export function r2AudioUrl(key: string, api = r2ApiBase()): string {
  return `${api}/audio/${key.split("/").map(encodeURIComponent).join("/")}`;
}

function deriveTitleArtist(fileName: string): { title: string; artist: string } {
  const stem = fileName.replace(/\.[a-z0-9]+$/i, "");
  const parts = stem.split(" - ");
  if (parts.length >= 2) {
    return { artist: parts[0].trim() || "Unknown artist", title: parts.slice(1).join(" - ").trim() || stem };
  }
  return { artist: "Unknown artist", title: stem };
}

function albumOf(key: string): string | null {
  const segments = key.split("/");
  if (segments.length >= 3 && segments[0].toLowerCase() === "music") return segments[1] || null;
  if (segments.length >= 2) return segments[0] || null;
  return null;
}

export function r2Track(item: R2ObjectItem): LibraryTrack {
  const { title, artist } = deriveTitleArtist(item.fileName);
  const uploaded = Date.parse(item.uploaded);
  return {
    id: makeId("r2", item.key),
    source: "r2",
    r2Key: item.key,
    fileName: item.fileName,
    path: item.key,
    title,
    artist,
    album: albumOf(item.key) ?? undefined,
    size: item.size,
    lastModified: Number.isFinite(uploaded) ? uploaded : 0,
    durationSec: null,
    bpm: null,
    key: null,
    rating: 0,
    status: "unindexed",
    dateAddedMs: Date.now(),
  };
}
