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
 * The station database is now Postgres (Supabase). The read is still narrow and
 * read-only: two table names and five columns, degrading to "no requests" rather
 * than to an error, and it is the only SQL in the service.
 *
 * Unset `NCSOUND_STATION_DB` (a Postgres URL) — or `SUPABASE_DB_URL` /
 * `DATABASE_URL` — and this reports "no requests" instead of failing, so an
 * engine-only deployment is unaffected.
 */

import { Pool } from "pg";

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
   * A Postgres connection string for the station database (Supabase in
   * production). Falls back to `NCSOUND_STATION_DB`, `SUPABASE_DB_URL`, then
   * `DATABASE_URL`.
   */
  dbUrl?: string;
  /** Look back this far. Older requests have been declined or forgotten. */
  maxAgeHours?: number;
};

/**
 * TLS for the station database.
 *
 * Supabase's pooler presents a chain node-postgres treats as self-signed under
 * the default `sslmode=require`, so verification is relaxed for remote hosts.
 * Loopback (a local dev Postgres) needs no TLS.
 */
function sslFor(url: string): { rejectUnauthorized: boolean } | undefined {
  if (/sslmode=disable/.test(url)) return undefined;
  if (/@(127\.0\.0\.1|localhost)([:/]|$)/.test(url)) return undefined;
  return { rejectUnauthorized: false };
}

const isPostgresUrl = (raw: string): boolean => /^postgres(ql)?:\/\//.test(raw);

export class RequestStore {
  private readonly url: string | null;
  private readonly maxAgeHours: number;
  private pool: Pool | null = null;
  /**
   * Why the last query failed, if it did.
   *
   * A configured database whose tables are missing (or any SQL/connection
   * error) must leave `recent()` empty while `unavailableReason` becomes
   * non-null — otherwise the console shows "no requests" instead of
   * "unavailable", the exact distinction this module exists to preserve.
   */
  private lastQueryError: string | null = null;

  constructor(opts: RequestStoreOptions = {}) {
    const raw = (
      opts.dbUrl ??
      process.env.NCSOUND_STATION_DB ??
      process.env.SUPABASE_DB_URL ??
      process.env.DATABASE_URL ??
      ""
    ).trim();
    this.url = isPostgresUrl(raw) ? raw : null;
    this.maxAgeHours = opts.maxAgeHours ?? 72;
  }

  /** Whether the store is configured at all. */
  private configurationReason(): string | null {
    if (!this.url) return "no station database configured (set NCSOUND_STATION_DB to a Postgres URL)";
    return null;
  }

  /** Why requests are unavailable, or null when the store is usable. */
  get unavailableReason(): string | null {
    return this.configurationReason() ?? this.lastQueryError;
  }

  private ensurePool(): Pool | null {
    if (this.configurationReason()) return null;
    if (this.pool) return this.pool;
    try {
      const pool = new Pool({
        connectionString: this.url!,
        ssl: sslFor(this.url!),
        max: 2,
        connectionTimeoutMillis: 5000,
        // Read-only by intent; the engine observes the queue, never edits it.
      });
      // An idle client dropped by the pooler emits an error on the pool; left
      // unhandled that crashes the process on the next GC tick.
      pool.on("error", (err) => {
        this.lastQueryError = `station database connection error: ${err.message}`;
      });
      this.pool = pool;
      return pool;
    } catch (err) {
      this.lastQueryError = `station database could not be opened: ${err instanceof Error ? err.message : String(err)}`;
      return null;
    }
  }

  async close(): Promise<void> {
    const pool = this.pool;
    this.pool = null;
    if (pool) {
      try {
        await pool.end();
      } catch {
        /* already closed */
      }
    }
  }

  /** Newest first. Empty when unavailable — never a fabricated list. */
  async recent(limit = 20): Promise<RequestRow[]> {
    const pool = this.ensurePool();
    if (!pool) return [];
    try {
      const since = new Date(Date.now() - this.maxAgeHours * 3600_000);
      const res = await pool.query(
        `SELECT r."id" AS id, t."title" AS title, t."artist" AS artist,
                r."listenerName" AS listenerName, r."note" AS note, r."createdAt" AS createdAt
           FROM "public"."TrackRequest" r
           JOIN "public"."Track" t ON t."id" = r."trackId"
          WHERE r."createdAt" >= $1
          ORDER BY r."createdAt" DESC
          LIMIT $2`,
        [since, limit],
      );
      this.lastQueryError = null;
      return res.rows.map((r: Record<string, unknown>) => ({
        id: String(r.id),
        title: String(r.title),
        artist: String(r.artist),
        listenerName: String(r.listenerName),
        note: r.note == null ? null : String(r.note),
        createdAt: r.createdAt instanceof Date ? (r.createdAt as Date).toISOString() : String(r.createdAt),
      }));
    } catch (err) {
      // A schema change on the station side must not take the engine down, but
      // it must be visible: record it so /requests reports "unavailable".
      this.lastQueryError = `station database query failed: ${err instanceof Error ? err.message : String(err)}`;
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
  async resolveToCrateId(
    requestId: string,
    crate: { id: string; title: string; artist: string }[],
  ): Promise<string | null> {
    const row = (await this.recent(200)).find((r) => r.id === requestId);
    if (!row) return null;

    const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");
    const wanted = norm(row.title);
    const byTitle = crate.filter((t) => norm(t.title) === wanted);
    if (byTitle.length === 0) return null;
    if (byTitle.length === 1) return byTitle[0]!.id;

    const wantedArtist = norm(row.artist);
    const byBoth = byTitle.find((t) => norm(t.artist) === wantedArtist);
    return byBoth?.id ?? null;
  }
}
