import assert from "node:assert/strict";
import {
  interpolateEnergyCurve,
  pickNextMarathonTrack,
  pickSmartScratchProfile,
  pickSmartTransitionPreset,
  scoreNextTrackCandidate,
  sequenceCrateForParty,
} from "@ncsound/dj-engine/marathon";
import {
  categorizeTrackAcoustics,
  searchAndFilterCrate,
} from "../src/engine/crateIndexer";
import type { CrateIndexRecord } from "../src/engine/crateIndexer";
import type { EnergyTier, TrackAnalysis } from "../src/engine/types";

console.log("=== Testing Marathon DJ Engine & Crate Indexer ===");

// 1. Energy Curve Interpolation Tests
const pregameCurve = [0.6, 0.8, 0.9];
const warmUp0 = interpolateEnergyCurve(pregameCurve, 0.0);
const warmUpHalf = interpolateEnergyCurve(pregameCurve, 0.5);
const warmUp1 = interpolateEnergyCurve(pregameCurve, 1.0);
assert.ok(warmUp0 < warmUpHalf && warmUpHalf < warmUp1, "Pregame energy tier must curve upward");

const peakCurve = [0.92, 1.0, 0.95];
const peak0 = interpolateEnergyCurve(peakCurve, 0.5);
assert.ok(peak0 >= 0.85, "Peak-hour energy curve must maintain high intensity");

const wildCurve = [0.3, 0.4, 0.4, 0.3];
const wild0 = interpolateEnergyCurve(wildCurve, 0.2);
assert.ok(wild0 >= 0.1 && wild0 <= 1.0, "Wildcard curve produces valid energy values");

// 2. Track Candidate Scoring Tests
const currentAnalysis: TrackAnalysis = {
  bpm: 124.0,
  key: "8A",
  energy: 0.7,
  danceability: 0.8,
  spectralCentroid: 2500,
  rmsEnergy: 0.5,
  hasHeavyBass: true,
};

const candidateA: TrackAnalysis = {
  bpm: 125.0,
  key: "8A", // Exact key match
  energy: 0.75,
  danceability: 0.85,
  spectralCentroid: 2600,
  rmsEnergy: 0.55,
  hasHeavyBass: true,
};

const candidateB: TrackAnalysis = {
  bpm: 140.0, // Huge BPM gap (16 BPM away)
  key: "2B",  // Key mismatch
  energy: 0.2,
  danceability: 0.3,
  spectralCentroid: 1000,
  rmsEnergy: 0.2,
  hasHeavyBass: false,
};

const mockCandA = {
  id: "cand-a",
  name: "Candidate A",
  analysis: candidateA,
  playCount: 0,
};

const mockCandB = {
  id: "cand-b",
  name: "Candidate B",
  analysis: candidateB,
  playCount: 0,
};

const scoreA = scoreNextTrackCandidate(
  { bpm: 124.0, key: "8A" },
  mockCandA,
  0.75,
  Date.now(),
  0
);

const scoreB = scoreNextTrackCandidate(
  { bpm: 124.0, key: "8A" },
  mockCandB,
  0.75,
  Date.now(),
  0
);

assert.ok(scoreA.total > scoreB.total, "Exact key and small BPM gap candidate must score significantly higher than distant candidate");

// 3. Smart Transition & Scratch Profile Selection
const transitionPreset = pickSmartTransitionPreset(
  { bpm: 124.0, key: "8A", energy: 0.75 },
  { bpm: 125.0, key: "8A", energy: 0.85 },
  ["smooth"]
);
assert.ok(transitionPreset.presetId.length > 0, "Selected transition preset must have a valid presetId");
assert.ok(transitionPreset.reason.length > 0, "Transition preset must specify selection reason");

const scratchProfile = pickSmartScratchProfile({ bpm: 124, energy: 0.75, genre: "Techno" });
assert.ok(scratchProfile.archetype.length > 0, "Selected scratch profile must specify archetype");
assert.ok(scratchProfile.bars > 0, "Scratch profile must specify bars");

// 4. Crate Sequence Generation for Party
const mockCrate: CrateIndexRecord[] = [
  {
    id: "t1",
    name: "Intro Beats",
    artist: "DJ One",
    genre: "House",
    tags: ["intro", "groovy"],
    energyTier: "warm-up",
    analysis: { bpm: 120, key: "8A", energy: 0.4, danceability: 0.6, spectralCentroid: 1800, rmsEnergy: 0.3 },
    playCount: 0,
    dateAddedMs: Date.now() - 1000,
  },
  {
    id: "t2",
    name: "Build Up Anthem",
    artist: "DJ Two",
    genre: "Tech House",
    tags: ["build", "tech"],
    energyTier: "build",
    analysis: { bpm: 123, key: "8A", energy: 0.65, danceability: 0.75, spectralCentroid: 2400, rmsEnergy: 0.5 },
    playCount: 0,
    dateAddedMs: Date.now() - 800,
  },
  {
    id: "t3",
    name: "Peak Pressure",
    artist: "DJ Three",
    genre: "Techno",
    tags: ["peak", "heavy"],
    energyTier: "peak-hour",
    analysis: { bpm: 126, key: "9A", energy: 0.9, danceability: 0.88, spectralCentroid: 3200, rmsEnergy: 0.8 },
    playCount: 0,
    dateAddedMs: Date.now() - 600,
  },
  {
    id: "t4",
    name: "Afterhour Drift",
    artist: "DJ Four",
    genre: "Deep House",
    tags: ["cooldown", "chill"],
    energyTier: "cooldown",
    analysis: { bpm: 121, key: "9A", energy: 0.35, danceability: 0.5, spectralCentroid: 1500, rmsEnergy: 0.25 },
    playCount: 0,
    dateAddedMs: Date.now() - 400,
  },
];

const sequenced = sequenceCrateForParty(
  { bpm: 120, key: "8A" },
  mockCrate,
  [0.4, 0.6, 0.8, 0.9],
  0
);
assert.ok(sequenced.length > 0, "Sequenced setlist must contain tracks");

// 5. Crate Search & Acoustic Categorization Tests
const acoustics = categorizeTrackAcoustics({
  bpm: 128,
  key: "11A",
  energy: 0.85,
  danceability: 0.82,
  spectralCentroid: 3100,
  rmsEnergy: 0.7,
});
assert.equal(acoustics.energyTier, "Anthem", "High energy track must categorize as Anthem");
assert.ok(acoustics.tags.includes("4/4 Club Grid"), "High energy track tags must include club grid");

// Search filtering
const filteredByQuery = searchAndFilterCrate(mockCrate, { query: "Pressure" });
assert.equal(filteredByQuery.length, 1, "Filter by query 'Pressure' must return exactly 1 item");
assert.equal(filteredByQuery[0].item.id, "t3");

const filteredByBpm = searchAndFilterCrate(mockCrate, { query: "", bpmMin: 122, bpmMax: 125 });
assert.equal(filteredByBpm.length, 1, "Filter by BPM range 122-125 must return 1 item");
assert.equal(filteredByBpm[0].item.id, "t2");

const filteredByKey = searchAndFilterCrate(mockCrate, { query: "key:8A" });
assert.equal(filteredByKey.length, 2, "Filter by key '8A' must return 2 items");

console.log("All Marathon DJ Engine & Crate Indexer unit tests passed successfully!");
