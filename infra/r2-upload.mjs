/**
 * Upload a local audio library to an R2 bucket, preserving the folder tree.
 *
 * Uses `wrangler r2 object put` (the authenticated OAuth token; no S3 keys) with
 * bounded concurrency and per-file logging. For a large library, an R2 S3 API
 * token + `rclone copy` is faster and resumable; this exists so the dump needs
 * no extra credential.
 *
 *   node infra/r2-upload.mjs "<sourceDir>" <bucket> [prefix|-] [concurrency]
 */
import { exec } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const [, , sourceDir, bucket, prefixArg = "-", concArg = "6", filterArg = ""] = process.argv;
if (!sourceDir || !bucket) {
  console.error("usage: node infra/r2-upload.mjs <sourceDir> <bucket> [prefix|-] [concurrency] [filter]");
  process.exit(2);
}
const prefix = prefixArg && prefixArg !== "-" ? prefixArg.replace(/^\/+|\/+$/g, "") + "/" : "";
const concurrency = Math.max(1, Math.min(8, Number(concArg)));

/**
 * R2's API rejects keys containing ".." with 403 (path-traversal guard), so file
 * names like "A.R.T..mp3" or "Presents... The" cannot be stored verbatim. Collapse
 * each run of two or more dots to one, per path segment.
 */
const safeKey = (k) => k.split("/").map((seg) => seg.replace(/\.{2,}/g, ".")).join("/");

const AUDIO = /\.(mp3|wav|flac|m4a|aiff?|ogg|aac)$/i;
function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (AUDIO.test(name)) out.push(p);
  }
  return out;
}

const files = walk(sourceDir).filter((f) => (filterArg ? f.includes(filterArg) : true));
console.log(`${files.length} audio files under ${sourceDir}; -> ${bucket}/${prefix} concurrency ${concurrency}${filterArg ? ` filter="${filterArg}"` : ""}`);

let done = 0, failed = 0;
const failures = [];

function upload(src) {
  const key = safeKey(prefix + relative(sourceDir, src).split(sep).join("/"));
  const cmd = `bunx wrangler r2 object put "${bucket}/${key}" --file "${src}" --remote`;
  return new Promise((resolve) => {
    exec(cmd, { maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (err, _stdout, stderr) => {
      done++;
      if (err) {
        failed++;
        failures.push({ key, error: String(stderr || err).split("\n").slice(-2).join(" ").trim().slice(0, 200) });
        console.log(`[${done}/${files.length}] FAIL ${key} :: ${failures[failures.length - 1].error}`);
      } else {
        console.log(`[${done}/${files.length}] ok   ${key}`);
      }
      resolve();
    });
  });
}

async function run() {
  const queue = [...files];
  const workers = Array.from({ length: concurrency }, async () => {
    while (queue.length) {
      const src = queue.shift();
      if (src) await upload(src);
    }
  });
  await Promise.all(workers);
  console.log(`\nDONE: ${done - failed}/${files.length} uploaded, ${failed} failed`);
  if (failures.length) console.log("failures:", JSON.stringify(failures.slice(0, 20), null, 2));
  process.exitCode = failed ? 1 : 0;
}
void run();
