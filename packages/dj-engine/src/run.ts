/**
 * Runs the headless engine and publishes into Liquidsoap.
 *
 *   bun packages/dj-engine/src/run.ts
 *
 * Stays in the foreground. Ctrl-C shuts down cleanly.
 */

import { HeadlessEngine } from "./engine-service";

const engine = new HeadlessEngine({
  sampleRate: 48000,
  harbor: {
    host: process.env.HARBOR_HOST ?? "127.0.0.1",
    port: Number(process.env.HARBOR_PORT ?? 8008),
    mount: process.env.HARBOR_MOUNT ?? "dj",
    user: process.env.HARBOR_USER ?? "engine",
    password: process.env.HARBOR_PASSWORD ?? "REDACTED",
  },
});

async function main(): Promise<void> {
  await engine.start();

  const harbor = engine.harbor?.status;
  console.log("engine started");
  console.log("  state      :", engine.status.state);
  console.log("  sampleRate :", engine.status.telemetry?.sampleRate);
  console.log("  nowPlaying :", engine.nowPlayingTitle);
  console.log("  harbor     :", harbor ? `connected=${harbor.connected}` : "disabled");

  setInterval(() => {
    const t = engine.status.telemetry;
    const h = engine.harbor?.status;
    const db = t && Number.isFinite(t.masterPeakDb) ? t.masterPeakDb.toFixed(1) : "-inf";
    console.log(
      `[engine] peak=${db}dBFS frames=${engine.harbor?.status.framesSent ?? 0} ` +
        `bytes=${h?.bytesSent ?? 0} harbor=${h?.connected ?? false} err=${h?.lastError ?? "none"}`,
    );
  }, 5000);
}

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n${signal} received, shutting down`);
  await engine.close();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

main().catch((err) => {
  console.error("engine failed to start:", err);
  process.exit(1);
});
