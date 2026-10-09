/**
 * Listener requests, read from the station Postgres database.
 *
 * `cue.request` answered `NO_SUCH_REQUEST` for every request before this
 * existed, because the dispatcher required a `resolveCueRequest` hook that
 * nothing supplied. These tests pin the matching rules, and specifically the
 * cases where the honest answer is null.
 *
 * The station database is Postgres now, so these run against a local
 * `ncsound_test` (or `INGEST_TEST_DB`) and SKIP visibly when it is absent.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Client } from "pg";
import { RequestStore } from "../src/requests";

const TEST_DB =
  process.env.INGEST_TEST_DB ?? "postgresql://postgres:postgres@127.0.0.1:5433/ncsound_test";
const PREFIX = `reqtest_${Date.now()}_`;

let admin: Client | null = null;
let dbUp = false;
try {
  admin = new Client({ connectionString: TEST_DB });
  await admin.connect();
  await admin.query("select 1");
  dbUp = true;
} catch {
  dbUp = false;
  admin = null;
}

async function seed(): Promise<void> {
  if (!admin) return;
  const now = new Date();
  const old = new Date(Date.now() - 200 * 3600_000);
  const base = 900_000 + (Date.now() % 90_000);
  await admin.query(
    `INSERT INTO "public"."Track" ("id","title","artist","durationSec","explicit","playlist","seedOrder","createdAt")
     VALUES ($1,'Queen City Nights','MARLO Vaun',200,false,'Test',$2,$3),
            ($4,'TAR HEEL TELECAST','Chapel Trae',180,false,'Test',$5,$3)`,
    [`${PREFIX}t1`, base, now, `${PREFIX}t2`, base + 1],
  );
  await admin.query(
    `INSERT INTO "public"."TrackRequest" ("id","trackId","listenerName","note","createdAt")
     VALUES ($1,$2,'Rae','drop the bass',$3), ($4,$5,'Sam',NULL,$3), ($6,$2,'Ghost',NULL,$7)`,
    [`${PREFIX}r1`, `${PREFIX}t1`, now, `${PREFIX}r2`, `${PREFIX}t2`, `${PREFIX}rold`, old],
  );
}

async function cleanup(): Promise<void> {
  if (!admin) return;
  await admin.query(`DELETE FROM "public"."TrackRequest" WHERE "id" LIKE $1`, [`${PREFIX}%`]);
  await admin.query(`DELETE FROM "public"."Track" WHERE "id" LIKE $1`, [`${PREFIX}%`]);
}

beforeAll(async () => {
  if (dbUp) await seed();
});
afterAll(async () => {
  await cleanup();
  try {
    await admin?.end();
  } catch {
    /* already closed */
  }
});

describe("listener request store (Postgres)", () => {
  test("reports why it is unavailable rather than an empty list", async () => {
    const noUrl = new RequestStore({ dbUrl: "" });
    expect(noUrl.unavailableReason).toContain("NCSOUND_STATION_DB");
    expect(await noUrl.recent()).toEqual([]);
  });

  test.skipIf(!dbUp)("reads requests newest first and drops ones outside the window", async () => {
    const store = new RequestStore({ dbUrl: TEST_DB });
    const ids = (await store.recent(50)).map((r) => r.id).filter((id) => id.startsWith(PREFIX));
    expect(ids.sort()).toEqual([`${PREFIX}r1`, `${PREFIX}r2`].sort());
    // `${PREFIX}rold` is 200h old; the default window is 72h.
    expect(ids).not.toContain(`${PREFIX}rold`);
    await store.close();
  });

  test.skipIf(!dbUp)("resolves a request to a crate track", async () => {
    const store = new RequestStore({ dbUrl: TEST_DB });
    const crate = [
      { id: "A", title: "Queen City Nights", artist: "MARLO Vaun" },
      { id: "B", title: "TAR HEEL TELECAST", artist: "Chapel Trae" },
    ];
    expect(await store.resolveToCrateId(`${PREFIX}r1`, crate)).toBe("A");
    expect(await store.resolveToCrateId(`${PREFIX}r2`, crate)).toBe("B");
    await store.close();
  });

  test.skipIf(!dbUp)("matching ignores case and stray whitespace", async () => {
    const store = new RequestStore({ dbUrl: TEST_DB });
    // Real crates carry tags and casing the station's copy does not.
    const crate = [{ id: "A", title: "  QUEEN   CITY NIGHTS ", artist: "MARLO VAUN" }];
    expect(await store.resolveToCrateId(`${PREFIX}r1`, crate)).toBe("A");
    await store.close();
  });

  test.skipIf(!dbUp)("returns null rather than guessing", async () => {
    const store = new RequestStore({ dbUrl: TEST_DB });
    const crate = [{ id: "A", title: "Queen City Nights", artist: "MARLO Vaun" }];
    expect(await store.resolveToCrateId("no-such-request", crate)).toBeNull();
    // Known request, but the track is not in the crate. Playing a near-match
    // would put the wrong record on air in front of the listener who asked.
    expect(await store.resolveToCrateId(`${PREFIX}r2`, crate)).toBeNull();
    // Outside the freshness window.
    expect(await store.resolveToCrateId(`${PREFIX}rold`, crate)).toBeNull();
    await store.close();
  });

  test.skipIf(!dbUp)("breaks a same-title tie on artist", async () => {
    const store = new RequestStore({ dbUrl: TEST_DB });
    const crate = [
      { id: "WRONG", title: "Queen City Nights", artist: "Someone Else" },
      { id: "RIGHT", title: "Queen City Nights", artist: "MARLO Vaun" },
    ];
    expect(await store.resolveToCrateId(`${PREFIX}r1`, crate)).toBe("RIGHT");
    await store.close();
  });
});
