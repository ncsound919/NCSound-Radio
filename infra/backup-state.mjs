#!/usr/bin/env node
/**
 * Back up the station's private state (roadmap E3).
 *
 * Three things live only on this machine and would be painful to lose:
 *
 *   1. the operator site's SQLite database (tracks, play log, requests,
 *      submissions, sponsor ledger) — `apps/station-web/db/custom.db`;
 *   2. the ingest session file (who holds a host/guest credential);
 *   3. the ingest audit file (who minted, revoked, armed or killed).
 *
 * The database is snapshotted with SQLite's own online-backup API
 * (`node:sqlite`'s `backup()`), not a file copy: a plain `cp` of a database in
 * WAL mode can capture a torn page set, and the copy opens fine until it does
 * not. The backup API takes a consistent snapshot of a live database.
 *
 * Output is one timestamped directory per run, rotated to the newest `--keep`
 * runs. State files are copied verbatim; the database is re-created.
 *
 * Usage (from anywhere):
 *   node infra/backup-state.mjs
 *   node infra/backup-state.mjs --out D:\ncsound-backups --keep 30
 *   node infra/backup-state.mjs --db apps/station-web/db/custom.db --state state/audit.jsonl
 *
 * Environment fallbacks:
 *   NCSOUND_STATION_DB      the SQLite file, when --db is not given
 *   DATABASE_URL            `file:…`, resolved as Prisma resolves it (against
 *                           apps/station-web/prisma)
 *   INGEST_SESSIONS_FILE    added to the state-file set
 *   INGEST_AUDIT_FILE       added to the state-file set
 *   NCSOUND_BACKUP_DIR      output directory, when --out is not given
 *
 * Exit codes: 0 ok, 1 failure, 2 usage error. It prints a JSON summary on the
 * last line so a scheduler can parse the result.
 */

import { backup, DatabaseSync } from "node:sqlite";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const DEFAULT_DB = "apps/station-web/db/custom.db";
const DEFAULT_OUT = "backups";
const DEFAULT_KEEP = 14;
const STAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}$/;

function usageError(message) {
  console.error(`backup-state: ${message}`);
  console.error("usage: node infra/backup-state.mjs [--out DIR] [--keep N] [--db FILE] [--state FILE ...] [--quiet]");
  process.exit(2);
}

function parseArgs(argv) {
  const opts = { state: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (value === undefined) usageError(`${arg} needs a value`);
      i += 1;
      return value;
    };
    switch (arg) {
      case "--out": opts.out = next(); break;
      case "--keep": opts.keep = Number(next()); break;
      case "--db": opts.db = next(); break;
      case "--state": opts.state.push(next()); break;
      case "--quiet": opts.quiet = true; break;
      case "--help": case "-h": usageError("help requested"); break;
      default:
        if (arg.startsWith("--")) usageError(`unknown option ${arg}`);
        opts.state.push(arg);
    }
  }
  if (opts.keep !== undefined && (!Number.isInteger(opts.keep) || opts.keep < 1)) {
    usageError("--keep must be a positive integer");
  }
  return opts;
}

/** Resolve the database path the way the station would, without guessing. */
function resolveDb(explicit) {
  if (explicit) return resolve(REPO_ROOT, explicit);
  const fromEnv = process.env.NCSOUND_STATION_DB;
  if (fromEnv && fromEnv.trim()) return resolve(REPO_ROOT, fromEnv.trim());
  const url = process.env.DATABASE_URL;
  if (url && url.startsWith("file:")) {
    // Prisma resolves a relative file: path against the schema directory.
    return resolve(REPO_ROOT, "apps/station-web/prisma", url.slice("file:".length));
  }
  return join(REPO_ROOT, DEFAULT_DB);
}

function stamp(date = new Date()) {
  return date.toISOString().slice(0, 19).replace(/[:.]/g, "-");
}

function keepNewest(outDir, keep) {
  if (!existsSync(outDir)) return [];
  const runs = readdirSync(outDir)
    .filter((name) => STAMP_RE.test(name) && statSync(join(outDir, name)).isDirectory())
    .sort()
    .reverse();
  const removed = [];
  for (const name of runs.slice(keep)) {
    rmSync(join(outDir, name), { recursive: true, force: true });
    removed.push(name);
  }
  return removed;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const dbPath = resolveDb(opts.db);
  const outDir = resolve(REPO_ROOT, opts.out ?? process.env.NCSOUND_BACKUP_DIR ?? DEFAULT_OUT);
  const keep = opts.keep ?? DEFAULT_KEEP;
  const log = opts.quiet ? () => {} : (...a) => console.error(...a);

  if (!existsSync(dbPath)) {
    throw new Error(`database not found: ${dbPath}`);
  }

  const stateFiles = [...opts.state];
  for (const key of ["INGEST_SESSIONS_FILE", "INGEST_AUDIT_FILE"]) {
    if (process.env[key]) stateFiles.push(process.env[key]);
  }

  const destDir = join(outDir, stamp());
  mkdirSync(destDir, { recursive: true });

  const dbDest = join(destDir, basename(dbPath));
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    await backup(db, dbDest);
  } finally {
    db.close();
  }
  try { chmodSync(dbDest, 0o600); } catch { /* Windows: best effort */ }
  log(`db    -> ${dbDest}`);

  const copied = [dbDest];
  const missing = [];
  for (const file of stateFiles) {
    const abs = resolve(REPO_ROOT, file);
    if (!existsSync(abs)) { missing.push(file); continue; }
    const dest = join(destDir, basename(abs));
    copyFileSync(abs, dest);
    try { chmodSync(dest, 0o600); } catch { /* best effort */ }
    copied.push(dest);
    log(`state -> ${dest}`);
  }
  for (const file of missing) log(`state -> MISSING (skipped): ${file}`);

  const removed = keepNewest(outDir, keep);
  for (const name of removed) log(`pruned ${join(outDir, name)}`);

  const summary = {
    ok: true,
    at: new Date().toISOString(),
    db: dbDest,
    copied: copied.length,
    missing,
    out: outDir,
    pruned: removed,
    keep,
  };
  if (!opts.quiet) {
    console.log(`Backed up ${copied.length} file(s) to ${destDir}`);
  }
  console.log(JSON.stringify(summary));
}

main().catch((error) => {
  console.log(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
  process.exit(1);
});
