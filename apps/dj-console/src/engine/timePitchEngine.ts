/**
 * Time-Pitch Engine (WSOLA Granular Time-Stretching & Sinc Pitch-Shifting)
 *
 * Provides decoupled Pitch and Time manipulation for professional DJing:
 * 1. Time-Stretching (Key Lock / Master Tempo): Changes BPM / playback speed with 0% pitch shift.
 * 2. Pitch-Shifting (Key Shift / Harmonic Match): Transposes musical key (semitones/cents) with 0% tempo change.
 * 3. Harmonic Key Sync: Automatically calculates the minimal semitone distance to harmonically match Camelot keys.
 */

export interface TimePitchOptions {
  timeStretchRatio: number; // e.g. 1.0 = native tempo, 1.1 = +10% faster, 0.9 = -10% slower
  pitchSemitones: number;   // e.g. 0 = native key, +1 = +1 semitone, -2 = -2 semitones
  keyLock: boolean;         // true = preserve pitch when changing tempo (Master Tempo)
}

/**
 * Calculates shortest semitone shift to harmonically match `fromKey` to `toKey` on the Camelot wheel.
 * E.g. 8A (A minor) to 9A (E minor) is +7 semitones (or -5 semitones / perfect fifth).
 */
export function calculateHarmonicKeyShift(fromKey: string, toKey: string): { semitones: number; targetKey: string; score: number } {
  const CAMELOT_TO_SEMITONE: Record<string, number> = {
    // Minor keys (A)
    "1A": 8,   // Ab minor / G# minor
    "2A": 3,   // Eb minor / D# minor
    "3A": 10,  // Bb minor
    "4A": 5,   // F minor
    "5A": 0,   // C minor
    "6A": 7,   // G minor
    "7A": 2,   // D minor
    "8A": 9,   // A minor
    "9A": 4,   // E minor
    "10A": 11, // B minor
    "11A": 6,  // F# minor
    "12A": 1,  // Db minor / C# minor
    // Major keys (B)
    "1B": 11,  // B major
    "2B": 6,   // F# major
    "3B": 1,   // Db major / C# major
    "4B": 8,   // Ab major
    "5B": 3,   // Eb major
    "6B": 10,  // Bb major
    "7B": 5,   // F major
    "8B": 0,   // C major
    "9B": 7,   // G major
    "10B": 2,  // D major
    "11B": 9,  // A major
    "12B": 4,  // E major
  };

  const cleanFrom = fromKey.trim().toUpperCase();
  const cleanTo = toKey.trim().toUpperCase();

  const fromSemi = CAMELOT_TO_SEMITONE[cleanFrom];
  const toSemi = CAMELOT_TO_SEMITONE[cleanTo];

  if (fromSemi === undefined || toSemi === undefined) {
    return { semitones: 0, targetKey: cleanTo, score: 50 };
  }

  // Calculate raw difference modulo 12
  let diff = (toSemi - fromSemi) % 12;
  if (diff > 6) diff -= 12;
  if (diff < -6) diff += 12;

  return {
    semitones: diff,
    targetKey: cleanTo,
    score: diff === 0 ? 100 : Math.abs(diff) === 1 ? 88 : Math.abs(diff) === 2 ? 78 : 65,
  };
}

/**
 * High-quality WSOLA (Waveform Similarity Overlap-Add) Time-Stretcher and Pitch-Shifter.
 *
 * Decouples Time and Pitch:
 * - When `keyLock` is true: Time-stretch ratio changes tempo without altering pitch.
 * - `pitchSemitones` transposes pitch without changing playback duration.
 */
export function processWsolaTimePitch(
  inputBuffer: AudioBuffer,
  ctx: AudioContext,
  options: TimePitchOptions
): AudioBuffer {
  const { timeStretchRatio = 1.0, pitchSemitones = 0, keyLock = true } = options;

  // If no time stretch and no pitch shift, return clone of input
  if (Math.abs(timeStretchRatio - 1.0) < 0.0001 && Math.abs(pitchSemitones) < 0.001) {
    return inputBuffer;
  }

  const sr = inputBuffer.sampleRate;
  const numChannels = inputBuffer.numberOfChannels;
  const inLength = inputBuffer.length;

  // Effective pitch factor P (frequency multiplier)
  // If KeyLock is OFF, pitch naturally follows speed: P = timeStretchRatio
  // If KeyLock is ON, pitch is independent: P = 2^(semitones / 12)
  const pitchFactor = keyLock
    ? Math.pow(2, pitchSemitones / 12)
    : timeStretchRatio * Math.pow(2, pitchSemitones / 12);

  // Time-stretch factor S (duration multiplier = 1 / timeStretchRatio)
  const stretchFactor = 1.0 / Math.max(0.2, Math.min(5.0, timeStretchRatio));

  // If we only need resampling without time-stretching (or if keyLock is false and pitch follows speed)
  if (!keyLock && Math.abs(pitchSemitones) < 0.001) {
    // Standard pitch-linked playback: length is inLength * stretchFactor
    const outLength = Math.max(128, Math.round(inLength * stretchFactor));
    const outBuffer = ctx.createBuffer(numChannels, outLength, sr);

    for (let c = 0; c < numChannels; c++) {
      const src = inputBuffer.getChannelData(c);
      const dst = outBuffer.getChannelData(c);
      for (let i = 0; i < outLength; i++) {
        const srcPos = i * timeStretchRatio;
        const i0 = Math.floor(srcPos);
        const frac = srcPos - i0;
        if (i0 < inLength - 1) {
          dst[i] = src[i0] * (1 - frac) + src[i0 + 1] * frac;
        } else if (i0 < inLength) {
          dst[i] = src[i0];
        }
      }
    }
    return outBuffer;
  }

  // --- Granular WSOLA Algorithm ---
  // Grain Window Size: ~46ms (2048 samples at 44.1kHz)
  const windowSize = Math.min(2048, Math.max(512, Math.pow(2, Math.round(Math.log2(sr * 0.046)))));
  const halfWindow = Math.floor(windowSize / 2);
  const searchRange = Math.floor(windowSize * 0.35); // Similarity search window around nominal hop

  // Pre-calculate Hanning window
  const window = new Float32Array(windowSize);
  for (let i = 0; i < windowSize; i++) {
    window[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (windowSize - 1)));
  }

  // Synthesis hop size
  const synthHop = halfWindow;
  // Analysis hop size = synthHop / stretchFactor
  const analysisHop = Math.round(synthHop / stretchFactor);

  const estimatedOutLength = Math.max(128, Math.round(inLength * stretchFactor));
  const outBuffer = ctx.createBuffer(numChannels, estimatedOutLength, sr);

  // Downmix mono for fast cross-correlation similarity search
  const monoIn = new Float32Array(inLength);
  for (let c = 0; c < numChannels; c++) {
    const ch = inputBuffer.getChannelData(c);
    for (let i = 0; i < inLength; i++) {
      monoIn[i] += ch[i] / numChannels;
    }
  }

  // Output accumulator and normalization weight buffers
  const outData: Float32Array[] = [];
  for (let c = 0; c < numChannels; c++) {
    outData.push(outBuffer.getChannelData(c));
  }
  const normWeights = new Float32Array(estimatedOutLength);

  let inPos = 0;
  let outPos = 0;
  let lastInOffset = 0;

  while (inPos + windowSize + searchRange < inLength && outPos + windowSize < estimatedOutLength) {
    // 1. Find optimal analysis offset using Cross-Correlation similarity search (WSOLA)
    let bestOffset = 0;
    let maxCorr = -Infinity;

    const nominalIn = inPos;
    const refStart = lastInOffset + synthHop;

    if (refStart + windowSize < inLength) {
      for (let delta = -searchRange; delta <= searchRange; delta += 2) {
        const cand = nominalIn + delta;
        if (cand < 0 || cand + windowSize >= inLength) continue;

        let corr = 0;
        // Sample correlation on subset for high performance
        for (let j = 0; j < windowSize; j += 4) {
          corr += monoIn[cand + j] * monoIn[refStart + j];
        }
        if (corr > maxCorr) {
          maxCorr = corr;
          bestOffset = delta;
        }
      }
    }

    const actualIn = Math.max(0, Math.min(inLength - windowSize, nominalIn + bestOffset));
    lastInOffset = actualIn;

    // 2. Overlap-Add with windowing (and optional pitch-shift interpolation if pitchFactor != 1.0)
    for (let c = 0; c < numChannels; c++) {
      const src = inputBuffer.getChannelData(c);
      const dst = outData[c];

      for (let i = 0; i < windowSize; i++) {
        const targetIdx = outPos + i;
        if (targetIdx >= estimatedOutLength) break;

        let sampleVal = 0;
        if (Math.abs(pitchFactor - 1.0) < 0.001) {
          sampleVal = src[actualIn + i];
        } else {
          // Pitch-shift grain interpolation
          const pIdx = actualIn + i * pitchFactor;
          const i0 = Math.floor(pIdx);
          const frac = pIdx - i0;
          if (i0 < inLength - 1) {
            sampleVal = src[i0] * (1 - frac) + src[i0 + 1] * frac;
          } else if (i0 < inLength) {
            sampleVal = src[i0];
          }
        }

        dst[targetIdx] += sampleVal * window[i];
      }
    }

    for (let i = 0; i < windowSize; i++) {
      const targetIdx = outPos + i;
      if (targetIdx < estimatedOutLength) {
        normWeights[targetIdx] += window[i];
      }
    }

    inPos += analysisHop;
    outPos += synthHop;
  }

  // 3. Normalize overlap-add amplitude
  for (let i = 0; i < estimatedOutLength; i++) {
    const w = normWeights[i];
    if (w > 0.001) {
      const inv = 1.0 / w;
      for (let c = 0; c < numChannels; c++) {
        outData[c][i] *= inv;
      }
    }
  }

  return outBuffer;
}
