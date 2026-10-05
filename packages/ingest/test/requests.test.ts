/**
 * Listener requests, read from the station database.
 *
 * `cue.request` answered `NO_SUCH_REQUEST` for every request before this
 * existed, because the dispatcher required a `resolveCueRequest` hook that
 * nothing supplied. These tests pin the matching rules, and specifically the
 * cases where the honest answer is null.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { RequestStore, sqlitePathFromUrl } from "../src/requests";

const fixtures: string[] = [];

function makeDb(): string {
  const path = join(tmpdir(), `ncsound-req-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  fixtures.push(path);
  const db = new Database(path);
  db.run(`CREATE TABLE Track (id TEXT PRIMARY KEY, title TEXT, artist TEXT)`);
  db.run(
    `CREATE TABLE TrackRequest (id TEXT PRIMARY KEY, trackId TEXT, listenerName TEXT, note TEXT, createdAt TEXT)`,
  );
  db.run(`INSERT INTO Track VALUES ('cuid-1','Queen City Nights','MARLO Vaun')`);
  db.run(`INSERT INTO Track VALUES ('cuid-2','TAR HEEL TELECAST','Chapel Trae')`);
  const now = new Date().toISOString();
  const old = new Date(Date.now() - 200 * 3600_000).toISOString();
  db.run(
    `INSERT INTO TrackRequest VALUES ('req-1','cuid-1','Rae','drop the bass',?),('req-2','cuid-2','Sam',NULL,?),('req-old','cuid-1','Ghost',NULL,?)`,
    [now, now, old],
  );
  db.close();
  return path;
}

afterEach(() => {
  for (const f of fixtures.splice(0)) {
    try {
      rmSync(f, { force: true });
    } catch {
      /* Windows may still hold it; the temp dir gets cleaned eventually */
    }
  }
});

describe("sqlite url handling", () => {
  test("strips the prisma file: prefix", () => {
    expect(sqlitePathFromUrl("file:./db/custom.db")).toBe("./db/custom.db");
    expect(sqlitePathFromUrl("file:../db/custom.db")).toBe("../db/custom.db");
  });

  test("returns null rather than a bogus path", () => {
    expect(sqlitePathFromUrl("")).toBeNull();
    expect(sqlitePathFromUrl("file:")).toBeNull();
    expect(sqlitePathFromUrl("postgresql://host/db")).toBe("postgresql://host/db");
  });
});

describe("listener request store", () => {
  test("reports why it is unavailable rather than an empty list", () => {
    const noUrl = new RequestStore({ dbUrl: "" });
    expect(noUrl.unavailableReason).toContain("NCSOUND_STATION_DB");
    expect(noUrl.recent()).toEqual([]);

    const missing = new RequestStore({ dbUrl: "file:/tmp/definitely-not-here.db" });
    expect(missing.unavailableReason).toContain("not found");
    expect(missing.recent()).toEqual([]);
  });

  test("reads requests newest first and drops ones outside the window", () => {
    const store = new RequestStore({ dbUrl: "file:" + makeDb() });
    const rows = store.recent(10);
    expect(rows.map((r) => r.id).sort()).toEqual(["req-1", "req-2"]);
    // req-old is 200h old; the default window is 72h.
    expect(rows.some((r) => r.id === "req-old")).toBe(false);
    expect(rows[0].listenerName).toBeTruthy();
    store.close();
  });

  test("resolves a request to a crate track", () => {
    const store = new RequestStore({ dbUrl: "file:" + makeDb() });
    const crate = [
      { id: "A", title: "Queen City Nights", artist: "MARLO Vaun" },
      { id: "B", title: "TAR HEEL TELECAST", artist: "Chapel Trae" },
    ];
    expect(store.resolveToCrateId("req-1", crate)).toBe("A");
    expect(store.resolveToCrateId("req-2", crate)).toBe("B");
    store.close();
  });

  test("matching ignores case and stray whitespace", () => {
    const store = new RequestStore({ dbUrl: "file:" + makeDb() });
    // Real crates carry tags and casing the station's copy does not.
    const crate = [{ id: "A", title: "  QUEEN   CITY NIGHTS ", artist: "MARLO VAUN" }];
    expect(store.resolveToCrateId("req-1", crate)).toBe("A");
    store.close();
  });

  test("returns null rather than guessing", () => {
    const store = new RequestStore({ dbUrl: "file:" + makeDb() });
    const crate = [{ id: "A", title: "Queen City Nights", artist: "MARLO Vaun" }];
    // Unknown request id.
    expect(store.resolveToCrateId("no-such-request", crate)).toBeNull();
    // Known request, but the track is not in the crate. Playing a near-match
    // would put the wrong record on air in front of the listener who asked.
    expect(store.resolveToCrateId("req-2", crate)).toBeNull();
    // Outside the freshness window.
    expect(store.resolveToCrateId("req-old", crate)).toBeNull();
    store.close();
  });

  test("breaks a same-title tie on artist", () => {
    const store = new RequestStore({ dbUrl: "file:" + makeDb() });
    const crate = [
      { id: "WRONG", title: "Queen City Nights", artist: "Someone Else" },
      { id: "RIGHT", title: "Queen City Nights", artist: "MARLO Vaun" },
    ];
    expect(store.resolveToCrateId("req-1", crate)).toBe("RIGHT");
    store.close();
  });

  test("a database missing the tables degrades to no requests", () => {
    // A station schema change must not take the engine down.
    const path = join(tmpdir(), `ncsound-empty-${Date.now()}.db`);
    fixtures.push(path);
    const db = new Database(path);
    db.run(`CREATE TABLE SomethingElse (id TEXT)`);
    db.close();
    const store = new RequestStore({ dbUrl: "file:" + path });
    expect(store.recent()).toEqual([]);
    expect(store.resolveToCrateId("req-1", [])).toBeNull();
    store.close();
  });
});
