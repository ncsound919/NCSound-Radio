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
import { fileURLToPath } from "node:url";

const PORT = Number(process.env.INGEST_PORT ?? 8099);
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
    // Two ingests publishing to one Liquidsoap harbor fight over the same
    // mount. Set NCSOUND_PUBLISH=0 for a second, non-broadcasting instance —
    // useful for exercising the control plane against the real library without
    // interrupting a station that is already on air.
    publish: process.env.NCSOUND_PUBLISH !== "0",
  },
  icecast: { port: Number(process.env.ICECAST_PORT ?? 8010) },
  station,
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