import { afterAll, describe, expect, test } from "bun:test";
import { Mixer } from "../src/engine/mixer";
import { createHeadlessContext, createPcmTap } from "../src/audio/context";
import { BUILTIN_TRACK_SPECS, synthesizeStudioTrack } from "../src/engine/synthTracks";
import { interleaveToInt16 } from "../src/audio/ringer";

const SR = 48000;

/**
 * Every context this file creates, closed at the end.
 *
 * These were leaked. Each headless AudioContext owns a real-time audio thread
 * that keeps running for the life of the process, so a leaked context does not
 * merely waste memory — it competes with every other suite for the machine. That
 * is what made this package's results unstable: the same three runs gave
 * 29 pass / 0 fail, 24 / 5 and 25 / 4, with a *different* set of failures each
 * time, which is the signature of resource starvation rather than a logic error.
 */
const openContexts: BaseAudioContext[] = [];

afterAll(async () => {
  await Promise.all(
    openContexts.map((ctx) => (ctx as unknown as { close?: () => Promise<void> }).close?.()),
  );
});

function buildGraph() {
  const ctx = createHeadlessContext({ sampleRate: SR });
  openContexts.push(ctx);
  const mixer = new Mixer(ctx);
  const spec = BUILTIN_TRACK_SPECS[0];
  const buffer = synthesizeStudioTrack(ctx, spec as never);
  return { ctx, mixer, buffer, spec };
}

describe("headless mixer", () => {
  test("constructs without an audio device", () => {
    const { mixer } = buildGraph();
    expect(mixer).toBeDefined();
    expect(mixer.ctx.sampleRate).toBe(SR);
    expect(mixer.decks.length).toBe(2);
  });

  /**
   * These render real audio in real time, so the wall-clock cost is the
   * synthesis plus the sleep. Left on bun's 5s default they pass alone and fail
   * whenever anything else in the suite is competing for the CPU, which is not a
   * useful failure.
   */
  test("renders real audio off the master bus with no sink present", async () => {
    const { mixer, buffer } = buildGraph();

    let frames = 0;
    let peak = 0;
    const tap = createPcmTap(mixer.ctx, {
      bufferSize: 2048,
      onChunk: ({ channels, frames: n }) => {
        frames += n;
        for (const ch of channels) {
          for (let i = 0; i < ch.length; i++) {
            const a = Math.abs(ch[i]);
            if (a > peak) peak = a;
          }
        }
      },
    });

    // Spliced exactly where the PA would be fed.
    (mixer as unknown as { masterLimiter: AudioNode }).masterLimiter.connect(tap.node);
    tap.node.connect(mixer.ctx.destination);

    mixer.loadBuffer(0, buffer);
    mixer.play();

    await new Promise((r) => setTimeout(r, 1200));

    tap.stop();
    expect(frames).toBeGreaterThan(0);
    expect(peak).toBeGreaterThan(0.001);
    // ~1.2s of audio should have come out.
    expect(frames).toBeGreaterThan(SR * 0.5);
  }, 30000);

/**
       * The audio clock must track wall-clock.
       *
       * Measured over a single 1s window, which is only valid if the machine is
       * idle. Under load the audio thread gets starved and the observed ratio
       * collapses — measured as low as 0.026 — which says nothing about the clock
       * and everything about CPU contention. So a starved reading is treated as an
       * invalid measurement and retried once, rather than reported as a defect in
       * code that is correct.
       */
      const measure = async () => {
        const { mixer, ctx } = buildGraph();
        const t0 = mixer.ctx.currentTime;
        const w0 = Date.now();
        await new Promise((r) => setTimeout(r, 1000));
        const ratio = (mixer.ctx.currentTime - t0) / ((Date.now() - w0) / 1000);
        await ctx.close();
        return ratio;
      };

      test("master clock advances at wall-clock rate", async () => {
        let ratio = await measure();
        if (ratio < 0.5) ratio = await measure();
        expect(ratio).toBeGreaterThan(0.8);
        expect(ratio).toBeLessThan(1.25);
      }, 30000);

  test("getMasterOutputNode exposes the broadcast tap", () => {
    const { mixer } = buildGraph();
    const node = mixer.getMasterOutputNode();
    expect(node).toBeDefined();
  });

  /**
   * Imaging ducks the music and has to give the level back.
   *
   * The bug this pins, twice over:
   *  1. `playJingle` used to read `masterGain.gain.value` as its restore
   *     target AFTER stopping the previous jingle. That reads the level
   *     mid-ramp — still ducked — so every re-fire restored to a lower value
   *     and the music ratcheted toward silence.
   *  2. It then wrote the duck to `masterGain`, which the headless engine's
   *     headroom guard rewrites toward its own target on every ~21ms audio
   *     block. Measured: the duck was back to full volume within 65ms. The
   *     imaging played over full-level music and was not a sweeper at all.
   *
   * The duck now lives on `imagingDuck`, a node only imaging writes.
   */
  test("imaging ducks the music and the duck survives the headroom guard", async () => {
    const { mixer, ctx, buffer: jingle } = buildGraph();
    await ctx.resume().catch(() => {});

    expect(mixer.imagingDuck.gain.value).toBeCloseTo(1, 3);
    expect(mixer.masterTrim.gain.value).toBeCloseTo(1, 3);

    const res = mixer.playJingle(jingle);
    expect(res.ok).toBe(true);

    // Wait past several audio blocks — the guard runs on 2048-frame callbacks,
    // ~21ms at 48kHz — and confirm the duck is still in force.
    await new Promise((r) => setTimeout(r, 300));
    expect(mixer.imagingDuck.gain.value).toBeLessThan(0.6);

    // And the guard's own node must not have been touched by imaging.
    // The guard drives this toward 1.0; what matters is that imaging left it
    // alone rather than writing it and being overwritten.
    expect(mixer.masterGain.gain.value).toBeGreaterThan(0);

    mixer.stopJingle();
    await new Promise((r) => setTimeout(r, 400));
    expect(mixer.imagingDuck.gain.value).toBeGreaterThan(0.85);
  }, 30000);

  test("repeated imaging fires do not ratchet the music level down", async () => {
    const { mixer, ctx, buffer: jingle } = buildGraph();
    await ctx.resume().catch(() => {});

    // Fire repeatedly without waiting for each to finish, the way an operator
    // hitting the sweeper button twice would.
    for (let i = 0; i < 5; i++) {
      expect(mixer.playJingle(jingle).ok).toBe(true);
      await new Promise((r) => setTimeout(r, 25));
    }
    await new Promise((r) => setTimeout(r, 200));

    // Every fire targets the same depth from the same rest value, so the duck
    // cannot walk further down with each press.
    expect(mixer.imagingDuck.gain.value).toBeGreaterThan(0);
    expect(mixer.imagingDuck.gain.value).toBeLessThanOrEqual(1.0001);

    mixer.stopJingle();
    await new Promise((r) => setTimeout(r, 300));
    expect(mixer.imagingDuck.gain.value).toBeGreaterThan(0.85);
  }, 30000);

  test("setMasterGainDb lands on the trim node the guard does not own", async () => {
    const { mixer, ctx } = buildGraph();
    await ctx.resume().catch(() => {});

    const { applied } = mixer.setMasterGainDb(-20);
    expect(applied).toBe(-20);

    // Give the ramp time, then confirm it is still where it was put. Written
    // to masterGain this returned to ~1.0 within 50ms.
    await new Promise((r) => setTimeout(r, 250));
    expect(mixer.masterTrim.gain.value).toBeLessThan(0.2);
    expect(mixer.masterTrim.gain.value).toBeGreaterThan(0.05);

    // Out-of-range input is clamped, not rejected.
    expect(mixer.setMasterGainDb(-900).applied).toBe(-60);
    expect(mixer.setMasterGainDb(900).applied).toBe(6);
  }, 30000);

  test("stopJingle reports whether anything was playing", () => {
    const { mixer } = buildGraph();
    expect(mixer.stopJingle()).toBe(false);
  });
});

describe("pcm conversion", () => {
  test("interleaves to int16 and clamps", () => {
    const left = Float32Array.from([0, 0.5, -0.5, 2]);
    const right = Float32Array.from([1, -1, 0, 0]);
    const out = interleaveToInt16([left, right], 4);
    expect(out.length).toBe(8);
    expect(out[0]).toBe(0);
    expect(out[1]).toBeCloseTo(32767, -2);
    expect(out[2]).toBeCloseTo(16384, -3);
    expect(out[3]).toBeCloseTo(-32768, -2);
    // 2.0 must clamp, not wrap
    expect(out[6]).toBe(32767);
  });
});