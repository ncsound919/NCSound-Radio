#!/usr/bin/env node
/**
 * Station health check (roadmap E4).
 *
 * Reads ingest's `/status` — the one place that aggregates the engine, the mount
 * watchdog and the Icecast verdicts — and exits non-zero when the station is not
 * actually on air. Built to run on a schedule (Windows Task Scheduler / cron):
 *
 *   node infra/health-check.mjs
 *   node infra/health-check.mjs --webhook https://hooks.example/ncsound
 *
 * Exit codes: 0 healthy, 1 unhealthy (not on air, or the mount is silent),
 * 2 unreachable. Prints a JSON summary on the last line so a scheduler parses it.
 *
 * With `--webhook` (or HEALTH_WEBHOOK) it POSTs the same summary, so a monitor
 * or a Cloudflare notification relay can alert. The edge half of E4 — alerting
 * on the Workers themselves — is Cloudflare Observability + Notifications; this
 * covers the part Cloudflare cannot see (the local mount/engine).
 *
 * Reads are loopback by default; set INGEST_URL/INGEST_TOKEN to poll a remote
 * ingest through the tunnel.
 */

const BASE = (process.env.INGEST_URL ?? "http://127.0.0.1:8099").replace(/\/+$/, "");
const TOKEN = process.env.INGEST_TOKEN?.trim() || null;

function parseWebhook(argv) {
  const i = argv.indexOf("--webhook");
  return process.env.HEALTH_WEBHOOK ?? (i >= 0 ? argv[i + 1] : null);
}

async function post(webhook, summary) {
  if (!webhook) return;
  try {
    await fetch(webhook, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(summary),
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    /* a dead webhook must not change the health verdict */
  }
}

async function main() {
  const webhook = parseWebhook(process.argv.slice(2));
  let res;
  try {
    res = await fetch(`${BASE}/status`, {
      headers: { accept: "application/json", ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}) },
      cache: "no-store",
      signal: AbortSignal.timeout(5000),
    });
  } catch (e) {
    const summary = { ok: false, reachable: false, at: new Date().toISOString(), error: e instanceof Error ? e.message : String(e) };
    await post(webhook, summary);
    console.log(JSON.stringify(summary));
    process.exit(2);
  }

  const body = await res.json().catch(() => null);
  if (!body) {
    // A 404 / non-JSON means we are not talking to ingest at all — most likely
    // the port is held by another process, or ingest is not running. Reporting
    // "unreachable" is the honest verdict; "on air but sick" would not be.
    const summary = {
      ok: false,
      reachable: false,
      at: new Date().toISOString(),
      error: `no ingest at ${BASE} (answered ${res.status}) — is ingest running, or is the port held by another process?`,
    };
    await post(webhook, summary);
    console.log(JSON.stringify(summary));
    process.exit(2);
  }

  const broadcast = body.broadcast ?? {};
  const watchdog = (body.watchdog ?? {}).last ?? null;
  const stream = body.stream ?? {};
  const listeners = body.listeners ?? null;

  const onAir = broadcast.onAir === true;
  const silent = watchdog?.verdict === "silent";
  const unhealthy = !onAir || silent;

  const summary = {
    ok: !unhealthy,
    reachable: true,
    at: new Date().toISOString(),
    onAir,
    reason: broadcast.reason ?? null,
    watchdog: watchdog?.verdict ?? null,
    streamOnAir: stream.onAir ?? null,
    listeners,
  };
  await post(webhook, summary);
  console.log(JSON.stringify(summary));
  process.exit(unhealthy ? 1 : 0);
}

main();
