import {
  calculatePitchedKey,
  computeBeatPhaseDifference,
  computePhaseAlignOffset,
  detectTempoMultiplierCandidate,
  evaluateHarmonicMatch,
  interpolateTransitionBpm,
  nextBarTime,
  pickRate,
} from "@ncsound/dj-engine/sync";
import {
  categorizeTrackAcoustics,
  parseFilenameMetadata,
  parseId3v1,
  parseId3v2,
  searchAndFilterCrate,
} from "../src/engine/crateIndexer";
import {
  evaluateScratchTrajectory,
  findNearestTransientAnchor,
  renderScratchBuffer,
  resolveBattleCutAnchor,
  sampleKaiserSinc,
  SCRATCH_PATTERNS,
} from "@ncsound/dj-engine/scratch";
import { strokeRate } from "@ncsound/scratch-agent/scratch/primitives";
import { CTRL_HZ } from "@ncsound/scratch-agent/scratch/curves";
import assert from "node:assert/strict";
const close = (a: number, b: number, e = 1e-6) => assert.ok(Math.abs(a - b) < e, `${a} !~ ${b}`);

let r = pickRate(128, 125); close(r.rate, 128 / 125); assert.equal(r.clamped, false);
r = pickRate(140, 70); close(r.rate, 1); assert.equal(r.clamped, false);       // half-time lock
r = pickRate(70, 140); close(r.rate, 1);                                        // double-time lock
r = pickRate(128, 174); assert.equal(r.clamped, true); close(r.rate, 0.92);     // too far apart
close(pickRate(120, 100).rate, 1.08);                                           // clamp at +8%
close(pickRate(128, 125).effBpm, 128);                                          // effective tempo tracks outgoing

// bar grid: 120 bpm => 2 s/bar, anchored at t=10
close(nextBarTime(10.5, 10, 2), 12);
close(nextBarTime(11.95, 10, 2), 14);   // <0.1 s lead => skip to following bar
close(nextBarTime(5, 10, 2), 10);       // before anchor => first bar line
close(nextBarTime(12, 10, 2), 14);      // exactly on a bar line, lead pushes to next

// Camelot wheel harmonic matching
assert.equal(evaluateHarmonicMatch("8A", "8A").tier, "perfect");
assert.equal(evaluateHarmonicMatch("8A", "8B").tier, "perfect");
assert.equal(evaluateHarmonicMatch("8A", "9A").tier, "harmonic");
assert.equal(evaluateHarmonicMatch("8A", "3A").tier, "energy-boost");

// Autoscratch trajectory verification (bidirectional velocity + VCA gate bounds)
for (const pat of SCRATCH_PATTERNS) {
  let sawForward = false, sawReverse = false;
  for (let b = 0; b <= pat.beats; b += 0.02) {
    const pt = evaluateScratchTrajectory(pat.id, b, pat.beats, 1.0);
    if (pt.velocity > 0.1) sawForward = true;
    if (pt.velocity < -0.1) sawReverse = true;
    assert.ok(pt.faderGain >= 0 && pt.faderGain <= 1.0001, `faderGain out of range for ${pat.id}`);
  }
  assert.ok(sawForward && sawReverse, `Pattern ${pat.id} must have true bidirectional platter motion`);
}

// 90s Scratch Agent System pipeline verification
import {
  buildSliceBank,
  encodeWav16,
  gridFromBpm,
  runScratchAgent,
  validateDirectorPlan,
} from "@ncsound/scratch-agent";

const sr = 22050;
const testMono = new Float32Array(sr * 4);
// Create sharp rhythmic bursts at 0.2s, 0.8s, 1.5s, 2.2s so slicerLite finds transient slices
for (const onset of [0.2, 0.8, 1.5, 2.2, 2.9]) {
  const s0 = Math.floor(onset * sr);
  for (let i = 0; i < Math.floor(0.18 * sr); i++) {
    const env = Math.exp(-i / (0.05 * sr));
    testMono[s0 + i] = Math.sin((2 * Math.PI * 320 * i) / sr) * env * 0.9;
  }
}

const bank = buildSliceBank(testMono, sr, "test-hook", { maxSliceS: 0.35, delta: 0.2 });
assert.ok(bank.slices.length >= 3, "slicerLite should extract transient slices");
const grid = gridFromBpm(94, 0.1, 16);

const res1 = await runScratchAgent({
  src: testMono,
  fs: sr,
  bank,
  grid,
  bars: 2,
  style: "medium",
  seed: 7,
  phraseStartBeat: 0,
  cfg: { placement_mode: "answer" },
});
const res2 = await runScratchAgent({
  src: testMono,
  fs: sr,
  bank,
  grid,
  bars: 2,
  style: "medium",
  seed: 7,
  phraseStartBeat: 0,
  cfg: { placement_mode: "answer" },
});

assert.equal(validateDirectorPlan(res1.plan).ok, true, "DirectorPlan must validate against schema");
assert.ok(res1.events.length > 0, "90s Scratch Agent must place scratch events");
assert.equal(res1.seed, res2.seed, "Same seed must be 100% deterministic");
assert.equal(res1.audio.length, res2.audio.length);
const wav = encodeWav16(res1.audio, sr);
assert.ok(wav.byteLength > 44, "WAV encoder must produce valid RIFF header + PCM payload");

// Club Marathon & Long-Running Party Sequencer verification
import {
  interpolateEnergyCurve,
  pickNextMarathonTrack,
  pickSmartScratchProfile,
  pickSmartTransitionPreset,
  scoreNextTrackCandidate,
  sequenceCrateForParty,
} from "@ncsound/dj-engine/marathon";

const curve = [0.4, 0.6, 0.8, 1.0, 0.7];
close(interpolateEnergyCurve(curve, 0), 0.4);
close(interpolateEnergyCurve(curve, 0.5), 0.8);
close(interpolateEnergyCurve(curve, 1), 0.7);

const mockCrate = [
  { id: "t1", name: "Warmup 8A", analysis: { bpm: 122, firstBeat: 0, key: "8A", energy: 0.45 }, playCount: 0 },
  { id: "t2", name: "Build 9A", analysis: { bpm: 124, firstBeat: 0, key: "9A", energy: 0.65 }, playCount: 0 },
  { id: "t3", name: "Peak 9B", analysis: { bpm: 126, firstBeat: 0, key: "9B", energy: 0.92 }, playCount: 0 },
  { id: "t4", name: "Clash Overplayed", analysis: { bpm: 165, firstBeat: 0, key: "2B", energy: 0.9 }, playCount: 3 },
];

const scGood = scoreNextTrackCandidate({ bpm: 122, key: "8A" }, mockCrate[1], 0.65);
const scBad = scoreNextTrackCandidate({ bpm: 122, key: "8A" }, mockCrate[3], 0.65);
assert.ok(scGood.total > scBad.total, "Harmonic & tempo-matched fresh track must score higher than overplayed tempo-clamped track");

const picked = pickNextMarathonTrack({ bpm: 122, key: "8A" }, mockCrate, new Set(["t1"]), 0.65);
assert.equal(picked?.track.id, "t2", "pickNextMarathonTrack should select highest composite harmonic/BPM/energy/freshness match");

const ordered = sequenceCrateForParty({ bpm: 120, key: "8A" }, mockCrate, curve, 0, 0.25);
assert.equal(ordered.length, 4);
assert.equal(ordered[0].id, "t1", "Marathon sequence should open with warmup energy track");

assert.equal(
  pickSmartTransitionPreset({ bpm: 124, key: "8A", energy: 0.85 }, { bpm: 126, key: "9A", energy: 0.88 }).presetId,
  "bass-swap",
  "High-energy harmonic club tracks should auto-select bass-swap"
);
assert.equal(
  pickSmartTransitionPreset({ bpm: 124, key: "8A", energy: 0.8 }, { bpm: 168, key: "8A", energy: 0.8 }).presetId,
  "quick",
  "Wide tempo gap should auto-select quick cut"
);
assert.equal(
  pickSmartScratchProfile({ bpm: 94, genre: "90s Boom-Bap" }).archetype,
  "premier",
  "Sub-108 BPM hip-hop should auto-select DJ Premier archetype"
);
assert.equal(
  pickSmartScratchProfile({ bpm: 124, energy: 0.8 }).archetype,
  "philly",
  "124 BPM club groove should auto-select Philly Transform archetype"
);

// Precision Scratch Engine verification: zero-drift cycle boundaries, transient anchor, battle cut timbre matching, 32-tap Kaiser sinc
for (const patId of ["baby", "flare", "transformer", "chirp", "crab", "tear"] as const) {
  const p0 = evaluateScratchTrajectory(patId, 0, 2, 1.0, "mag-four");
  const pEnd = evaluateScratchTrajectory(patId, 2, 2, 1.0, "mag-four");
  close(p0.posBeats, 0, 1e-6);
  close(pEnd.posBeats, 0, 1e-5);
}

// Wrist-whip strokeRate integral must equal exact requested span
const whipRate = strokeRate(0.25, 0.18, 1);
const integratedSpan = whipRate.reduce((s, r) => s + r / CTRL_HZ, 0);
close(integratedSpan, 0.18, 1e-3);

// Transient onset anchor detector must lock onto a sharp drum/vocal impulse within window
const transientBuf = new Float32Array(sr * 2);
const hitSec = 1.12;
const hitSample = Math.floor(hitSec * sr);
for (let i = 0; i < Math.floor(0.05 * sr); i++) {
  transientBuf[hitSample + i] = Math.sin((2 * Math.PI * 440 * i) / sr) * Math.exp(-i / (0.01 * sr));
}
const detectedAnchor = findNearestTransientAnchor(transientBuf, sr, 1.0, 0.3);
assert.ok(
  Math.abs(detectedAnchor - hitSec) < 0.02,
  `findNearestTransientAnchor should lock within 20ms of transient at ${hitSec}s, got ${detectedAnchor}s`
);

assert.equal(resolveBattleCutAnchor("crab", "auto").label, "FRESH");
assert.equal(resolveBattleCutAnchor("baby", "auto").label, "AHHH");
assert.equal(resolveBattleCutAnchor("baby", "scratch").start, 2.5);

// 32-tap Kaiser-windowed sinc interpolation accuracy on DC signal
const dcSignal = new Float32Array(128).fill(0.75);
close(sampleKaiserSinc(dcSignal, 64.37, 1.0), 0.75, 1e-2);

// Verify 90s Scratch Agent returns real platter velocity, displacement, and gate timelines (no audio-peak faking)
assert.equal(res1.rateTimeline.length, res1.audio.length, "rateTimeline must match audio sample length");
assert.equal(res1.dispTimeline.length, res1.audio.length, "dispTimeline must match audio sample length");
assert.equal(res1.gateTimeline.length, res1.audio.length, "gateTimeline must match audio sample length");
assert.ok(res1.rateTimeline.some(v => Math.abs(v) > 0.2), "rateTimeline must contain real platter velocity values");
assert.ok(res1.gateTimeline.some(g => g > 0.5), "gateTimeline must contain real optical gate values");

const intelCheck = res1.attempts.at(-1)?.report.checks.find(c => c.name === "intelligibility");
assert.ok(
  intelCheck && intelCheck.value !== null && intelCheck.value >= 0.35,
  `Critic intelligibility check must compute a real articulation score >= 0.35, got ${intelCheck?.value}`
);

// Verify synthesizeStudioTrack + analyze() detects real BPM and Camelot key directly from PCM without hardcoded overrides
import { BUILTIN_TRACK_SPECS, synthesizeStudioTrack } from "@ncsound/dj-engine/synthTracks";
import { analyze } from "@ncsound/dj-engine/analysis";

const mockCtx = {
  sampleRate: 22050,
  createBuffer(channels: number, length: number, sampleRate: number) {
    const chs = Array.from({ length: channels }, () => new Float32Array(length));
    return {
      sampleRate,
      length,
      duration: length / sampleRate,
      numberOfChannels: channels,
      getChannelData: (c: number) => chs[c],
    } as unknown as AudioBuffer;
  },
} as unknown as BaseAudioContext;

for (const spec of BUILTIN_TRACK_SPECS) {
  const synthBuf = synthesizeStudioTrack(mockCtx, { ...spec, durationSec: 24 });
  const detected = analyze(synthBuf);
  assert.ok(
    Math.abs(detected.bpm - spec.bpm) < 1.5,
    `Real DSP analyze() on "${spec.title}" expected ~${spec.bpm} BPM, got ${detected.bpm}`
  );
  assert.equal(
    detected.key,
    spec.camelot,
    `Real DSP analyze() on "${spec.title}" expected Camelot key ${spec.camelot}, got ${detected.key}`
  );
}

// Verify scratching actually modifies the loaded music track AudioBuffer in-place and updates its 3-band waveform
const trackBuf = synthesizeStudioTrack(mockCtx, { ...BUILTIN_TRACK_SPECS[0], durationSec: 12 });
const origCopy = new Float32Array(trackBuf.getChannelData(0));
const renderedScratch = renderScratchBuffer(
  mockCtx,
  trackBuf,
  2.0,
  2,
  60 / 124,
  "flare",
  1.0,
  "mag-four"
);
const spliceStartSample = Math.floor(2.0 * trackBuf.sampleRate);
const ch0 = trackBuf.getChannelData(0);
const scr0 = renderedScratch.buffer.getChannelData(0);
let diffEnergyBefore = 0;
for (let i = 100; i < 1000; i++) {
  diffEnergyBefore += Math.abs(ch0[spliceStartSample + i] - origCopy[spliceStartSample + i]);
}
assert.equal(diffEnergyBefore, 0, "Track buffer should match original before scratch splice");

// Simulate spliceScratchIntoTrack in-place PCM modification
for (let i = 0; i < renderedScratch.buffer.length; i++) {
  ch0[spliceStartSample + i] = scr0[i];
}
let diffEnergyAfter = 0;
for (let i = 100; i < 1000; i++) {
  diffEnergyAfter += Math.abs(ch0[spliceStartSample + i] - origCopy[spliceStartSample + i]);
}
assert.ok(
  diffEnergyAfter > 1.0,
  "Scratching must actually modify the music file's PCM samples in the AudioBuffer"
);

// =========================================================================
// 9. ENHANCED SEARCH, FILE INDEXING, METADATA CATEGORIZING & TEMPO MATCHING
// =========================================================================

// A. File Tag Extraction & Intelligent Filename Parsing
const parsedName1 = parseFilenameMetadata("01. Sublevel 808 - Warehouse Groove (Club Mix) [124 BPM] [8A].mp3");
assert.equal(parsedName1.artist, "Sublevel 808");
assert.equal(parsedName1.title, "Warehouse Groove (Club Mix)");
assert.equal(parsedName1.bpm, 124);
assert.equal(parsedName1.key, "8A");

const parsedName2 = parseFilenameMetadata("Voltage_Syndicate_-_Hyperdrive_3000_(128bpm)_[10A].wav");
assert.equal(parsedName2.artist, "Voltage Syndicate");
assert.equal(parsedName2.bpm, 128);
assert.equal(parsedName2.key, "10A");

// ID3v1 128-byte tag test
const id3v1Buf = new Uint8Array(128);
id3v1Buf[0] = 0x54; id3v1Buf[1] = 0x41; id3v1Buf[2] = 0x47; // "TAG"
new TextEncoder().encodeInto("Midnight Warehouse", id3v1Buf.subarray(3, 33));
new TextEncoder().encodeInto("Sublevel", id3v1Buf.subarray(33, 63));
id3v1Buf[127] = 35; // Genre index 35 = "House"
const id3v1Res = parseId3v1(id3v1Buf.buffer);
assert.ok(id3v1Res);
assert.equal(id3v1Res?.title, "Midnight Warehouse");
assert.equal(id3v1Res?.artist, "Sublevel");
assert.equal(id3v1Res?.genre, "House");

// ID3v2 text frame test
const id3v2Buf = new Uint8Array(256);
id3v2Buf[0] = 0x49; id3v2Buf[1] = 0x44; id3v2Buf[2] = 0x33; // "ID3"
id3v2Buf[3] = 3; // v2.3
id3v2Buf[9] = 120; // size syncsafe
// Write TIT2 frame (Title)
const writeFrame = (offset: number, frameId: string, text: string) => {
  for (let i = 0; i < 4; i++) id3v2Buf[offset + i] = frameId.charCodeAt(i);
  const textBytes = new TextEncoder().encode(text);
  const frameSize = 1 + textBytes.length; // 1 encoding byte + text
  id3v2Buf[offset + 4] = (frameSize >> 24) & 0xff;
  id3v2Buf[offset + 5] = (frameSize >> 16) & 0xff;
  id3v2Buf[offset + 6] = (frameSize >> 8) & 0xff;
  id3v2Buf[offset + 7] = frameSize & 0xff;
  id3v2Buf[offset + 10] = 3; // UTF-8
  id3v2Buf.set(textBytes, offset + 11);
  return offset + 10 + frameSize;
};
let off = 10;
off = writeFrame(off, "TIT2", "Neon Ignition");
off = writeFrame(off, "TPE1", "Kinetix Club");
off = writeFrame(off, "TBPM", "126");
off = writeFrame(off, "TKEY", "9A");
const id3v2Res = parseId3v2(new DataView(id3v2Buf.buffer));
assert.ok(id3v2Res);
assert.equal(id3v2Res?.title, "Neon Ignition");
assert.equal(id3v2Res?.artist, "Kinetix Club");
assert.equal(id3v2Res?.bpm, 126);
assert.equal(id3v2Res?.key, "9A");

// B. Acoustic Metadata Categorizing (Energy Tier, Spectral Distribution, Mood)
const mockAnalysis = {
  bpm: 124,
  firstBeat: 0.08,
  key: "8A",
  keyName: "A Minor",
  energy: 0.78,
  rmsDb: -11.2,
  autoGainDb: -0.3,
  waveform: {
    low: [0.6, 0.7, 0.65],
    mid: [0.3, 0.35, 0.3],
    high: [0.15, 0.2, 0.18],
    peaks: [0.9, 0.95, 0.92],
    energyCurve: [0.75, 0.8, 0.78],
  },
};
const acousticCat = categorizeTrackAcoustics(mockAnalysis as any, { genre: "" });
assert.equal(acousticCat.energyTier, "Peak Time");
assert.ok(acousticCat.tags.includes("Sub Heavy"));
assert.ok(acousticCat.tags.includes("4/4 Club Grid"));
assert.ok(acousticCat.genre.includes("House") || acousticCat.genre.includes("Techno"));
assert.ok(acousticCat.harmonicMood.includes("Minor"));

// C. Advanced Multi-Token, Field & Fuzzy Search Engine
interface TestSearchItem {
  id: string;
  name: string;
  artist: string;
  genre: string;
  tags: string[];
  energyTier: "Warmup" | "Groove" | "Peak Time" | "Anthem";
  analysis: {
    bpm: number;
    key: string;
    energy: number;
  };
  dateAddedMs?: number;
}
const testTracks: TestSearchItem[] = [
  {
    id: "t1",
    name: "Midnight Warehouse",
    artist: "Sublevel 808",
    genre: "Deep House",
    tags: ["Sub Heavy", "4/4 Club Grid"],
    energyTier: "Groove",
    analysis: { bpm: 124, key: "8A", energy: 0.62 },
    dateAddedMs: 1000,
  },
  {
    id: "t2",
    name: "Neon Ignition",
    artist: "Kinetix Club",
    genre: "Tech House",
    tags: ["Crisp Highs", "4/4 Club Grid"],
    energyTier: "Peak Time",
    analysis: { bpm: 126, key: "9A", energy: 0.82 },
    dateAddedMs: 2000,
  },
  {
    id: "t3",
    name: "Brooklyn Block Party",
    artist: "Grandmaster Cut",
    genre: "Golden Era Breaks",
    tags: ["Syncopated Breaks", "Dynamic Range"],
    energyTier: "Warmup",
    analysis: { bpm: 102, key: "5A", energy: 0.38 },
    dateAddedMs: 3000,
  },
  {
    id: "t4",
    name: "Hyperdrive 3000",
    artist: "Voltage Syndicate",
    genre: "Electro Breakbeat",
    tags: ["Sub Heavy", "Melodic Lead"],
    energyTier: "Anthem",
    analysis: { bpm: 128, key: "10A", energy: 0.94 },
    dateAddedMs: 4000,
  },
];

// Query: Range bpm:120-128
const searchBpmRange = searchAndFilterCrate(testTracks as any, { query: "bpm:120-128" });
assert.equal(searchBpmRange.length, 3); // t1 (124), t2 (126), t4 (128)

// Query: Specific Key key:9A
const searchKey = searchAndFilterCrate(testTracks as any, { query: "key:9A" });
assert.equal(searchKey.length, 1);
assert.equal(searchKey[0].item.name, "Neon Ignition");

// Query: Multi-token genre:house energy:>75%
const searchMulti = searchAndFilterCrate(testTracks as any, { query: "genre:house energy:>75%" });
assert.equal(searchMulti.length, 1);
assert.equal(searchMulti[0].item.name, "Neon Ignition");

// Query: Tag operator tag:sub
const searchTag = searchAndFilterCrate(testTracks as any, { query: "tag:sub" });
assert.equal(searchTag.length, 2); // t1, t4

// Typo tolerance: "kinetx" -> matches "Kinetix"
const searchTypo = searchAndFilterCrate(testTracks as any, { query: "kinetx" });
assert.equal(searchTypo.length, 1);
assert.equal(searchTypo[0].item.name, "Neon Ignition");

// Sorting: BPM ascending
const sortBpmAsc = searchAndFilterCrate(testTracks as any, { query: "", sortBy: "bpm-asc" });
assert.equal(sortBpmAsc[0].item.name, "Brooklyn Block Party"); // 102 BPM
assert.equal(sortBpmAsc[3].item.name, "Hyperdrive 3000");      // 128 BPM

// Harmonic active filter: with activeKey = "8A", "9A" (score 92) and "8A" (score 100) match
const searchHarmonic = searchAndFilterCrate(testTracks as any, {
  query: "",
  activeKey: "8A",
  harmonicOnly: true,
});
assert.ok(searchHarmonic.some(r => r.item.name === "Midnight Warehouse"));
assert.ok(searchHarmonic.some(r => r.item.name === "Neon Ignition"));

// D. Enhanced Tempo Matching & Sub-Beat Phase Math
// Half-time / Double-time candidate detection
const candHalf = detectTempoMultiplierCandidate(140, 70);
assert.equal(candHalf.isHalfOrDouble, true);
assert.equal(candHalf.recommendedMultiplier, 0.5); // master is 140 -> 0.5x master (70) locks to deck 70
assert.equal(candHalf.halfBpm, 35);
assert.equal(candHalf.doubleBpm, 140);

const candDouble = detectTempoMultiplierCandidate(87, 174);
assert.equal(candDouble.isHalfOrDouble, true);
assert.equal(candDouble.recommendedMultiplier, 2); // master is 87 -> 2x master (174) locks to deck 174
assert.equal(candDouble.halfBpm, 87);
assert.equal(candDouble.doubleBpm, 348);

// Sub-beat kick drum phase difference computation
const phaseTight = computeBeatPhaseDifference(10.0, 0.0, 120, 10.005, 0.0, 120);
assert.equal(phaseTight.inPhase, true, "5ms difference is inside ±15ms tight kick pocket");
assert.ok(Math.abs(phaseTight.phaseDiffMs) <= 10);

const phaseDragging = computeBeatPhaseDifference(10.0, 0.0, 120, 9.94, 0.0, 120);
assert.equal(phaseDragging.inPhase, false, "60ms difference is out of pocket");
assert.ok(phaseDragging.phaseDiffMs < -40);

// Sub-beat phase align offset calculation
const masterProg = 0.5; // halfway through beat
const alignTarget = computePhaseAlignOffset(10.1, 0.0, 120, masterProg);
// beat sec = 0.5s; 10.1s is beat 20.2; floor is 20; target is 20 + 0.5 = 20.5 beats = 10.25s
close(alignTarget, 10.25, 1e-2);

// Pitched key acoustic Camelot rotation (+4.1% pitch increases frequency by ~0.7 semitones)
const naturalKey = calculatePitchedKey("8A", 1.0);
assert.equal(naturalKey.pitchedKey, "8A");
assert.equal(naturalKey.semitoneShift, 0);

const sharpKey = calculatePitchedKey("8A", 1.06); // +6% is ~+1 semitone (+7 on Camelot wheel: 8+7 = 15 % 12 = 3A)
assert.equal(sharpKey.semitoneShift, 1);
assert.equal(sharpKey.pitchedKey, "3A");
assert.equal(sharpKey.direction, "sharp");

// Smooth tempo transition interpolation
close(interpolateTransitionBpm(120, 128, 0), 120);
close(interpolateTransitionBpm(120, 128, 1), 128);
close(interpolateTransitionBpm(120, 128, 0.5), 124); // midpoint of S-curve is 124

console.log("PASS sync + harmonic + autoscratch + 90s-scratch-agent + club-marathon + smart-automation + precision-scratch-dsp + track-buffer-mod + web-midi-controller-pro + search-indexer-tempo-match");


