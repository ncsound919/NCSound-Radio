import assert from "node:assert/strict";
import { RadioBroadcastEngine } from "../src/engine/radioBroadcast";

// Mock minimal AudioContext for unit test execution in Node.js
class MockGainNode {
  gain = {
    value: 1,
    setValueAtTime() {},
    linearRampToValueAtTime() {},
    cancelScheduledValues() {},
  };
  connect() {}
}

class MockBiquadFilterNode {
  type = "highpass";
  frequency = { value: 30 };
  Q = { value: 0.707 };
  connect() {}
}

class MockDynamicsCompressorNode {
  threshold = { value: -1.0 };
  knee = { value: 1.5 };
  ratio = { value: 20.0 };
  attack = { value: 0.001 };
  release = { value: 0.06 };
  connect() {}
}

class MockWaveShaperNode {
  curve = new Float32Array(512);
  oversample = "none";
  connect() {}
}

class MockAudioBuffer {
  duration = 2.5;
  sampleRate = 44100;
  numberOfChannels = 2;
  getChannelData() {
    return new Float32Array(44100 * 2.5);
  }
}

class MockAudioContext {
  state = "running";
  sampleRate = 44100;
  currentTime = 10.0;
  createGain() { return new MockGainNode(); }
  createBiquadFilter() { return new MockBiquadFilterNode(); }
  createDynamicsCompressor() { return new MockDynamicsCompressorNode(); }
  createWaveShaper() { return new MockWaveShaperNode(); }
  createMediaStreamDestination() { return { stream: {} }; }
  createBuffer(channels: number, length: number, sampleRate: number) {
    return new MockAudioBuffer();
  }
  createBufferSource() {
    return {
      buffer: null,
      connect() {},
      start() {},
      stop() {},
      onended: null,
    };
  }
  async resume() { this.state = "running"; }
}

const mockCtx = new MockAudioContext() as any;
const radio = new RadioBroadcastEngine(mockCtx);

// 1. Initial State & Configuration
assert.equal(radio.isOnAir, false);
// Asserted against the config, not a literal. This used to pin the brand
// string "Club Horizon Radio" in three places, so renaming the station broke
// the test rather than the behaviour — and the test passed for the old
// default even after an operator changed it.
assert.ok(radio.config.stationName.length > 0, "a station name must be configured");
assert.equal(radio.config.broadcastDspEnabled, true);
assert.ok(radio.sweepers.length >= 4, "Must have built-in radio sweepers initialized");

// 2. ON AIR Broadcast Toggle
radio.toggleOnAir(true);
assert.equal(radio.isOnAir, true);
assert.ok(radio.startedAtMs > 0);
radio.toggleOnAir(false);
assert.equal(radio.isOnAir, false);

// 3. Listener Song Request Ingestion & Status Transitions
const req = radio.submitSongRequest({
  query: "Acid Horizon 303",
  requester: "Alex (Berlin)",
  message: "Drop the heavy acid!",
});
assert.ok(req.id.startsWith("req-"));
assert.equal(req.query, "Acid Horizon 303");
assert.equal(req.requester, "Alex (Berlin)");
assert.equal(req.status, "pending");
assert.equal(radio.songRequests.length, 1);

const updated = radio.updateRequestStatus(req.id, "queued");
assert.equal(updated, true);
assert.equal(radio.songRequests[0].status, "queued");

// 4. Now-Playing Payload Construction (AzuraCast / Icecast standard)
const payload = radio.buildNowPlayingPayload(
  {
    id: "track-1",
    name: "Midnight Warehouse",
    artist: "Studio Syndicate",
    genre: "Peak Time Techno",
    analysis: { bpm: 124.0, key: "8A" },
    duration: 180,
  },
  45,
  {
    id: "track-2",
    name: "Neon Ignition",
    artist: "Cyber Groove",
    analysis: { bpm: 126.0, key: "9A" },
    duration: 195,
  }
);

assert.equal(payload.station.name, radio.config.stationName);
assert.equal(payload.nowPlaying.title, "Midnight Warehouse");
assert.equal(payload.nowPlaying.artist, "Studio Syndicate");
assert.equal(payload.nowPlaying.bpm, 124);
assert.equal(payload.nowPlaying.key, "8A");
assert.equal(payload.nowPlaying.elapsedSec, 45);
assert.equal(payload.nowPlaying.remainingSec, 135);
assert.equal(payload.nextTrack?.title, "Neon Ignition");
assert.equal(payload.nextTrack?.bpm, 126);

// 5. Jingle Injection & Ducking Calculation
const jingleOk = radio.triggerJingle();
assert.equal(jingleOk, true);
assert.equal(radio.isJinglePlaying, true);
assert.equal(radio.totalJinglesPlayed, 1);

// 6. Embed Player Snippet Generation
const embedHtml = radio.generateEmbedWidgetHtml();
assert.ok(
  embedHtml.includes(radio.config.stationName),
  "widget carries the configured station name",
);
assert.ok(embedHtml.includes("LIVE BROADCAST"));
// The old assertion looked for "/api/radio/nowplaying", which only survives in
// the explanatory comment above the fetch — it passed whether or not the
// widget pointed anywhere real. Assert the endpoint the script actually calls.
assert.ok(
  embedHtml.includes(`fetch('${radio.config.nowPlayingApiUrl}')`),
  "widget polls the live now-playing endpoint",
);
// ...and the endpoint it polls must be the station app's real route. The
// removed `/api/radio/nowplaying` fixture answered with a hardcoded track, so a
// widget pointed at it displayed music that never aired.
assert.ok(
  /\/api\/nowplaying$/.test(radio.config.nowPlayingApiUrl),
  `now-playing endpoint must be the station app's /api/nowplaying, got ${radio.config.nowPlayingApiUrl}`,
);
assert.ok(
  embedHtml.includes(`src="${radio.config.websiteUrl}${radio.config.mountPoint}"`),
  "widget audio element points at the configured stream mount",
);

// 7. Silence Watchdog & 24/7 Failover
radio.toggleOnAir(true);
radio.config.autoFailoverEnabled = true;

// Normal audio level (-12 dBFS) -> no dead air
let watchdog = radio.checkSilenceWatchdog(-12);
assert.equal(watchdog.deadAirDetected, false);

// Dead silence (-60 dBFS) for 4 iterations
radio.checkSilenceWatchdog(-60);
radio.checkSilenceWatchdog(-60);
radio.checkSilenceWatchdog(-60);
watchdog = radio.checkSilenceWatchdog(-60);
assert.equal(watchdog.deadAirDetected, true, "Silence watchdog must trigger after 4s of dead air");

console.log("All RadioBroadcastEngine unit tests passed successfully!");
