/**
 * Entry point for the ingest service.
 *
 *   bun run --cwd packages/ingest start
 *
 * Defaults match the dev stack: Icecast on :8010, Liquidsoap harbor on :8008,
 * and the operator's own music library as the crate.
 */

import { IngestService } from "./server";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PORT = Number(process.env.INGEST_PORT ?? 8099);
const HOST = process.env.INGEST_HOST ?? "127.0.0.1";

/** The real music library. Overridable for a different crate. */
const LIBRARY = process.env.NCSOUND_LIBRARY ?? "C:/Users/User/Music/music";

/**
 * Analysis cache, so a 66-track library is analysed once rather than every boot.
 *
 * fileURLToPath, not import.meta.url pathname: the path form leaves spaces
 * percent-encoded, which produced a literal "%20and%20DJ" directory name.
 */
const CACHE_DIR =
  process.env.NCSOUND_CACHE_DIR ??
  resolve(dirname(fileURLToPath(import.meta.url)), "../../../.ncsound-cache");

const service = new IngestService({
  port: PORT,
  host: HOST,
  token: process.env.INGEST_TOKEN,
  engine: {
    libraryDir: LIBRARY,
    analysisCacheDir: CACHE_DIR,
  },
  icecast: { port: Number(process.env.ICECAST_PORT ?? 8010) },
});

service.listen();
service.startStreamPolling();

console.log(`loading library ${LIBRARY} …`);
const startedAt = Date.now();
await service.engine.start();

console.log(`ingest listening on http://${HOST}:${PORT}`);
console.log(`  GET  /health   /status   /stream   /crate   /listeners/history`);
console.log(`  POST /command  ({"actor":{...},"command":{"type":"query.status"}})${process.env.INGEST_TOKEN ? " [token required]" : ""}`);
console.log(`  WS   /ws`);
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