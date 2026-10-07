/**
 * Sampler + headphone-cue contract (plan 3A, 3C). Offline-render tests: every
 * assertion measures rendered samples, not that a method exists.
 */
import { describe, expect, test } from "bun:test";
import { OfflineAudioContext } from "node-web-audio-api";
import { Sampler } from "../src/engine/sampler";
import { Mixer } from "../src/engine/mixer";

const SR = 48000;
const ctxOf = (seconds: number) => new OfflineAudioContext(1, Math.round(SR * seconds), SR);

const rms = (d: Float32Array, fromSec: number, toSec: number) => {
  const a = Math.max(0, Math.floor(fromSec * SR));
  const b = Math.min(d.length, Math.ceil(toSec * SR));
  let s = 0;
  for (let i = a; i < b; i++) s += d[i] * d[i];
  return Math.sqrt(s / Math.max(1, b - a));
};

function toneBuf(ctx: BaseAudioContext, seconds: number, freq: number, amp = 0.5): AudioBuffer {
  const buf = ctx.createBuffer(1, Math.round(ctx.sampleRate * seconds), ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.sin((2 * Math.PI * freq * i) / ctx.sampleRate) * amp;
  return buf;
}

const noGrid = (_d: number, now: number) => now;

describe("sampler: trigger and velocity", () => {
  test("velocity drives gain on a squared curve", async () => {
    const render = async (velocity: number) => {
      const ctx = ctxOf(0.5);
      const s = new Sampler(ctx, ctx.destination, noGrid);
      s.setBuffer(0, 0, toneBuf(ctx, 0.3, 440), "tone");
      s.trigger(0, 0, { velocity });
      return (await ctx.startRendering()).getChannelData(0);
    };
    const full = await render(1);
    const half = await render(0.5);
    expect(rms(full, 0.05, 0.2)).toBeGreaterThan(0.1);
    // 0.5^2 = 0.25 of full.
    expect(rms(half, 0.05, 0.2) / rms(full, 0.05, 0.2)).toBeCloseTo(0.25, 1);
  });

  test("an empty pad returns null and makes no sound", async () => {
    const ctx = ctxOf(0.3);
    const s = new Sampler(ctx, ctx.destination, noGrid);
    expect(s.trigger(0, 5)).toBeNull();
    const d = (await ctx.startRendering()).getChannelData(0);
    expect(rms(d, 0, 0.3)).toBeLessThan(1e-6);
  });
});

describe("sampler: modes and choke", () => {
  test("a one-shot stops at the buffer end", async () => {
    const ctx = ctxOf(0.8);
    const s = new Sampler(ctx, ctx.destination, noGrid);
    s.setBuffer(0, 0, toneBuf(ctx, 0.1, 440), "short");
    s.trigger(0, 0);
    const d = (await ctx.startRendering()).getChannelData(0);
    expect(rms(d, 0.02, 0.08)).toBeGreaterThan(0.1);
    expect(rms(d, 0.3, 0.6)).toBeLessThan(1e-4);
  });

  test("a loop pad keeps sounding past the buffer end", async () => {
    const ctx = ctxOf(0.8);
    const s = new Sampler(ctx, ctx.destination, noGrid);
    s.setBuffer(0, 0, toneBuf(ctx, 0.1, 440), "loop");
    s.setPad(0, 0, { mode: "loop" });
    s.trigger(0, 0);
    const d = (await ctx.startRendering()).getChannelData(0);
    expect(rms(d, 0.5, 0.7)).toBeGreaterThan(0.1);
  });

  test("a choke group cuts the pad already playing", async () => {
    const ctx = ctxOf(0.9);
    const s = new Sampler(ctx, ctx.destination, noGrid);
    s.setBuffer(0, 0, toneBuf(ctx, 1, 440), "A");
    s.setPad(0, 0, { choke: 1 });
    s.setBuffer(0, 1, toneBuf(ctx, 1, 440, 0), "silent"); // silent trigger that still chokes
    s.setPad(0, 1, { choke: 1 });
    s.trigger(0, 0);
    s.trigger(0, 1); // scheduled immediately; currentTime is 0 offline, so choke now
    const d = (await ctx.startRendering()).getChannelData(0);
    // Both start at 0 offline, so the choke must silence A for the whole render.
    expect(rms(d, 0.1, 0.5)).toBeLessThan(0.01);
  });
});

describe("sampler: quantize", () => {
  test("a quantized hit starts on the next grid line", async () => {
    const ctx = ctxOf(1);
    // Grid every 0.5 s.
    const grid = (_d: number, _now: number) => 0.5;
    const s = new Sampler(ctx, ctx.destination, grid);
    s.setBuffer(0, 0, toneBuf(ctx, 0.3, 440), "q");
    s.setPad(0, 0, { quantize: 1 });
    s.trigger(0, 0);
    const d = (await ctx.startRendering()).getChannelData(0);
    expect(rms(d, 0.02, 0.45)).toBeLessThan(1e-4); // silent before the grid
    expect(rms(d, 0.52, 0.75)).toBeGreaterThan(0.1); // sounds on it
  });
});

describe("mixer: beat grid and per-deck cue", () => {
  test("nextGridTime lands on the beat and sub-beat grid", async () => {
    const ctx = new OfflineAudioContext(1, SR, SR);
    const mixer = new Mixer(ctx as unknown as AudioContext);
    // No deck playing: anchor 0, effBpm 124 -> beat 0.4839 s, 16th 0.12097 s.
    const beat = mixer.nextGridTime(1, 0);
    const sixteenth = mixer.nextGridTime(0.25, 0);
    expect(beat).toBeCloseTo(60 / 124, 2);
    expect(sixteenth).toBeCloseTo(60 / 124 / 4, 2);
    expect(sixteenth).toBeLessThan(beat);
  });

  test("setDeckCue routes only the cued deck to the cue bus", async () => {
    const render = async (cueA: boolean) => {
      const ctx = new OfflineAudioContext(1, SR, SR);
      const mixer = new Mixer(ctx as unknown as AudioContext);
      mixer.loadBuffer(0, toneBuf(ctx, 1, 440), { bpm: 124, firstBeat: 0 });
      mixer.toggleDeckPlay(0);
      // cue-only keeps the program bus off the destination, so the rendered
      // signal is the cue bus alone (they share one destination offline).
      mixer.setMonitorPolicy("cue-only");
      mixer.setDeckCue(0, cueA);
      return (await ctx.startRendering()).getChannelData(0);
    };
    const on = await render(true);
    const off = await render(false);
    expect(rms(on, 0.2, 0.8)).toBeGreaterThan(0.05);
    expect(rms(off, 0.2, 0.8)).toBeLessThan(1e-3);
  });
});
