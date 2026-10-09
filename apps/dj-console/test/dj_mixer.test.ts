import assert from "node:assert/strict";
import { Mixer } from "@ncsound/dj-engine/mixer";
import { BUILTIN_TRACK_SPECS, synthesizeStudioTrack } from "@ncsound/dj-engine/synthTracks";

// Mock AudioContext for Node.js test environment
class MockGainNode {
  gain = {
    value: 1,
    setValueAtTime() {},
    linearRampToValueAtTime() {},
    cancelScheduledValues() {},
    exponentialRampToValueAtTime() {},
    setTargetAtTime() {},
  };
  connect() {}
  disconnect() {}
}

class MockBiquadFilterNode {
  type = "lowpass";
  frequency = {
    value: 1000,
    setValueAtTime() {},
    linearRampToValueAtTime() {},
    cancelScheduledValues() {},
    setTargetAtTime() {},
  };
  Q = { value: 1 };
  gain = { value: 0, setTargetAtTime() {} };
  connect() {}
  disconnect() {}
}

class MockDynamicsCompressorNode {
  threshold = { value: -24 };
  knee = { value: 30 };
  ratio = { value: 12 };
  attack = { value: 0.003 };
  release = { value: 0.25 };
  connect() {}
  disconnect() {}
}

class MockAnalyserNode {
  fftSize = 2048;
  frequencyBinCount = 1024;
  getByteFrequencyData(arr: Uint8Array) {
    arr.fill(128);
  }
  getByteTimeDomainData(arr: Uint8Array) {
    arr.fill(128);
  }
  connect() {}
}

/**
 * Routing-capable channel merger mock.
 *
 * The merge mock this replaced had no `disconnect`, which the mixer never called
 * before: `routeOutputs` is now the single owner of the destination wiring and
 * rebuilds it on construction, so the mock has to model teardown too.
 */
class MockChannelMergerNode {
connect() {}
  disconnect() {}
  }
  
class MockAudioBuffer {
  duration = 10;
  sampleRate = 44100;
  numberOfChannels = 2;
  length = 441000;
  getChannelData(c: number) {
    const data = new Float32Array(441000);
    for (let i = 0; i < data.length; i++) {
      data[i] = Math.sin(2 * Math.PI * 440 * (i / 44100));
    }
    return data;
  }
}

class MockBufferSourceNode {
  buffer: any = null;
  playbackRate = {
    value: 1,
    setValueAtTime() {},
    linearRampToValueAtTime() {},
  };
  loop = false;
  loopStart = 0;
  loopEnd = 0;
  onended: any = null;
  connect() {}
  disconnect() {}
  start() {}
  stop() {}
}

class MockOscillatorNode {
  type = "sine";
  frequency = {
    value: 440,
    setValueAtTime() {},
    linearRampToValueAtTime() {},
    exponentialRampToValueAtTime() {},
    cancelScheduledValues() {},
  };
  connect() {}
  disconnect() {}
  start() {}
  stop() {}
}

class MockAudioContext {
  state = "running";
  sampleRate = 44100;
  currentTime = 5.0;
  destination = {};

  createGain() { return new MockGainNode(); }
  createBiquadFilter() { return new MockBiquadFilterNode(); }
  createDynamicsCompressor() { return new MockDynamicsCompressorNode(); }
  createAnalyser() { return new MockAnalyserNode(); }
  createChannelMerger(n: number) { return new MockChannelMergerNode(); }
  createOscillator() { return new MockOscillatorNode(); }
  createBuffer(channels: number, length: number, sampleRate: number) {
    return new MockAudioBuffer();
  }
  createBufferSource() { return new MockBufferSourceNode(); }
  async resume() { this.state = "running"; }
}

// Global window mock for test environment
if (typeof window === "undefined") {
  (global as any).window = global;
}
(global as any).AudioContext = MockAudioContext;
(global as any).Float32Array = Float32Array;

console.log("=== Testing DJ Mixer Engine ===");

// 1. Initial State & Deck Setup
const mixer = new Mixer();
assert.equal(mixer.decks.length, 2, "Mixer must have two decks (Deck A & Deck B)");
assert.equal(mixer.active, 0, "Initial active deck should be Deck A (0)");
assert.equal(mixer.crossfader, -1, "Initial crossfader position should be -1 (Full Deck A)");
assert.equal(mixer.crossfaderCurve, "blend", "Default crossfader curve should be 'blend'");

// 2. Crossfader Position & Curve Modifications
mixer.setCrossfader(0);
assert.equal(mixer.crossfader, 0, "Crossfader set to center (0)");

mixer.setCrossfaderCurve("scratch");
assert.equal(mixer.crossfaderCurve, "scratch", "Crossfader curve updated to 'scratch'");

mixer.setCrossfader(1);
assert.equal(mixer.crossfader, 1, "Crossfader set to full Deck B (+1)");

// 3. Pitch Fader & Pitch Range Settings
mixer.pitchFaderRange = 12;
assert.equal(mixer.pitchFaderRange, 12, "Pitch range updated to ±12%");

mixer.decks[0].pitchPct = 4; // +4% pitch shift on Deck A
assert.equal(mixer.decks[0].pitchPct, 4, "Deck A pitch percent should be 4%");

// 4. Track Loading on Deck A
const trackSpec = BUILTIN_TRACK_SPECS[0];
assert.ok(trackSpec, "Built-in track spec must exist");
const synthesizedBuf = synthesizeStudioTrack(mixer.ctx as any, trackSpec);

const mockAnalysis = {
  bpm: trackSpec.bpm,
  key: trackSpec.camelot,
  energy: 0.8,
  danceability: 0.85,
  spectralCentroid: 2400,
  rmsEnergy: 0.5,
  firstBeat: 0.24,
};

mixer.decks[0].load(synthesizedBuf, mockAnalysis as any);
assert.equal(mixer.decks[0].analysis?.bpm, trackSpec.bpm);
assert.equal(mixer.decks[0].analysis?.key, trackSpec.camelot);

// 5. Seek & Loop Controls
mixer.decks[0].seek(5.0);
assert.equal(mixer.decks[0].currentOffset(), 5.0, "Seeking Deck A to 5.0s must update playhead");

mixer.decks[0].loopBars = 4;
assert.equal(mixer.decks[0].loopBars, 4, "Setting 4-bar loop on Deck A");

// 6. Stutter Roll & Gater Effects
mixer.triggerStutterRoll(0, 0.25); // 1/16th stutter roll on Deck A
mixer.triggerStutterRoll(0, 0.5);  // 1/8th stutter roll on Deck A

mixer.triggerGaterEffect(0, 4);    // 4-step gater pattern on Deck A

// 8. Auto-Scratch Pattern Triggering
// Real pattern ids, with a word from the pattern's actual name. The old list
// ("baby-1b", "spinback-whip", …) contained no real id, so `triggerAutoscratch`
// silently fell back to Baby Scratch and the old `typeof ok === "boolean"`
// assertion passed for every one of them. The message now names the pattern
// that ran, which catches the fallback.
const scratchPatterns = [
  { id: "baby", word: "Baby" },
  { id: "chirp", word: "Chirp" },
  { id: "transformer", word: "Transformer" },
  { id: "flare", word: "Flare" },
  { id: "crab", word: "Crab" },
  { id: "backspin", word: "Backspin" },
  { id: "uzis", word: "Laser" },
  { id: "tear", word: "Tear" },
] as const;

for (const { id, word } of scratchPatterns) {
  const result = mixer.triggerAutoscratch(id);
  assert.equal(result.ok, true, `autoscratch "${id}" should succeed`);
  assert.ok(
    result.message.includes(word),
    `autoscratch "${id}" should run its own pattern, but ran: ${result.message}`,
  );
}

// 9. Phase Difference & Pocket Information
const phaseInfo = mixer.getPhaseDifferenceInfo();
assert.ok(phaseInfo === null || typeof phaseInfo.inPhase === "boolean", "Phase difference returned valid status");

console.log("All DJ Mixer Engine unit tests passed successfully!");
