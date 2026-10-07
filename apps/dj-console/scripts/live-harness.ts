/**
 * Go-live harness for scripts/live-check.mjs and scripts/station-e2e.mjs (bun).
 *
 *   bun scripts/live-harness.ts <port> <out.wav> [--token T] [--real]
 *
 * Always a REAL IngestService: the real /live/arm, /live socket and
 * LiveBridge state machine.
 *
 * Default (stand-in) mode swaps two things, and only these:
 *   - ffmpeg's OUTPUT: it decodes the console's WebM/Opus to a WAV file instead
 *     of pushing to icecast://…/live, so the check can prove the browser's audio
 *     decodes. ffmpeg itself is real.
 *   - Liquidsoap's "is the live harbor connected?": true once the bridge has
 *     20 kB, roughly when a real harbor would accept the source.
 *
 * --real swaps nothing: the stock ffmpeg command pushes to the live harbor on
 * 127.0.0.1:8008 (LIVE_HARBOR_PASSWORD from the environment), and "connected"
 * is read from a real Liquidsoap over telnet (127.0.0.1:1234), exactly as
 * production ingest does.
 *
 * --fixtures <dir> creates, in <dir>, a station SQLite database with three
 * listener requests (one titled like a crate track, so `cue.request` can
 * resolve) and an imaging folder with two short jingles, and points ingest
 * at both: the real request store and the real imaging player read them.
 *
 * Prints "READY" when listening. A side channel on <port>+1 reports the WAV
 * files (stand-in mode) and the bridge snapshot, and POST /stall?on=1 makes
 * the bridge drop incoming audio without closing anything, which is what a
 * venue network that silently stops delivering looks like to the station.
 */
import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import { IngestService } from "../../../packages/ingest/src/server";
import { LiquidsoapControl } from "../../../packages/ingest/src/liquidsoap";

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const real = args.includes("--real");
const fixtures = flag("--fixtures");
if (fixtures) {
  const { mkdirSync } = await import("node:fs");
  const { Database } = await import("bun:sqlite");
  mkdirSync(`${fixtures}/jingles`, { recursive: true });
  const dbPath = `${fixtures}/station.db`;
  const db = new Database(dbPath, { create: true });
  db.run("DROP TABLE IF EXISTS TrackRequest");
  db.run("DROP TABLE IF EXISTS Track");
  db.run("CREATE TABLE Track (id TEXT PRIMARY KEY, title TEXT, artist TEXT)");
  db.run("CREATE TABLE TrackRequest (id TEXT PRIMARY KEY, trackId TEXT, listenerName TEXT, note TEXT, createdAt TEXT)");
  const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
  db.run("INSERT INTO Track VALUES ('t1','Midnight Warehouse','Sublevel 808'), ('t2','Not In Any Crate','Nobody'), ('t3','live-check tone','')");
  db.run(`INSERT INTO TrackRequest VALUES ('r1','t1','Dana','birthday shout please','${ago(3)}'), ('r2','t2','Sam',NULL,'${ago(12)}'), ('r3','t3','Lee','the tone one','${ago(30)}')`);
  db.close();
  process.env.NCSOUND_STATION_DB = dbPath;
  for (const [name, f] of [["station-id", 660], ["sweeper", 990]] as const) {
    Bun.spawnSync(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", `sine=f=${f}:d=1.5`, `${fixtures}/jingles/${name}.wav`]);
  }
}
const token = flag("--token");
const port = Number(args[0] ?? 8299);
const outWav = args[1] ?? "live-out.wav";
let wavIndex = 0;
const wavs: string[] = [];
let stalled = false;

const liquidsoap = real ? new LiquidsoapControl({ host: "127.0.0.1", port: 1234 }) : null;

const service: IngestService = new IngestService({
  port,
  host: "127.0.0.1",
  token,
  engine: { publish: false },
  station: liquidsoap
    ? {
        setOnAir: async () => {},
        onAir: () => liquidsoap.onAir(),
        liveHarborConnected: () => liquidsoap.liveHarborConnected(),
      }
    : {
        setOnAir: async () => {},
        onAir: async () => ({ onAir: true, error: null }),
        liveHarborConnected: async () => ({
          onAir: service.live.state === "armed" || service.live.state === "on_air" ? service.live.snapshot.bytesSent > 20_000 : false,
          error: null,
        }),
      },
  live: {
    harbor: { password: real ? process.env.LIVE_HARBOR_PASSWORD ?? "" : "harness-only" },
    statsIntervalMs: 1000,
    ...(real
      ? {}
      : {
          spawn: (cmd: string, _a: string[], opts: { stdio: ["pipe", "ignore", "pipe"] }) => {
            const file = outWav.replace(/\.wav$/, `-${++wavIndex}.wav`);
            wavs.push(file);
            return spawn(cmd, ["-hide_banner", "-loglevel", "error", "-progress", "pipe:2", "-f", "webm", "-i", "pipe:0", "-f", "wav", "-y", file], { stdio: opts.stdio }) as never;
          },
        }),
  },
} as never);

// Stall switch: swallow audio at the bridge while every socket stays open.
const write = service.live.write.bind(service.live);
(service.live as unknown as { write: (c: Uint8Array) => boolean }).write = (c: Uint8Array) => (stalled ? true : write(c));

if (fixtures) service.attachImaging(`${fixtures}/jingles`);
service.listen();
await service.engine.start();
service.startStreamPolling();

Bun.serve({
  port: port + 1,
  hostname: "127.0.0.1",
  fetch(req) {
    const url = new URL(req.url);
    if (req.method === "POST" && url.pathname === "/stall") {
      stalled = url.searchParams.get("on") === "1";
      return Response.json({ stalled });
    }
    const files = wavs.map((f) => {
      try {
        return { file: f, bytes: statSync(f).size };
      } catch {
        return { file: f, bytes: 0 };
      }
    });
    return Response.json({ files, live: service.live.snapshot, stalled });
  },
});
console.log("READY");
