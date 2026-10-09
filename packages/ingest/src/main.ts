/**
 * Entry point for the ingest service.
 *
 *   bun run --cwd packages/ingest start
 *
 * Defaults match the dev stack: Icecast on :8010, Liquidsoap harbor on :8008,
 * and the operator's own music library as the crate.
 */

import { IngestService } from "./server";
import { createImagingPlayer } from "./imaging";
import { LiquidsoapControl } from "./liquidsoap";
import { dirname, resolve } from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const PORT = Number(process.env.INGEST_PORT ?? 8137);
const HOST = process.env.INGEST_HOST ?? "127.0.0.1";

/** The real music library. Overridable for a different crate. */
const LIBRARY = process.env.NCSOUND_LIBRARY ?? "C:/Users/User/Music/music";

/**
 * Station imaging (sweepers, stingers, ids) played over the master bus.
 *
 * Sits beside the library rather than inside it so a sweeper can never be
 * sequenced as if it were a track.
 */
const JINGLES = process.env.NCSOUND_JINGLES ?? resolve(LIBRARY, "..", "jingles");

/**
 * Analysis cache, so a 66-track library is analysed once rather than every boot.
 *
 * fileURLToPath, not import.meta.url pathname: the path form leaves spaces
 * percent-encoded, which produced a literal "%20and%20DJ" directory name.
 */
const CACHE_DIR =
  process.env.NCSOUND_CACHE_DIR ??
  resolve(dirname(fileURLToPath(import.meta.url)), "../../../.ncsound-cache");

/**
 * The harbor credential, from the same source Liquidsoap uses.
 *
 * Liquidsoap resolves `password=getenv("HARBOR_PASSWORD")`, and
 * `infra/station-up.sh` populates that from `infra/icecast/.env`. This process
 * runs on Windows, where that variable is normally absent, so it reads the file
 * directly rather than trusting its own environment — two sources of truth for one
 * credential is exactly how they drift apart.
 *
 * The value is never logged or returned. Only its origin is reported.
 */
const ICECAST_ENV_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "../../../infra/icecast/.env");

/** Read one credential from the environment, then from infra/icecast/.env. */
function readIcecastCredential(name: string): { value: string; source: string } | null {
  const fromEnv = process.env[name];
  if (fromEnv) return { value: fromEnv, source: name };

  try {
    const text = readFileSync(ICECAST_ENV_PATH, "utf8");
    const re = new RegExp(`^\\s*${name}\\s*=\\s*(.*)$`);
    for (const line of text.split(/\r?\n/)) {
      const m = re.exec(line);
      if (m) {
        const value = m[1].trim().replace(/^["']|["']$/g, "");
        if (value) return { value, source: "infra/icecast/.env" };
      }
    }
  } catch {
    /* not present; caller decides whether that is fatal */
  }
  return null;
}

/**
 * Refuse rather than fall back to a default.
 *
 * A default credential here is what produced a silent station: the engine
 * authenticated with a password nobody was listening for, got a 401, and every
 * other field kept reporting health. Starting without the credential fails
 * loudly instead.
 */
function resolveHarborPassword(): { password: string; source: string } {
  const cred = readIcecastCredential("HARBOR_PASSWORD");
  if (cred) return { password: cred.value, source: cred.source };
  throw new Error(
    `HARBOR_PASSWORD is not set and ${ICECAST_ENV_PATH} has no HARBOR_PASSWORD entry. ` +
      `The engine cannot upload to Liquidsoap without it. Set HARBOR_PASSWORD in the ` +
      `environment, or add it to infra/icecast/.env (see infra/station-up.sh).`,
  );
}

const harborCredential = resolveHarborPassword();
const harborPassword = harborCredential.password;
console.log(`  harbor password: from ${harborCredential.source}`);

/**
 * The console-live harbor password, from the same file Liquidsoap reads.
 *
 * The live bridge defaulted to `process.env.LIVE_HARBOR_PASSWORD ?? ""` and this
 * process normally has no such variable, so every live session built the URL
 * `icecast://live:@…/live` and Liquidsoap refused it — the same class of silent
 * 401 as the engine harbor, on the go-live path. Not fatal when absent (a
 * station with no console-live use is fine), so it is a warning, not a throw.
 */
const liveHarborCredential = readIcecastCredential("LIVE_HARBOR_PASSWORD");
console.log(
  liveHarborCredential
    ? `  live harbor password: from ${liveHarborCredential.source}`
    : "  live harbor password: not set — console go-live will fail until LIVE_HARBOR_PASSWORD is provided",
);

/**
 * The station database, for the listener request queue.
 *
 * A Postgres URL now (the station DB moved off SQLite). Optional: without it the
 * queue reports "unavailable", not "empty". Only the host is logged.
 */
const stationDbUrl =
  process.env.NCSOUND_STATION_DB ?? process.env.SUPABASE_DB_URL ?? process.env.DATABASE_URL;
if (stationDbUrl && /^postgres(ql)?:\/\//.test(stationDbUrl)) {
  let host = "configured";
  try { host = new URL(stationDbUrl).host; } catch { /* keep the label */ }
  console.log(`  station db: ${host} (listener request queue)`);
} else {
  console.log("  station db: not set — /requests will report unavailable (set NCSOUND_STATION_DB)");
}

// The off-air switch. Liquidsoap's telnet server is unauthenticated and must
// stay on loopback; this only ever dials 127.0.0.1.
const station = new LiquidsoapControl({
  host: process.env.LIQUIDSOAP_HOST,
  port: Number(process.env.LIQUIDSOAP_PORT ?? 1234),
  statePath: resolve(CACHE_DIR, "on-air.json"),
});

const service = new IngestService({
  port: PORT,
  host: HOST,
  token: process.env.INGEST_TOKEN,
  engine: {
    libraryDir: LIBRARY,
    analysisCacheDir: CACHE_DIR,
    /**
     * The harbor credential, read from the same file Liquidsoap reads.
     *
     * `HarborPublisher` defaulted to a hardcoded `"s3cret"`, which is how the
     * engine spent hours uploading into a `401`: Liquidsoap takes its password
     * from `infra/icecast/.env`, and this process had no idea. Every rendered
     * block went nowhere, harbor sat at `need more buffering (0/529200)`, and the
     * station broadcast silence while the engine reported itself healthy.
     *
     * The value is never logged — only where it came from.
     */
    harbor: {
      password: harborPassword,
    },
    // Two ingests publishing to one Liquidsoap harbor fight over the same
    // mount. Set NCSOUND_PUBLISH=0 for a second, non-broadcasting instance —
    // useful for exercising the control plane against the real library without
    // interrupting a station that is already on air.
    publish: process.env.NCSOUND_PUBLISH !== "0",
  },
  // Public listener counts come from the Icecast that listeners actually
  // connect to. On the station PC that is the loopback Icecast; in production
  // the stream is served by a VPS Icecast relay over TLS, so this points there.
  // See decision D10 in docs/MOBILE-LISTENER-APP-IMPLEMENTATION.md.
  icecast: {
    host: process.env.ICECAST_STATUS_HOST ?? "127.0.0.1",
    port: Number(process.env.ICECAST_STATUS_PORT ?? process.env.ICECAST_PORT ?? 8010),
    user: process.env.ICECAST_STATUS_USER ?? "admin",
    password: process.env.ICECAST_STATUS_PASSWORD ?? "admin",
    tls: process.env.ICECAST_STATUS_TLS === "1",
  },
  station,
  // The console go-live bridge. Its password must match the `live` harbor in
  // ncsound.liq; without it every live session 401s (see above).
  live: liveHarborCredential ? { harbor: { password: liveHarborCredential.value } } : undefined,
});

// Required before commands run: without it `imaging.play` can only report that
// no imaging library is configured, which is what it always said.
service.attachImaging(JINGLES);

service.listen();

console.log(`loading library ${LIBRARY} …`);
const startedAt = Date.now();
await service.engine.start();

// Start polling only once the engine is up. Polling earlier produced a first
// sample taken while the engine was still "offline", which reported onAir:false
// and made the station page show standby with no stream URL for a whole poll
// interval after the stream was already live.
service.startStreamPolling();

/**
 * Watch the delivery path itself.
 *
 * Started after the engine so the first sample is not taken against an empty
 * crate, and after the mount is known to exist. This is the check that would
 * have caught the five hours of silence: every engine-side field agreed with
 * itself while the mount carried nothing.
 */
service.attachWatchdog({
  mountUrl:
    process.env.NCSOUND_MOUNT_URL ??
    `http://127.0.0.1:${process.env.ICECAST_PORT ?? 8010}/live.mp3`,
});
console.log(
  process.env.NCSOUND_WATCHDOG === "0"
    ? "  watchdog: disabled (NCSOUND_WATCHDOG=0)"
    : `  watchdog: measuring ${process.env.NCSOUND_MOUNT_URL ?? "the /live.mp3 mount"} every ` +
      `${process.env.NCSOUND_WATCHDOG_INTERVAL ?? 30}s, recovering after ` +
      `${process.env.NCSOUND_WATCHDOG_STREAK ?? 3} silent samples`,
);

// Re-assert the remembered on-air state. Liquidsoap defaults `on_air` to true,
// so without this an off-air station comes back on the moment its daemon is
// restarted. Best-effort: if Liquidsoap is not up yet this logs and moves on,
// and the next `transport.stop` will set it correctly anyway.
void station
  .restore()
  .then(({ restored, to }) => {
    if (restored) console.log(`  on-air switch restored to ${to}`);
  })
  .catch(() => {
    /* reported through /status as station.onAir:null */
  });

console.log(`ingest listening on http://${HOST}:${PORT}`);
console.log(`  GET  /health   /status   /stream   /crate   /listeners/history`);
console.log(`  POST /command  ({"actor":{...},"command":{"type":"query.status"}})${process.env.INGEST_TOKEN ? " [token required]" : ""}`);
console.log(`  WS   /ws`);
console.log(`  imaging: ${JINGLES}`);
console.log(
  `  crate: ${service.engine.library.length} tracks in ${((Date.now() - startedAt) / 1000).toFixed(1)}s` +
    (service.engine.libraryFailures.length
      ? `, ${service.engine.libraryFailures.length} failed`
      : ""),
);
console.log(`  analysis cache: ${CACHE_DIR}`);

const shutdown = async () => {
  console.log("\ningest shutting down");
  await service.shutdown();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);