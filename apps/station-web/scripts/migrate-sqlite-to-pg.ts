/**
 * One-off ETL: copy the station's data from the old SQLite file into Postgres.
 *
 *   DATABASE_URL=postgresql://… bun scripts/migrate-sqlite-to-pg.ts
 *
 * Idempotent: every row is inserted with `skipDuplicates`, so re-running after a
 * partial failure finishes the job instead of duplicating. Prisma stores
 * DateTime in SQLite as integer epoch-milliseconds and Boolean as 0/1, so both
 * are converted before the Postgres insert.
 *
 * The SQLite file is read with `bun:sqlite` (read-only); the destination is the
 * generated Prisma client, which points at whatever `DATABASE_URL` names.
 */
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { PrismaClient } from "@prisma/client";

const sqlitePath = process.env.SQLITE_PATH ?? resolve(import.meta.dir, "..", "db", "custom.db");
if (!existsSync(sqlitePath)) {
  console.error(`No SQLite file at ${sqlitePath} — set SQLITE_PATH or nothing to migrate.`);
  process.exit(1);
}

const sq = new Database(sqlitePath, { readonly: true });
const db = new PrismaClient();

/** Insert order respects foreign keys. */
const MODELS = [
  "Artist",
  "Show",
  "StationSetting",
  "Track",
  "Submission",
  "Sponsor",
  "Campaign",
  "AdPlay",
  "PlayLog",
  "TrackRequest",
] as const;

const DATETIME: Record<string, string[]> = {
  Artist: ["createdAt"],
  Show: [],
  StationSetting: [],
  Track: ["createdAt"],
  Submission: ["agreementAcceptedAt", "reviewedAt", "createdAt"],
  Sponsor: ["startAt", "endAt"],
  Campaign: ["startAt", "endAt"],
  AdPlay: ["playedAt"],
  PlayLog: ["playedAt"],
  TrackRequest: ["createdAt"],
};

const BOOLEAN: Record<string, string[]> = {
  Submission: ["explicit"],
  Show: ["explicit", "active"],
  Track: ["explicit"],
  Campaign: ["active"],
};

const delegate = (model: string) => model[0].toLowerCase() + model.slice(1);

const toDate = (v: unknown): Date | null =>
  v === null || v === undefined ? null : typeof v === "number" ? new Date(v) : new Date(String(v));

async function main() {
  for (const model of MODELS) {
    const rows = sq.query(`select * from "${model}"`).all() as Record<string, unknown>[];
    const data = rows.map((row) => {
      const out: Record<string, unknown> = { ...row };
      for (const col of DATETIME[model] ?? []) out[col] = toDate(row[col]);
      for (const col of BOOLEAN[model] ?? []) out[col] = row[col] === 1 || row[col] === true || row[col] === "1";
      return out;
    });
    if (data.length === 0) {
      console.log(`${model.padEnd(16)} 0 (nothing to copy)`);
      continue;
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await (db as any)[delegate(model)].createMany({ data, skipDuplicates: true });
    console.log(`${model.padEnd(16)} ${res.count}/${data.length} inserted`);
  }
}

main()
  .then(() => db.$disconnect())
  .catch(async (e) => {
    console.error("ETL failed:", e);
    await db.$disconnect();
    process.exit(1);
  });
