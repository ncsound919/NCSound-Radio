import assert from "node:assert/strict";
import { calculateHarmonicKeyShift, processWsolaTimePitch } from "../src/engine/timePitchEngine";
import { pickExactSyncRate } from "../src/engine/sync";

const close = (a: number, b: number, e = 1e-4) => assert.ok(Math.abs(a - b) < e, `${a} !~ ${b}`);

// 1. Exact BPM Sync Match
// Straight exact match: 124 target, 140 native -> rate = 124/140 = 0.885714 -> effBpm = 124.0
let sync = pickExactSyncRate(124, 140);
close(sync.rate, 124 / 140);
close(sync.effBpm, 124);

// Straight exact match: 128 target, 125 native -> rate = 128/125 = 1.024 -> effBpm = 128.0
sync = pickExactSyncRate(128, 125);
close(sync.rate, 1.024);
close(sync.effBpm, 128);

// Half-time tempo lock: 140 target, 70 native -> rate = (140 * 0.5) / 70 = 1.0 -> effBpm = 70.0 (or straight 140/70 = 2.0)
sync = pickExactSyncRate(140, 70);
assert.ok(sync.effBpm === 70 || sync.effBpm === 140);

// Double-time tempo lock: 70 target, 140 native -> rate = (70 * 2) / 140 = 1.0
sync = pickExactSyncRate(70, 140);
assert.ok(sync.effBpm === 70 || sync.effBpm === 140);

// Wide tempo stretch: 128 target, 174 native -> rate = 128/174 = 0.7356 -> effBpm = 128.0 (exact match)
sync = pickExactSyncRate(128, 174);
close(sync.rate, 128 / 174);
close(sync.effBpm, 128);

// 2. Harmonic Camelot Key Shift Calculation
// 8A (A minor) to 8A (A minor) -> 0 semitones
let shift = calculateHarmonicKeyShift("8A", "8A");
assert.equal(shift.semitones, 0);
assert.equal(shift.score, 100);

// 8A (A minor = 9) to 9A (E minor = 4) -> diff = 4 - 9 = -5 semitones (or +7)
shift = calculateHarmonicKeyShift("8A", "9A");
assert.equal(shift.semitones, -5);

// 8A (A minor = 9) to 7A (D minor = 2) -> diff = 2 - 9 = -7 -> +5 semitones
shift = calculateHarmonicKeyShift("8A", "7A");
assert.equal(shift.semitones, 5);

// 8A (A minor = 9) to 8B (C major = 0) -> diff = 0 - 9 = -9 -> +3 semitones (relative major)
shift = calculateHarmonicKeyShift("8A", "8B");
assert.equal(shift.semitones, 3);

// 3. WSOLA Time-Pitch Audio Processing
class MockAudioBuffer {
  duration: number;
  sampleRate: number;
  numberOfChannels: number;
  length: number;
  private channelData: Float32Array[];

  constructor(channels: number, length: number, sampleRate: number) {
    this.numberOfChannels = channels;
    this.length = length;
    this.sampleRate = sampleRate;
    this.duration = length / sampleRate;
    this.channelData = Array.from({ length: channels }, () => new Float32Array(length));
  }

  getChannelData(c: number) {
    return this.channelData[c];
  }
}

class MockAudioContext {
  createBuffer(channels: number, length: number, sampleRate: number) {
    return new MockAudioBuffer(channels, length, sampleRate);
  }
}

const mockCtx = new MockAudioContext() as any;
const sr = 44100;
const testLen = sr * 2; // 2 seconds of test audio
const testBuf = new MockAudioBuffer(2, testLen, sr);

// Populate with 440Hz test sine tone
for (let i = 0; i < testLen; i++) {
  const v = Math.sin(2 * Math.PI * 440 * (i / sr));
  testBuf.getChannelData(0)[i] = v;
  testBuf.getChannelData(1)[i] = v;
}

// Test WSOLA time-stretch with KeyLock ON (1.25x faster, 0 semitone pitch shift)
const stretched = processWsolaTimePitch(testBuf as any, mockCtx, {
  timeStretchRatio: 1.25,
  pitchSemitones: 0,
  keyLock: true,
});

assert.ok(stretched.length < testBuf.length, "1.25x faster time-stretch must shorten output buffer duration");
close(stretched.duration, testBuf.duration / 1.25, 0.1);

// Test WSOLA pitch-shift with KeyLock ON (1.0x tempo, +2 semitones transpose)
const pitchShifted = processWsolaTimePitch(testBuf as any, mockCtx, {
  timeStretchRatio: 1.0,
  pitchSemitones: 2,
  keyLock: true,
});
assert.ok(pitchShifted.length > 0, "Pitch shifted buffer must produce audio");

console.log("All TimePitchEngine and Exact Sync unit tests passed successfully!");
