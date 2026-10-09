import assert from "node:assert/strict";
import { toStatus } from "../src/engine/broadcastLink";

/**
 * `toStatus` is the console's broadcast truth: it turns the ingest /status
 * document into what the booth shows. The invariant it must never break is
 * "unmeasured is null, never 0" — a listener count of 0 for a station nobody
 * measured is the fabrication this module exists to remove.
 */

const doc = {
  engine: {
    state: "playing",
    autopilot: { crateSize: 66, enabled: true },
    listeners: { current: 42, peak24h: 120 },
    uptimeSec: 3600,
    lastError: null,
  },
  stream: {
    onAir: true,
    icecast: { reachable: true, version: "2.4.4" },
    mounts: [
      { mount: "/live.mp3", bitrateKbps: 128, listeners: 42, peakListeners24h: 120, lastMetadata: "A - B" },
      { mount: "/mobile.mp3", bitrateKbps: 64, listeners: 0, peakListeners24h: 0, lastMetadata: null },
    ],
  },
  queue: [{ id: "t", title: "T", artist: "A", bpm: 120 }],
  station: { onAir: true, error: null },
  broadcast: {
    onAir: true,
    reason: "",
    components: { enginePlaying: true, outputLive: true, mountConnected: true },
  },
};

const s = toStatus(doc as never);
assert.equal(s.connected, true);
assert.equal(s.engineReady, true);
assert.equal(s.engineState, "playing");
assert.equal(s.crateSize, 66);
assert.equal(s.autopilotEnabled, true);
assert.equal(s.listeners, 42);
assert.equal(s.peakListeners24h, 120);
assert.equal(s.streamOnAir, true);
assert.equal(s.icecastReachable, true);
assert.equal(s.icecastVersion, "2.4.4");
// The most recent mount carrying metadata is the live title.
assert.equal(s.liveTitle, "A - B");
// The broadcast verdict is read straight from ingest, not recomputed.
assert.equal(s.broadcast.onAir, true);
assert.equal(s.stationOnAir, true);
assert.equal(s.queue.length, 1);

// Icecast unreachable: counts are unmeasured, so null — never a factual 0.
const unreachable = toStatus({
  ...doc,
  stream: { onAir: false, icecast: { reachable: false, version: null }, mounts: [] },
} as never);
assert.equal(unreachable.listeners, null, "an unmeasured listener count must be null, not 0");
assert.equal(unreachable.peakListeners24h, null);
assert.equal(unreachable.icecastReachable, false);
assert.equal(unreachable.icecastVersion, null);
assert.equal(unreachable.liveTitle, null);
assert.equal(unreachable.streamOnAir, false);

// "idle" is loaded-but-not-playing, which still counts as ready; an error is not.
assert.equal(toStatus({ ...doc, engine: { ...doc.engine, state: "idle" } } as never).engineReady, true);
assert.equal(toStatus({ ...doc, engine: { ...doc.engine, state: "error" } } as never).engineReady, false);

// No broadcast block at all: refuse to claim on air rather than defaulting to true.
const noBroadcast = toStatus({ ...doc, broadcast: undefined } as never);
assert.equal(noBroadcast.broadcast.onAir, false);
assert.match(noBroadcast.broadcast.reason, /did not report/i);

console.log("BroadcastLink toStatus tests passed");
