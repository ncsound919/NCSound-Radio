import { describe, expect, test } from "bun:test";
import { FEATURE_DIMENSIONS, isFeatureVector, trackFeatureVector } from "../src/features/vector";
import type { TrackAnalysis } from "../src/contract/track";

function analysis(over: Partial<TrackAnalysis> = {}): TrackAnalysis {
  const curve = new Float32Array(480);
  for (let i = 0; i < curve.length; i++) curve[i] = i / curve.length;
  return {
    bpm: 124,
    firstBeat: 0.4,
    key: "8A",
    energy: 0.7,
    rmsDb: -9,
    waveform: {
      low: new Float32Array([0.8, 0.9]),
      mid: new Float32Array([0.5, 0.6]),
      high: new Float32Array([0.2, 0.3]),
      peaks: new Float32Array([1]),
      energyCurve: curve,
    },
    ...over,
  };
}

const cos = (x: number[], y: number[]) =>
  x.reduce((s, xi, i) => s + xi * y[i], 0) / (Math.hypot(...x) * Math.hypot(...y));

describe("trackFeatureVector", () => {
  test("is a fixed-length vector of finite numbers", () => {
    const v = trackFeatureVector(analysis());
    expect(v).toHaveLength(FEATURE_DIMENSIONS);
    expect(v.every((n) => Number.isFinite(n))).toBe(true);
    expect(isFeatureVector(v)).toBe(true);
  });

  test("is deterministic, and a thin analysis still yields a valid vector", () => {
    expect(trackFeatureVector(analysis())).toEqual(trackFeatureVector(analysis()));
    expect(isFeatureVector(trackFeatureVector({ bpm: 90, firstBeat: 0 }))).toBe(true);
  });

  test("a nearby track is closer than a distant one", () => {
    const a = trackFeatureVector(analysis());
    const near = trackFeatureVector(analysis({ bpm: 126, energy: 0.71 }));
    const far = trackFeatureVector(analysis({ bpm: 90, key: "3B", energy: 0.2, rmsDb: -24 }));
    expect(cos(a, near)).toBeGreaterThan(cos(a, far));
  });
});
