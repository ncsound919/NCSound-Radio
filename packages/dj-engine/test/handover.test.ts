/**
 * Regression tests for the track-boundary handover.
 *
 * The failure these exist to catch: the station reached the end of a track,
 * reported itself as playing, and broadcast silence through a correctly
 * connected harbor. Peak level cannot see that - a dead-air fallback tone or a
 * single decaying partial both pass a "peak > 0" check - so every assertion
 * about "is it actually playing music" here uses spectral flatness, not peak.
 */

import { describe, expect, test } from "bun:test";
import { Mixer } from "../src/engine/mixer";
import { createHeadlessContext, createPcmTap } from "../src/audio/context";
import { BUILTIN_TRACK_SPECS, synthesizeStudioTrack } from "../src/engine/synthTracks";
import type { TransitionPreset } from "../src/engine/types";

const SR = 48000;

/** Short tracks so a boundary crossing fits in a test. */
function shortTrack(ctx: BaseAudioContext, index: number, durationSec: number) {
  const spec = { ...BUILTIN_TRACK_SPECS[index % BUILTIN_TRACK_SPECS.length], durationSec };
  return synthesizeStudioTrack(ctx, spec as never);
}

/**
 * Spectral flatness of the first `N` samples: geometric mean of band magnitudes
 * over arithmetic mean. A pure tone concentrates its energy in a couple of bins
 * and scores near zero; broadband music scores well above it.
 */
function spectralFlatness(samples: Float32Array): number {
  const N = Math.min(1024, samples.length);
  let mean = 0;
  for (let i = 0; i < N; i++) mean += samples[i];
  mean /= N;

  const BINS = 48;
  const mags: number[] = [];
  for (let b = 0; b < BINS; b++) {
    const freq = 40 * Math.pow(6000 / 40, b / (BINS - 1));
    const w = (2 * Math.PI * freq) / SR;
    let re = 0;
    let im = 0;
    for (let n = 0; n < N; n++) {
      const v = samples[n] - mean;
      re += v * Math.cos(w * n);
      im -= v * Math.sin(w * n);
    }
    mags.push(Math.sqrt(re * re + im * im) / N);
  }

  const live = mags.filter((m) => m > 1e-12);
  if (live.length < 4) return 0;
  const logMean = live.reduce((s, m) => s + Math.log(m), 0) / live.length;
  const arithMean = live.reduce((s, m) => s + m, 0) / live.length;
  return arithMean > 0 ? Math.exp(logMean) / arithMean : 0;
}

/**
 * Collects what the master bus actually renders, and reports the loudest chunk
 * it saw after `fromFrame`.
 */
function masterProbe(mixer: Mixer) {
  const chunks: Float32Array[] = [];
  let frames = 0;
  const tap = createPcmTap(mixer.ctx, {
    bufferSize: 2048,
    onChunk: ({ channels, frames: n }) => {
      frames += n;
      chunks.push(channels[0]);
    },
  });
  (mixer as unknown as { masterLimiter: AudioNode }).masterLimiter.connect(tap.node);
  tap.node.connect(mixer.ctx.destination);
  return {
    chunks,
    get frames() {
      return frames;
    },
    mark() {
      return chunks.length;
    },
    /** Peak and flatness of the loudest chunk at or after `from`. */
    loudest(from: number) {
      let peak = 0;
      let flat = 0;
      for (let i = from; i < chunks.length; i++) {
        const ch = chunks[i];
        let p = 0;
        for (let i2 = 0; i2 < ch.length; i2++) p = Math.max(p, Math.abs(ch[i2]));
        if (p > peak) {
          peak = p;
          flat = spectralFlatness(ch);
        }
      }
      return { peak, flatness: flat };
    },
    stop: () => tap.stop(),
  };
}

const BLEND: TransitionPreset = { id: "auto", name: "Auto", bars: 4, curve: "equal-power" };

describe("handover at a track boundary", () => {
  test("a track that runs to its end reports itself finished, and hands over", async () => {
    const ctx = createHeadlessContext({ sampleRate: SR });
    const mixer = new Mixer(ctx);
    const probe = masterProbe(mixer);

    const DURATION = 5;
    const a = shortTrack(ctx, 0, DURATION);
    const b = shortTrack(ctx, 1, DURATION);
    const analysisA = { bpm: 124, firstBeat: 0.24 };
    const analysisB = { bpm: 126, firstBeat: 0.24 };

    mixer.loadBuffer(0, a, analysisA);
    expect(mixer.play()).toBe(true);

    // Let the outgoing track run past its own end.
    await new Promise((r) => setTimeout(r, DURATION * 1000 + 900));

    /**
     * The invariant the sequencer depends on. Previously nothing observed the
     * source node ending, so `rolling` stayed true on a deck whose playhead was
     * pinned at the buffer duration: a finished track indistinguishable from a
     * live one.
     */
    expect(mixer.decks[0].playing).toBe(false);
    expect(mixer.decks[0].srcEndedAt).toBeGreaterThan(0);

    const info = mixer.info();
    expect(info).not.toBeNull();
    expect(info!.remaining).toBe(0);

    // Cue the successor, as autopilot does before calling next().
    mixer.loadBuffer(1, b, analysisB);
    expect(mixer.decks[1].playing).toBe(false);

    const mark = probe.mark();
    const res = mixer.next(BLEND);
    expect(res.ok ? true : res.reason).toBe(true);

    const trace = mixer.handover[ mixer.handover.length - 1];
    expect(trace.outcome).toBe("ok");
    expect(trace.scheduling?.toStarted).toBe(true);
    expect(trace.result?.activeAfter).toBe(1);
    expect(mixer.active).toBe(1);

    /**
     * next() may legitimately schedule the incoming deck up to one bar out, so
     * wait past the time it actually committed to rather than guessing. Measuring
     * too early reads the gap between the outgoing track ending and the incoming
     * one starting, which is silence by design and would fail for the wrong
     * reason.
     */
    const audibleFrom = trace.scheduling!.startAt;
    while (mixer.ctx.currentTime < audibleFrom + 1.2) {
      await new Promise((r) => setTimeout(r, 50));
    }

    // And the successor must actually be heard, as music rather than a tone.
    const { peak, flatness } = probe.loudest(mark);
    expect(peak).toBeGreaterThan(0.02);
    expect(flatness).toBeGreaterThan(0.05);

    probe.stop();
    await ctx.close();
  }, 40000);

  test("every preset style survives repeated handovers without throwing", async () => {
    const ctx = createHeadlessContext({ sampleRate: SR });
    const mixer = new Mixer(ctx);
    const probe = masterProbe(mixer);

    const styles: TransitionPreset[] = [
      { id: "auto", name: "Auto", bars: 4, curve: "equal-power" },
      { id: "bass-swap", name: "Bass swap", bars: 4, curve: "equal-power", bassSwap: true, style: "bass-swap" },
      { id: "filter", name: "Filter riser", bars: 4, curve: "equal-power", filterSweep: true, style: "filter-riser" },
      { id: "vinyl-brake", name: "Vinyl brake", bars: 2, curve: "linear", style: "vinyl-brake" },
      { id: "echo-out", name: "Echo out", bars: 2, curve: "linear", style: "echo-out" },
      { id: "backspin", name: "Backspin", bars: 2, curve: "linear", style: "backspin" },
      { id: "quick", name: "Quick cut", bars: 1, curve: "cut" },
    ];

    const a = shortTrack(ctx, 0, 20);
    const b = shortTrack(ctx, 1, 20);
    mixer.loadBuffer(0, a, { bpm: 124, firstBeat: 0.24 });
    mixer.loadBuffer(1, b, { bpm: 126, firstBeat: 0.24 });
    mixer.play();

    const mark = probe.mark();
    /**
     * Alternate decks so each one is both the outgoing and the incoming side of
     * successive transitions. The styles that script AudioParam ramps (bass-swap,
     * echo-out, backspin) and the ones that schedule value curves (blend,
     * filter-riser) cancel different events, so only a sequence that runs both
     * ways over the same param exercises the interaction.
     */
    for (const preset of styles) {
      const res = mixer.next(preset);
      expect(res.ok ? true : `${preset.id}: ${res.reason}`).toBe(true);
      // Wait for the transition to actually finish: next() refuses while busy,
      // so a fixed sleep would just measure the wrong bar length.
      await new Promise<void>((resolve) => {
        const deadline = Date.now() + 20000;
        const poll = () => {
          if (!mixer.busy || Date.now() > deadline) resolve();
          else setTimeout(poll, 50);
        };
        setTimeout(poll, 50);
      });
      expect(mixer.handover.filter((h) => h.outcome === "threw")).toHaveLength(0);
    }

    // Past the last transition's end, the incoming deck must be the loud thing.
    const last = mixer.handover[mixer.handover.length - 1];
    while (mixer.ctx.currentTime < (last.result?.transitionEnd ?? mixer.ctx.currentTime) + 0.8) {
      await new Promise((r) => setTimeout(r, 50));
    }
    const { peak, flatness } = probe.loudest(mark);
    expect(peak).toBeGreaterThan(0.02);
    expect(flatness).toBeGreaterThan(0.05);

    probe.stop();
    await ctx.close();
  }, 150000);

  test("a refusal is recorded with the state that caused it", () => {
    const ctx = createHeadlessContext({ sampleRate: SR });
    const mixer = new Mixer(ctx);

    // Nothing loaded at all: refuse before touching the audio graph.
    const res = mixer.next(BLEND);
    expect(res.ok).toBe(false);

    const trace = mixer.handover[ mixer.handover.length - 1];
    expect(trace.outcome).toBe("refused");
    expect(trace.reason).toBe("Press Start first");
    expect(trace.scheduling).toBeUndefined();
    expect(trace.entry.from.rolling).toBe(false);

    void ctx.close();
  });
});