/**
 * Library search, sort and harmonic matching (plan 4.5, 4.6).
 *
 * Pure functions over `LibraryTrack[]` so they can be unit-tested without a
 * browser. The query parser understands free text plus `bpm:120-126`,
 * `120-126`, `key:8A` and a bare Camelot key.
 */
import { evaluateHarmonicMatch } from "@ncsound/dj-engine/sync";
import type { LibraryTrack } from "./types";

export type LibrarySort = "artist" | "title" | "bpm" | "key" | "time" | "status" | "added";

export type MatchTarget = { bpm: number; key?: string } | null;

export type LibraryQuery = {
  text: string;
  matchesOnly: boolean;
  sort: LibrarySort;
  desc: boolean;
  target?: MatchTarget;
};

export type ScoredTrack = {
  track: LibraryTrack;
  /** Within ±6% of the target BPM and harmonically compatible, when a target exists. */
  matches: boolean;
  harmonicLabel: string;
  bpmDeltaPct: number | null;
};

export type ParsedQuery = {
  terms: string[];
  bpmMin?: number;
  bpmMax?: number;
  key?: string;
};

const CAMELOT = /^(?:[1-9]|1[0-2])[ab]$/i;

export function parseQuery(text: string): ParsedQuery {
  const terms: string[] = [];
  let bpmMin: number | undefined;
  let bpmMax: number | undefined;
  let key: string | undefined;

  for (const raw of text.trim().split(/\s+/)) {
    if (!raw) continue;
    const token = raw.toLowerCase();

    const keyOp = /^key:(\S+)$/.exec(token);
    if (keyOp && CAMELOT.test(keyOp[1])) {
      key = keyOp[1].toUpperCase();
      continue;
    }

    const bpmOp = /^bpm:(\d{2,3})(?:\s*[-.~]\s*(\d{2,3}))?$/.exec(token);
    if (bpmOp) {
      const lo = Number(bpmOp[1]);
      if (bpmOp[2]) {
        bpmMin = lo;
        bpmMax = Number(bpmOp[2]);
      } else {
        bpmMin = lo - 2;
        bpmMax = lo + 2;
      }
      continue;
    }

    const range = /^(\d{2,3})\s*[-~]\s*(\d{2,3})$/.exec(token);
    if (range) {
      bpmMin = Number(range[1]);
      bpmMax = Number(range[2]);
      continue;
    }

    if (CAMELOT.test(token)) {
      key = token.toUpperCase();
      continue;
    }

    terms.push(token);
  }

  return { terms, bpmMin, bpmMax, key };
}

/** ±6% window, matching plan 4.6. */
export const MATCH_PCT = 0.06;

export function matchInfo(track: LibraryTrack, target: MatchTarget): { matches: boolean; harmonicLabel: string; bpmDeltaPct: number | null } {
  if (!target || !track.bpm) return { matches: false, harmonicLabel: "", bpmDeltaPct: null };
  const bpmDeltaPct = (track.bpm - target.bpm) / target.bpm;
  const withinTempo = Math.abs(bpmDeltaPct) <= MATCH_PCT;
  const harm = evaluateHarmonicMatch(target.key, track.key ?? undefined);
  const compatible = harm.tier === "perfect" || harm.tier === "harmonic" || harm.tier === "energy-boost";
  return { matches: withinTempo && compatible, harmonicLabel: harm.label, bpmDeltaPct };
}

function textMatches(track: LibraryTrack, terms: string[]): boolean {
  if (!terms.length) return true;
  const hay = `${track.artist} ${track.title} ${track.fileName}`.toLowerCase();
  return terms.every((t) => hay.includes(t));
}

export function filterTracks(tracks: LibraryTrack[], query: LibraryQuery): ScoredTrack[] {
  const parsed = parseQuery(query.text);
  const out: ScoredTrack[] = [];

  for (const track of tracks) {
    if (!textMatches(track, parsed.terms)) continue;
    if (parsed.key && (track.key ?? "").toUpperCase() !== parsed.key) continue;
    if (parsed.bpmMin !== undefined && (track.bpm ?? -1) < parsed.bpmMin) continue;
    if (parsed.bpmMax !== undefined && (track.bpm ?? 1e9) > parsed.bpmMax) continue;

    const info = matchInfo(track, query.target ?? null);
    if (query.matchesOnly && !info.matches) continue;
    out.push({ track, ...info });
  }

  const dir = query.desc ? -1 : 1;
  out.sort((a, b) => dir * compare(a.track, b.track, query.sort));
  return out;
}

const STATUS_ORDER = { ready: 0, analysing: 1, queued: 2, unindexed: 3, failed: 4 } as const;

export function compare(a: LibraryTrack, b: LibraryTrack, sort: LibrarySort): number {
  switch (sort) {
    case "artist":
      return a.artist.localeCompare(b.artist) || a.title.localeCompare(b.title);
    case "title":
      return a.title.localeCompare(b.title);
    case "bpm":
      return (a.bpm ?? Infinity) - (b.bpm ?? Infinity);
    case "key":
      return camelotRank(a.key) - camelotRank(b.key);
    case "time":
      return (a.durationSec ?? Infinity) - (b.durationSec ?? Infinity);
    case "status":
      return STATUS_ORDER[a.status] - STATUS_ORDER[b.status];
    case "added":
      return a.dateAddedMs - b.dateAddedMs;
  }
}

/** Sort key: number then A before B, with unknown keys last. */
export function camelotRank(key: string | null): number {
  if (!key) return 1e6;
  const m = /^(\d{1,2})([AB])$/.exec(key.toUpperCase());
  if (!m) return 1e6;
  return Number(m[1]) * 2 + (m[2] === "B" ? 1 : 0);
}
