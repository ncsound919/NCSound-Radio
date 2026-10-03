import { describe, expect, test } from "bun:test";
import { Mixer } from "../src/engine/mixer";
import { createHeadlessContext, createPcmTap } from "../src/audio/context";
import { BUILTIN_TRACK_SPECS, synthesizeStudioTrack } from "../src/engine/synthTracks";
import { interleaveToInt16 } from "../src/audio/ringer";

const SR = 48000;

function buildGraph() {
  const ctx = createHeadlessContext({ sampleRate: SR });
  const mixer = new Mixer(ctx);
  const spec = BUILTIN_TRACK_SPECS[0];
  const buffer = synthesizeStudioTrack(ctx, spec as never);
  return { ctx, mixer, buffer, spec };
}

describe("headless mixer", () => {
  test("constructs without an audio device", () => {
    const { mixer, ctx } = buildGraph();
    expect(mixer).toBeDefined();
    expect(mixer.ctx.sampleRate).toBe(SR);
    expect(mixer.decks.length).toBe(2);
    void ctx;
  });

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
  });

  test("master clock advances at wall-clock rate", async () => {
    const { mixer } = buildGraph();
    const t0 = mixer.ctx.currentTime;
    const w0 = Date.now();
    await new Promise((r) => setTimeout(r, 1000));
    const ratio = (mixer.ctx.currentTime - t0) / ((Date.now() - w0) / 1000);
    expect(ratio).toBeGreaterThan(0.8);
    expect(ratio).toBeLessThan(1.25);
  });

  test("getMasterOutputNode exposes the broadcast tap", () => {
    const { mixer } = buildGraph();
    const node = mixer.getMasterOutputNode();
    expect(node).toBeDefined();
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