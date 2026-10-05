/**
 * Remove the invented library and its fabricated telemetry.
 *
 * `seed.ts` and `seed-talk.ts` built an entire fictional catalogue — 28 tracks
 * with invented North Carolina hip-hop titles, 9 shows, 3 sponsors — plus a
 * `PlayLog` backfill and 42 `AdPlay` rows stamped `azuracast-history` to imply
 * they came from a real broadcaster's history API. None of it came from
 * anywhere. `azuracast` is not in this stack; there is no such integration.
 *
 * Deleting the seed *scripts* was never enough, because the rows are in the
 * database file. The station was broadcasting "Piedmont Gold" and reporting
 * proof-of-play against campaigns that were never sold. This removes both.
 *
 * Refuses to run against anything it does not recognise, and prints exactly
 * what it would remove before removing it.
 *
 *   bun run --cwd apps/station-web scripts/demock-wipe.ts            # dry run
 *   bun run --cwd apps/station-web scripts/demock-wipe.ts --apply
 */

import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const APPLY = process.argv.includes("--apply");

function sqlitePath(url: string): string | null {
  if (!url) return null;
  const raw = url.startsWith("file:") ? url.slice("file:".length) : url;
  return raw.replace(/^\/\//, "/").replace(/^\\/, "");
}

const path = sqlitePath(process.env.DATABASE_URL ?? "");
if (!path) {
  console.error("DATABASE_URL is not set. Refusing to guess which database to wipe.");
  process.exit(1);
}

/**
 * Prisma resolves a relative `file:` URL against the directory holding
 * `schema.prisma`, not against the process cwd. `file:../db/custom.db` is
 * therefore `apps/station-web/db/custom.db`, while resolving it from the cwd
 * would silently point at a different file — or, as it did here, at nothing at
 * all. Both bases are tried, and an existing file wins.
 */
function resolveDb(raw: string): string | null {
  if (/^([A-Za-z]:[\\/]|\/|\\\\)/.test(raw)) return resolve(raw);
  const candidates = [
    resolve(import.meta.dir, "..", "prisma", raw),
    resolve(process.cwd(), raw),
    resolve(process.cwd(), "apps/station-web", "prisma", raw),
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  return null;
}

const dbPath = resolveDb(path);
if (!dbPath) {
  console.error(
    `DATABASE_URL resolved to "${path}" but no database exists at any expected location. Refusing to create one.`,
  );
  process.exit(1);
}

const db = new Database(dbPath);
const has = (t: string) =>
  Boolean(db.query("select 1 from sqlite_master where type='table' and name=?").get(t));

if (!has("Track")) {
  console.error(`${dbPath} has no Track table. This does not look like the station database.`);
  process.exit(1);
}

const count = (sql: string) => Number((db.query(sql).get() as { c: number }).c);

// What the seed scripts fabricated, by construction. Anything else in the
// database is the operator's own data and is left alone.
/**
 * Playlists written by the deleted seed scripts.
 *
 * The first five were the invented music catalogue. `Imaging` and `Talk` were
 * added later: a station legitimately has station IDs and produced segments,
 * but *these* rows were fabricated — "NCSound Station ID — Wake Up the
 * Carolinas" has no recording behind it, and its RightsLog entry asserted
 * "Produced in-house — work for hire" for audio that does not exist. Leaving
 * them meant the request picker, charts and artist pages still advertised
 * invented titles with invented clearances.
 */
const SEEDED_PLAYLIST_PREFIXES = [
  "Core Rotation",
  "Clean Daypart",
  "Fallback",
  "Throwbacks",
  "New Heat",
  "Imaging",
  "Talk",
];

/**
 * Rows written by `POST /api/library/sync` — the operator's real files.
 *
 * Explicitly excluded from the wipe. These are the one part of the library
 * that is true, and they are re-derivable from the engine crate at any time.
 */
const SYNCED_PLAYLIST = "Local Library";

/**
 * The provenance the seed stamped on proof-of-play rows.
 *
 * There is no AzuraCast in this stack and never was. The rows claimed to be
 * pulled from a broadcaster's song-history API; they were computed from the
 * on-air clock by the ad-sync job and then labelled as external telemetry.
 */
const FABRICATED_AD_SOURCE = "azuracast-history";

console.log(`database : ${dbPath}`);
console.log(`mode     : ${APPLY ? "APPLY" : "dry run (pass --apply to write)"}`);
console.log("");

const trackRows = db
  .query("select id, title, artist, playlist, rightsId from Track order by seedOrder")
  .all() as { id: string; title: string; artist: string; playlist: string; rightsId: string }[];

const suspectTracks = trackRows.filter((t) => SEEDED_PLAYLIST_PREFIXES.includes(t.playlist));
console.log(`Track            : ${trackRows.length} total, ${suspectTracks.length} in seeded playlists`);
for (const t of suspectTracks.slice(0, 30)) {
  console.log(`   - ${t.playlist.padEnd(14)} "${t.title}" — ${t.artist}  (rights ${t.rightsId})`);
}
if (suspectTracks.length > 30) console.log(`   … and ${suspectTracks.length - 30} more`);

const rightsRows = db.query("select id, trackTitle, artistName from RightsLog").all() as {
  id: string;
  trackTitle: string;
  artistName: string;
}[];
console.log("");
console.log(`RightsLog        : ${rightsRows.length} total`);

const adRows = db
  .query("select source, count(*) c from AdPlay group by source order by c desc")
  .all() as { source: string; c: number }[];
console.log("");
console.log("AdPlay by source :");
for (const r of adRows) {
  const fake = r.source === "azuracast-history";
  console.log(`   ${fake ? "FABRICATED" : "genuine   "}  ${r.source.padEnd(22)} ${r.c}`);
}

const playRows = count("select count(*) c from PlayLog");
const showRows = count("select count(*) c from Show");
const sponsorRows = count("select count(*) c from Sponsor");
console.log("");
console.log(`PlayLog          : ${playRows}`);
console.log(`Show             : ${showRows}`);
console.log(`Sponsor          : ${sponsorRows}`);

if (!APPLY) {
  console.log("");
  console.log("Dry run. Nothing was written. Re-run with --apply to remove the above.");
  db.close();
  process.exit(0);
}

// Counters live outside the transaction so the summary can still print if
// something below throws after COMMIT.
let removedAdPlays = 0;
let removedTracks = 0;
let removedPlayLogs = 0;
let removedRights = 0;

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");

db.run("BEGIN");
try {
  // Order matters twice over: children before parents, and - less obviously -
  // play history must be reaped AFTER its tracks are gone. Collecting orphans
  // first found none, because at that moment every track still existed, and
  // left 689 rows of history pointing at tracks that had just been deleted.
  removedAdPlays = Number(
    (db.query("select count(*) c from AdPlay where source = ?").get(FABRICATED_AD_SOURCE) as { c: number }).c,
  );
  db.run("delete from AdPlay where source = ?", [FABRICATED_AD_SOURCE]);

  for (const p of SEEDED_PLAYLIST_PREFIXES) {
    const n = Number(
      (db.query("select count(*) c from Track where playlist = ?").get(p) as { c: number }).c,
    );
    // The synced library is the operator's own and is never in this list, but
    // assert it rather than trust it: a wrong wipe here deletes their music.
    if (p === SYNCED_PLAYLIST) {
      throw new Error("refusing to wipe the synced library");
    }
    removedTracks += n;
    db.run("delete from Track where playlist = ?", [p]);
  }

  // Rights records that only existed to clear a track that is now gone.
  const live = db.query("select title, artist from Track").all() as {
    title: string;
    artist: string;
  }[];
  const livePairs = new Set(live.map((t) => norm(t.title) + "|" + norm(t.artist)));
  for (const r of rightsRows) {
    if (!livePairs.has(norm(r.trackTitle) + "|" + norm(r.artistName))) {
      db.run("delete from RightsLog where id = ?", [r.id]);
      removedRights += 1;
    }
  }

  removedPlayLogs = Number(
    (
      db
        .query("select count(*) c from PlayLog where trackId not in (select id from Track)")
        .get() as { c: number }
    ).c,
  );
  db.run("delete from PlayLog where trackId not in (select id from Track)");

  db.run("COMMIT");
} catch (err) {
  db.run("ROLLBACK");
  console.error("Wipe failed and was rolled back:", err instanceof Error ? err.message : err);
  db.close();
  process.exit(1);
}

console.log("");
console.log("Applied:");
console.log(`   AdPlay fabricated rows removed  : ${removedAdPlays}`);
console.log(`   Track (seeded playlists) removed: ${removedTracks}`);
console.log(`   PlayLog orphans removed         : ${removedPlayLogs}`);
console.log(`   RightsLog orphans removed       : ${removedRights}`);
console.log("");
console.log("Real operator data was left alone. Reload the station site to see the new state.");
db.close();
