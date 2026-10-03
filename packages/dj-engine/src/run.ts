/**
 * Runs the headless engine and publishes into Liquidsoap.
 *
 *   bun packages/dj-engine/src/run.ts
 *
 * Stays in the foreground. Ctrl-C shuts down cleanly.
 */

import { HeadlessEngine } from "./engine-service";
import type { PartyTemplate } from "@ncsound/station-core";

/**
 * Night drive: warm-up, build, peak, then ease off. The autopilot follows this
 * energy curve when choosing the next track.
 */
const DEFAULT_TEMPLATE: PartyTemplate = {
  id: "night-drive",
  name: "Night Drive",
  energyCurve: [0.45, 0.5, 0.58, 0.66, 0.74, 0.8, 0.72, 0.6, 0.5, 0.45],
  transition: "auto",
};

const LIBRARY_DIR = process.env.LIBRARY_DIR ?? "";

const engine = new HeadlessEngine({
  sampleRate: 48000,
  libraryDir: LIBRARY_DIR || undefined,
  template: DEFAULT_TEMPLATE,
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
  console.log("  library    :", engine.library.length, "tracks", LIBRARY_DIR ? `(${LIBRARY_DIR})` : "(built-in)");
  if (engine.libraryFailures.length) {
    console.log("  decode fail:", engine.libraryFailures.length);
    for (const f of engine.libraryFailures.slice(0, 3)) console.log("     ", f.path, "-", f.error);
  }
  console.log("  nowPlaying :", engine.nowPlayingTitle);
  console.log("  masterTrim :", engine.masterTrimDb.toFixed(2), "dB");
  console.log("  harbor     :", harbor ? `connected=${harbor.connected}` : "disabled");

  let lastTrack = engine.currentTrack?.id ?? null;
  setInterval(() => {
    const t = engine.status.telemetry;
    const h = engine.harbor?.status;
    const cur = engine.currentTrack;
    const db = t && Number.isFinite(t.masterPeakDb) ? t.masterPeakDb.toFixed(1) : "-inf";
    if (cur && cur.id !== lastTrack) {
      lastTrack = cur.id;
      console.log(
        `[engine] NOW PLAYING  ${cur.artist} - ${cur.title}` +
          (cur.bpm ? `  @${cur.bpm}bpm` : "") +
          `  next: ${engine.upNext[0]?.title ?? "(none armed)"}`,
      );
    }
    console.log(
      `[engine] peak=${db}dBFS trim=${engine.masterTrimDb.toFixed(1)}dB ` +
        `frames=${h?.framesSent ?? 0} harbor=${h?.connected ?? false} err=${h?.lastError ?? "none"}`,
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
