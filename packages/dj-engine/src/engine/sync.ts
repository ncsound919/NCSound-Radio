import type { PhaseDifferenceInfo, PitchFaderRange } from "./types";

/** Pure sync & Camelot harmonic math (unit-tested; no Web Audio here). */
export const MAX_STRETCH = 0.08; // default ±8% auto-tempo range

export interface RatePickResult {
  rate: number;
  effBpm: number;
  clamped: boolean;
  multiplier: 1 | 2 | 0.5;
  naturalRate: number;
}

/**
 * Pick the playback rate that locks the incoming track to the outgoing deck's
 * *effective* tempo, allowing half/double-time matches. Clamped to ±maxStretch.
 */
export function pickRate(
  fromEffBpm: number,
  toBpm: number,
  maxStretch = MAX_STRETCH
): RatePickResult {
  let bestRate = 1;
  let bestErr = Infinity;
  let bestMult: 1 | 2 | 0.5 = 1;

  for (const m of [1, 2, 0.5] as const) {
    const r = (fromEffBpm * m) / toBpm;
    const err = Math.abs(Math.log(r));
    if (err < bestErr) {
      bestErr = err;
      bestRate = r;
      bestMult = m;
    }
  }

  const rate = Math.min(1 + maxStretch, Math.max(1 - maxStretch, bestRate));
  const clamped = Math.abs(bestRate - 1) > maxStretch;
  return {
    rate,
    effBpm: toBpm * rate,
    clamped,
    multiplier: bestMult,
    naturalRate: bestRate,
  };
}

/**
 * Picks the exact sync playback rate that makes both decks' BPM 100% identical.
 * When multiplier is not forced, chooses straight (1x), half (0.5x), or double (2x)
 * to achieve the closest natural tempo match without arbitrary pitch range clamping.
 */
export function pickExactSyncRate(
  targetBpm: number,
  nativeBpm: number,
  multiplier?: 1 | 2 | 0.5
): { rate: number; effBpm: number; multiplier: 1 | 2 | 0.5 } {
  if (nativeBpm <= 0) return { rate: 1, effBpm: targetBpm, multiplier: 1 };

  let mult: 1 | 2 | 0.5 = multiplier ?? 1;
  if (!multiplier) {
    let bestDist = Math.abs((targetBpm / nativeBpm) - 1);
    for (const m of [1, 2, 0.5] as const) {
      const dist = Math.abs(((targetBpm * m) / nativeBpm) - 1);
      if (dist < bestDist) {
        bestDist = dist;
        mult = m;
      }
    }
  }

  const exactRate = (targetBpm * mult) / nativeBpm;
  return {
    rate: exactRate,
    effBpm: +(nativeBpm * exactRate).toFixed(2),
    multiplier: mult,
  };
}

/**
 * Detects if two tempos have a half-time (e.g. 70 vs 140) or double-time (e.g. 174 vs 87)
 * relationship and returns candidate matching options.
 */
export function detectTempoMultiplierCandidate(
  masterBpm: number,
  deckBpm: number
): {
  recommendedMultiplier: 1 | 2 | 0.5;
  isHalfOrDouble: boolean;
  halfBpm: number;
  doubleBpm: number;
  straightBpm: number;
  rateStraight: number;
  rateHalf: number;
  rateDouble: number;
} {
  const straight = masterBpm / deckBpm;
  const half = (masterBpm * 0.5) / deckBpm;
  const double = (masterBpm * 2.0) / deckBpm;

  let bestMult: 1 | 2 | 0.5 = 1;
  let minDiff = Math.abs(straight - 1);

  if (Math.abs(half - 1) < minDiff) {
    minDiff = Math.abs(half - 1);
    bestMult = 0.5;
  }
  if (Math.abs(double - 1) < minDiff) {
    bestMult = 2;
  }

  const isHalfOrDouble = bestMult !== 1;

  return {
    recommendedMultiplier: bestMult,
    isHalfOrDouble,
    halfBpm: +(deckBpm * 0.5).toFixed(1),
    doubleBpm: +(deckBpm * 2.0).toFixed(1),
    straightBpm: +deckBpm.toFixed(1),
    rateStraight: +straight.toFixed(4),
    rateHalf: +half.toFixed(4),
    rateDouble: +double.toFixed(4),
  };
}

/**
 * Computes instantaneous beat phase difference between two active decks.
 * Returns relative phase in beats (-0.5 .. +0.5) and in milliseconds,
 * and indicates whether the two kick drums are tightly in-phase (within ±15ms).
 */
export function computeBeatPhaseDifference(
  masterCurrentOffset: number,
  masterFirstBeat: number,
  masterBpm: number,
  deckCurrentOffset: number,
  deckFirstBeat: number,
  deckBpm: number
): PhaseDifferenceInfo {
  const masterBeatSec = 60 / Math.max(20, masterBpm);
  const deckBeatSec = 60 / Math.max(20, deckBpm);

  // Beat phase progress in [0, 1)
  const masterProgress = ((((masterCurrentOffset - masterFirstBeat) / masterBeatSec) % 1) + 1) % 1;
  const deckProgress = ((((deckCurrentOffset - deckFirstBeat) / deckBeatSec) % 1) + 1) % 1;

  // Wrapped phase difference: -0.5 .. +0.5 beats (negative = deck is dragging behind, positive = deck is ahead)
  let diff = deckProgress - masterProgress;
  if (diff > 0.5) diff -= 1;
  if (diff < -0.5) diff += 1;

  const phaseDiffMs = +(diff * masterBeatSec * 1000).toFixed(1);
  const inPhase = Math.abs(phaseDiffMs) <= 15;

  return {
    phaseDiffBeats: +diff.toFixed(4),
    phaseDiffMs,
    inPhase,
    masterBeatProgress: +masterProgress.toFixed(4),
    deckBeatProgress: +deckProgress.toFixed(4),
  };
}

/**
 * Calculates the exact playhead seek offset needed to lock a deck's beat phase
 * into alignment with masterBeatProgress without stopping playback.
 */
export function computePhaseAlignOffset(
  deckCurrentOffset: number,
  deckFirstBeat: number,
  deckBpm: number,
  masterBeatProgress: number
): number {
  const deckBeatSec = 60 / Math.max(20, deckBpm);
  const deckBeats = (deckCurrentOffset - deckFirstBeat) / deckBeatSec;
  const targetBeats = Math.floor(deckBeats) + masterBeatProgress;
  return Math.max(0, +(deckFirstBeat + targetBeats * deckBeatSec).toFixed(3));
}

/**
 * Calculates the acoustically shifted musical key when vinyl/analog pitch changes playback speed
 * (1 semitone = 7 steps along the Circle of Fifths / Camelot Wheel).
 */
export function calculatePitchedKey(
  originalKey: string,
  rate: number
): {
  pitchedKey: string;
  semitoneShift: number;
  cents: number;
  direction: "flat" | "sharp" | "neutral";
} {
  const m = /^(\d{1,2})([AB])$/.exec(originalKey.trim());
  if (!m || rate <= 0) {
    return { pitchedKey: originalKey, semitoneShift: 0, cents: 0, direction: "neutral" };
  }
  const num = parseInt(m[1], 10);
  const letter = m[2];

  // Total semitones shifted = 12 * log2(rate)
  const totalSemi = 12 * (Math.log(rate) / Math.LN2);
  const roundedSemi = Math.round(totalSemi);
  const cents = Math.round((totalSemi - roundedSemi) * 100);

  // Each +1 semitone rotates the Camelot wheel by +7 steps; -1 semitone rotates by +5 (-7)
  let pitchedNum = (num + (roundedSemi * 7)) % 12;
  if (pitchedNum <= 0) pitchedNum += 12;

  const direction = totalSemi > 0.05 ? "sharp" : totalSemi < -0.05 ? "flat" : "neutral";

  return {
    pitchedKey: `${pitchedNum}${letter}`,
    semitoneShift: roundedSemi,
    cents,
    direction,
  };
}

/**
 * Smoothly interpolates master BPM during crossfader transition so tempo doesn't jerk.
 */
export function interpolateTransitionBpm(
  fromBpm: number,
  toBpm: number,
  progress01: number,
  curve: "equal-power" | "linear" | "smooth" = "smooth"
): number {
  const p = Math.max(0, Math.min(1, progress01));
  let w = p;
  if (curve === "smooth") {
    // S-curve smoothstep: 3p^2 - 2p^3
    w = p * p * (3 - 2 * p);
  } else if (curve === "equal-power") {
    w = Math.sin((p * Math.PI) * 0.5);
  }
  return +(fromBpm + (toBpm - fromBpm) * w).toFixed(2);
}

/** Earliest bar line at or after now+lead, on a grid anchored at `anchor`. */
export function nextBarTime(now: number, anchor: number, secPerBar: number, lead = 0.1) {
  const k = Math.ceil(Math.max(0, now + lead - anchor) / secPerBar - 1e-9);
  return anchor + k * secPerBar;
}

/** Earliest beat line at or after now+lead, on a beat grid anchored at `anchor`. */
export function nextBeatTime(now: number, anchor: number, secPerBeat: number, lead = 0.04) {
  const k = Math.ceil(Math.max(0, now + lead - anchor) / secPerBeat - 1e-9);
  return anchor + k * secPerBeat;
}

export interface HarmonicMatch {
  tier: "perfect" | "harmonic" | "energy-boost" | "wide";
  score: number; // 0..100
  label: string;
}

/**
 * Evaluates Camelot wheel harmonic distance between two tracks (e.g., "8A" and "9A").
 */
export function evaluateHarmonicMatch(fromKey?: string, toKey?: string): HarmonicMatch {
  if (!fromKey || !toKey) {
    return { tier: "harmonic", score: 80, label: "Harmonic Ready" };
  }
  const m1 = /^(\d{1,2})([AB])$/.exec(fromKey.trim());
  const m2 = /^(\d{1,2})([AB])$/.exec(toKey.trim());
  if (!m1 || !m2) {
    return { tier: "harmonic", score: 80, label: "Harmonic Ready" };
  }
  const n1 = parseInt(m1[1], 10);
  const l1 = m1[2];
  const n2 = parseInt(m2[1], 10);
  const l2 = m2[2];

  if (n1 === n2 && l1 === l2) {
    return { tier: "perfect", score: 100, label: `Same Key (${fromKey})` };
  }
  if (n1 === n2 && l1 !== l2) {
    return { tier: "perfect", score: 96, label: `Relative Maj/Min (${fromKey} → ${toKey})` };
  }
  const diff = Math.min((n2 - n1 + 12) % 12, (n1 - n2 + 12) % 12);
  if (diff === 1 && l1 === l2) {
    return { tier: "harmonic", score: 92, label: `Adjacent Fifth (${fromKey} → ${toKey})` };
  }
  // +2 or +7 on Camelot wheel = +1 or +2 semitone energy lift
  const cw = (n2 - n1 + 12) % 12;
  if ((cw === 2 || cw === 7) && l1 === l2) {
    return { tier: "energy-boost", score: 84, label: `Energy Lift (${fromKey} → ${toKey})` };
  }
  return { tier: "wide", score: 62, label: `Cross-Key Contrast (${fromKey} → ${toKey})` };
}

