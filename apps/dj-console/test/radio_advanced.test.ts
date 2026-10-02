import assert from "node:assert/strict";
import { RadioBroadcastEngine } from "../src/engine/radioBroadcast";

class MockGainNode {
  gain = {
    value: 1,
    setValueAtTime() {},
    linearRampToValueAtTime() {},
    cancelScheduledValues() {},
  };
  connect() {}
  disconnect() {}
}

class MockBiquadFilterNode {
  type = "highpass";
  frequency = { value: 30, setValueAtTime() {} };
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
  duration = 3.0;
  sampleRate = 44100;
  numberOfChannels = 2;
  getChannelData() {
    return new Float32Array(44100 * 3.0);
  }
}

class MockAudioContext {
  state = "running";
  sampleRate = 44100;
  currentTime = 100.0;
  createGain() { return new MockGainNode(); }
  createBiquadFilter() { return new MockBiquadFilterNode(); }
  createDynamicsCompressor() { return new MockDynamicsCompressorNode(); }
  createWaveShaper() { return new MockWaveShaperNode(); }
  createMediaStreamDestination() { return { stream: {} }; }
  createBuffer() { return new MockAudioBuffer(); }
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

console.log("=== Testing Advanced Radio Broadcast Functions ===");

const mockCtx = new MockAudioContext() as any;
const radio = new RadioBroadcastEngine(mockCtx);

// 1. Station Custom Configuration & Metadata
Object.assign(radio.config, {
  stationName: "Deep Bass FM",
  slogan: "24/7 Underground Cyber Beats",
  genre: "Tech House / Techno",
  bitrateKbps: 320,
  webhookUrl: "https://example.com/api/radio/webhook",
});

assert.equal(radio.config.stationName, "Deep Bass FM");
assert.equal(radio.config.genre, "Tech House / Techno");
assert.equal(radio.config.bitrateKbps, 320);
assert.equal(radio.config.webhookUrl, "https://example.com/api/radio/webhook");

// 2. Custom Station Sweeper Addition & Triggering
const customSweeperBuf = radio.synthesizeRadioSweeperBuffer("Special Midnight Drop", 120, 2.0);
const customSweeper = {
  id: `custom-sw-${Date.now()}`,
  name: "Special Midnight Drop",
  type: "sweeper" as const,
  durationSec: 2.0,
  buffer: customSweeperBuf,
  isCustom: true,
};
radio.sweepers.unshift(customSweeper);

assert.ok(customSweeper.id.startsWith("custom-sw-"));
assert.equal(customSweeper.name, "Special Midnight Drop");

const sweeperPlayed = radio.triggerJingle(customSweeper.id);
assert.equal(sweeperPlayed, true, "Triggering custom sweeper by ID must succeed");

// 3. Listener Request Lifecycle: Ingestion -> Approval -> Queueing -> Rejection -> Removal
const req1 = radio.submitSongRequest({
  query: "Solar Flare",
  requester: "Maya (London)",
  message: "Play this for the main floor!",
});
const req2 = radio.submitSongRequest({
  query: "Dark Energy",
  requester: "Leo (Tokyo)",
});

assert.equal(radio.songRequests.length, 2);

// Approve req1
assert.equal(radio.updateRequestStatus(req1.id, "queued"), true);
assert.equal(radio.songRequests.find(r => r.id === req1.id)?.status, "queued");

// Reject req2
assert.equal(radio.updateRequestStatus(req2.id, "rejected"), true);
assert.equal(radio.songRequests.find(r => r.id === req2.id)?.status, "rejected");

// Remove request from queue array
radio.songRequests = radio.songRequests.filter(r => r.id !== req2.id);
assert.equal(radio.songRequests.length, 1);

// 4. Webhook Notification Payload Formatting
const webhookNotice = radio.buildNowPlayingPayload(
  {
    id: "track-sf",
    name: "Solar Flare",
    artist: "Hyperion",
    genre: "Techno",
    analysis: { bpm: 128, key: "8A" },
    duration: 210,
  },
  30
);
assert.equal(webhookNotice.station.name, "Deep Bass FM");
assert.equal(webhookNotice.nowPlaying.title, "Solar Flare");
assert.equal(webhookNotice.nowPlaying.artist, "Hyperion");

// 5. OBS Stream Widget HTML Embed Generation
const widgetHtml = radio.generateEmbedWidgetHtml();
assert.ok(widgetHtml.includes("Deep Bass FM"));
assert.ok(widgetHtml.includes("24/7 Underground Cyber Beats"));
assert.ok(widgetHtml.includes("320 KBPS HD"));

// 6. Dead Air Failover Trigger
radio.toggleOnAir(true);
radio.config.autoFailoverEnabled = true;

// Trigger dead air sequence: 3 iterations under threshold, then 4th iteration trips
radio.checkSilenceWatchdog(-65);
radio.checkSilenceWatchdog(-65);
radio.checkSilenceWatchdog(-65);
const status = radio.checkSilenceWatchdog(-65);
assert.equal(status.deadAirDetected, true, "Dead air must be flagged on 4th iteration of sustained silence");

console.log("All Advanced Radio Broadcast unit tests passed successfully!");
