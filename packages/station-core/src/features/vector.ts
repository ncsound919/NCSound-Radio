/**
 * Audio-feature fingerprint for "similar tracks" (Vectorize phase 3 / roadmap D1).
 *
 * A fixed 32-dimension vector derived from the engine's own `TrackAnalysis`:
 * 8 scalars (tempo, key on the circle of fifths, energy, loudness, 3-band
 * balance) plus a 24-bin resample of the energy curve (a loudness-shape
 * fingerprint that captures intro / breakdown / drop structure). Cosine
 * similarity over it is a "sounds like" signal without any audio-feature model.
 *
 * Dimension count is fixed (Vectorize requires >= 32). Missing inputs produce a
 * neutral 0 for that dimension rather than throwing — an unanalysed track still
 * yields a usable (if thin) vector.
 */
import type { TrackAnalysis } from "../contract/track";

export const FEATURE_DIMENSIONS = 32;
const CURVE_BINS = 24;

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

function mean(values: Float32Array | undefined): number {
  if (!values || values.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < values.length; i++) sum += values[i];
  return clamp01(sum / values.length);
}

/**
 * Camelot key ("8A", "12B") onto a 24-position circle: 12 major then 12 minor,
 * so harmonically adjacent keys are close. Unknown/absent returns the origin.
 */
function keyCircle(key?: string): { sin: number; cos: number } {
  if (!key) return { sin: 0, cos: 0 };
  const m = /^\s*(\d{1,2})\s*([AB])\s*$/i.exec(key);
  if (!m) return { sin: 0, cos: 0 };
  const n = Number(m[1]);
  if (n < 1 || n > 12) return { sin: 0, cos: 0 };
  const pos = n - 1 + (m[2].toUpperCase() === "B" ? 0 : 12);
  const angle = (2 * Math.PI * pos) / 24;
  return { sin: Math.sin(angle), cos: Math.cos(angle) };
}

/** Average the curve into `bins` equal slices, independent of input length. */
function resample(values: Float32Array | undefined, bins: number): number[] {
  const out = new Array<number>(bins).fill(0);
  if (!values || values.length === 0) return out;
  const per = values.length / bins;
  for (let b = 0; b < bins; b++) {
    const start = Math.floor(b * per);
    const end = Math.min(values.length, Math.max(start + 1, Math.floor((b + 1) * per)));
    let sum = 0;
    let n = 0;
    for (let i = start; i < end; i++) {
      sum += values[i];
      n++;
    }
    out[b] = n ? clamp01(sum / n) : 0;
  }
  return out;
}

export function trackFeatureVector(a: TrackAnalysis): number[] {
  const key = keyCircle(a.key ?? a.keyName);
  const curve = resample(a.waveform?.energyCurve, CURVE_BINS);
  const scalars = [
    clamp01((a.bpm - 60) / 140),
    key.sin,
    key.cos,
    clamp01(a.energy ?? 0),
    clamp01(((a.rmsDb ?? -60) + 60) / 60),
    mean(a.waveform?.low),
    mean(a.waveform?.mid),
    mean(a.waveform?.high),
  ];
  return [...scalars, ...curve];
}

export function isFeatureVector(v: unknown): v is number[] {
  return (
    Array.isArray(v) &&
    v.length === FEATURE_DIMENSIONS &&
    v.every((n) => typeof n === "number" && Number.isFinite(n))
  );
}
