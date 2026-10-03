/**
 * Entry point for the ingest service.
 *
 *   bun run --cwd packages/ingest start
 *
 * Defaults match the dev stack: Icecast on :8010, Liquidsoap harbor on :8008,
 * the station's own music library as the crate.
 */

import { IngestService } from "./server";

const PORT = Number(process.env.INGEST_PORT ?? 8099);
const HOST = process.env.INGEST_HOST ?? "127.0.0.1";
const LIBRARY = process.env.NCSOUND_LIBRARY ?? "../../library";
const TOKEN = process.env.INGEST_TOKEN;

const service = new IngestService({
  port: PORT,
  host: HOST,
  token: TOKEN,
  engine: {
    libraryDir: new URL(LIBRARY, import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"),
  },
  icecast: { port: Number(process.env.ICECAST_PORT ?? 8010) },
});

service.listen();
service.startStreamPolling();

await service.engine.start();

console.log(`ingest listening on http://${HOST}:${PORT}`);
console.log(`  GET  /health   /status   /stream   /crate`);
console.log(`  POST /command  ({"actor":{...},"command":{"type":"query.status"}})${TOKEN ? " [token required]" : ""}`);
console.log(`  WS   /ws`);
console.log(`  crate: ${service.engine.library.length} tracks`);

const shutdown = async () => {
  console.log("\ningest shutting down");
  await service.shutdown();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);