/**
 * Listener requests, read by the engine.
 *
 * `cue.request` had a schema, a dispatcher branch, and no implementation: the
 * dispatcher required a `resolveCueRequest` hook and the service never supplied
 * one, so every request answered `NO_SUCH_REQUEST`. The console meanwhile kept
 * its own in-memory list seeded by a SIMULATE REQUEST button, and the station
 * site kept a `TrackRequest` table nothing read. Three disconnected universes.
 *
 * This closes the gap. Requests are read straight from the station database
 * rather than through the station app's HTTP API, for two reasons: the DJ needs
 * to see requests even while Next.js is restarting, and adding a network hop
 * between the engine and the app that owns its data buys nothing here.
 *
 * The cost is that ingest now knows two column names. That coupling is
 * deliberate and narrow: it is read-only, it degrades to "no requests" rather
 * than to an error, and the query is the only SQL in the service.
 *
 * Unset `NCSOUND_STATION_DB` and this reports "no requests" instead of failing,
 * so an engine-only deployment is unaffected.
 */

import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";

export type RequestRow = {
  id: string;
  title: string;
  artist: string;
  listenerName: string;
  note: string | null;
  createdAt: string;
};

export type RequestStoreOptions = {
  /**
   * Path to the station's SQLite file.
   *
   * Accepts the same `file:` form as Prisma's `DATABASE_URL`. Relative paths
   * are resolved against the process's cwd, which for `bun run --cwd
   * packages/ingest start` is the repository root.
   */
  dbUrl?: string;
  /** Look back this far. Older requests have been declined or forgotten. */
  maxAgeHours?: number;
};

export function sqlitePathFromUrl(url: string): string | null {
  if (!url) return null;
  const raw = url.startsWith("file:") ? url.slice("file:".length) : url;
  if (!raw) return null;
  return raw.replace(/^\/\//, "/").replace(/^\\/, "");
}

export class RequestStore {
  private readonly path: string | null;
  private readonly maxAgeHours: number;
  private db: Database | null = null;

  constructor(opts: RequestStoreOptions = {}) {
    this.path = sqlitePathFromUrl(
      opts.dbUrl ?? process.env.NCSOUND_STATION_DB ?? process.env.DATABASE_URL ?? "",
    );
    this.maxAgeHours = opts.maxAgeHours ?? 72;
  }

  /** Why requests are unavailable, or null when the store is usable. */
  get unavailableReason(): string | null {
    if (!this.path) return "no station database configured (set NCSOUND_STATION_DB)";
    if (!existsSync(this.path)) return `station database not found at ${this.path}`;
    return null;
  }

  private open(): Database | null {
    if (this.unavailableReason) return null;
    if (this.db) return this.db;
    try {
      // Read-only: a request queue is something the engine observes, never edits.
      // Opening it writable would let a bug in the DJ console corrupt the
      // station's own data.
      this.db = new Database(this.path!, { readonly: true });
      return this.db;
    } catch {
      return null;
    }
  }

  close(): void {
    try {
      this.db?.close();
    } catch {
      /* already closed */
    }
    this.db = null;
  }

  /** Newest first. Empty when unavailable — never a fabricated list. */
  recent(limit = 20): RequestRow[] {
    const db = this.open();
    if (!db) return [];
    try {
      const since = new Date(Date.now() - this.maxAgeHours * 3600_000).toISOString();
      return db
        .query(
          `SELECT r.id AS id, t.title AS title, t.artist AS artist,
                  r.listenerName AS listenerName, r.note AS note, r.createdAt AS createdAt
             FROM TrackRequest r
             JOIN Track t ON t.id = r.trackId
            WHERE r.createdAt >= ?
            ORDER BY r.createdAt DESC
            LIMIT ?`,
        )
        .all(since, limit) as RequestRow[];
    } catch {
      // A schema change on the station side must not take the engine down.
      return [];
    }
  }

  /**
   * Match a request to a track in the engine's crate.
   *
   * The two sides key tracks differently: the station uses a Prisma cuid, the
   * engine uses a path-derived id, and a request can predate a crate rescan.
   * Title is the only field both reliably share, so it is matched
   * case-insensitively with whitespace collapsed, and the artist breaks ties.
   * Returns null rather than a guess — a wrong track is worse than no track.
   */
  resolveToCrateId(
    requestId: string,
    crate: { id: string; title: string; artist: string }[],
  ): string | null {
    const row = this.recent(200).find((r) => r.id === requestId);
    if (!row) return null;

    const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");
    const wanted = norm(row.title);
    const byTitle = crate.filter((t) => norm(t.title) === wanted);
    if (byTitle.length === 0) return null;
    if (byTitle.length === 1) return byTitle[0].id;

    const wantedArtist = norm(row.artist);
    const byBoth = byTitle.find((t) => norm(t.artist) === wantedArtist);
    return byBoth?.id ?? null;
  }
}
