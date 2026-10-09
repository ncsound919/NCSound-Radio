/**
 * FX unit: offline-render tests (plan phase 3B).
 *
 * Every effect asserts a measurable change in the rendered samples, not that a
 * node exists: echo energy lands at the delay time, reverb rings after the input
 * stops, the flanger modulates a steady tone, the gater closes at the division
 * rate, bitcrush changes the waveform. Tails are tested by scheduling the send
 * off mid-render (FxUnit.setOn(on, when)) and showing the sound continues.
 * OfflineAudioContext.suspend is not implemented by node-web-audio-api, so the
 * switch-off time is scheduled rather than applied by callback.
 */
import { describe, expect, test } from "bun:test";
import { OfflineAudioContext } from "node-web-audio-api";
import { FxUnit } from "../src/engine/fx";
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

/** Peak in a window. The right measure for a click/impulse, whose energy is spread thin by rms. */
const peak = (d: Float32Array, fromSec: number, toSec: number) => {
  const a = Math.max(0, Math.floor(fromSec * SR));
  const b = Math.min(d.length, Math.ceil(toSec * SR));
  let p = 0;
  for (let i = a; i < b; i++) p = Math.max(p, Math.abs(d[i]));
  return p;
};

function impulse(ctx: BaseAudioContext, at = 0, amp = 1): AudioBufferSourceNode {
  const buf = ctx.createBuffer(1, 1, ctx.sampleRate);
  buf.getChannelData(0)[0] = amp;
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.start(at);
  return src;
}

/** Short-time RMS envelope, one value per window. */
function envelope(d: Float32Array, windowSec: number): number[] {
  const w = Math.max(1, Math.round(windowSec * SR));
  const out: number[] = [];
  for (let i = 0; i + w <= d.length; i += w) {
    let s = 0;
    for (let j = i; j < i + w; j++) s += d[j] * d[j];
    out.push(Math.sqrt(s / w));
  }
  return out;
}

describe("fx: unit bypass and dry/wet", () => {
  test("an idle unit is a straight wire (bypass is bit-identical)", async () => {
    const ref = ctxOf(0.5);
    impulse(ref).connect(ref.destination);
    const refBuf = await ref.startRendering();

    const ctx = ctxOf(0.5);
    const unit = new FxUnit(ctx);
    unit.setEffect("echo"); // assigned nothing, on=false
    unit.setOn(false);
    impulse(ctx).connect(unit.input);
    unit.output.connect(ctx.destination);
    const buf = await ctx.startRendering();

    const a = refBuf.getChannelData(0), b = buf.getChannelData(0);
    let maxDiff = 0;
    for (let i = 0; i < a.length; i++) maxDiff = Math.max(maxDiff, Math.abs(a[i] - b[i]));
    expect(maxDiff).toBeLessThan(1e-5);
  });

  test("off leaves only the dry signal even with wet up", async () => {
    const ctx = ctxOf(0.5);
    const unit = new FxUnit(ctx);
    unit.setEffect("echo");
    unit.setWet(1);
    unit.setOn(false);
    impulse(ctx).connect(unit.input);
    unit.output.connect(ctx.destination);
    const buf = await ctx.startRendering();
    const d = buf.getChannelData(0);
    // Impulse at 0 survives; the echo at 0.25 s (division 0.5 @ default 120) does not.
    expect(Math.abs(d[0])).toBeGreaterThan(0.5);
    expect(rms(d, 0.2, 0.3)).toBeLessThan(1e-4);
  });
});

describe("fx: echo", () => {
  test("energy arrives at the beat-synced delay time", async () => {
    const ctx = ctxOf(1.5);
    const unit = new FxUnit(ctx);
    unit.setEffect("echo");
    unit.setWet(1);
    unit.setParam(0.6);
    unit.setSync(120, 0.5); // 0.5 beat at 120 bpm = 250 ms
    unit.setOn(true);
    // Feed the impulse after the 10 ms send ramp so it actually enters the effect.
    impulse(ctx, 0.1).connect(unit.input);
    unit.output.connect(ctx.destination);
    const d = (await ctx.startRendering()).getChannelData(0);

    expect(peak(d, 0.34, 0.36)).toBeGreaterThan(0.05); // first repeat (0.1 + 0.25)
    expect(peak(d, 0.59, 0.61)).toBeGreaterThan(0.02); // second (feedback)
    expect(peak(d, 0.2, 0.3)).toBeLessThan(peak(d, 0.34, 0.36)); // nothing between taps
  });
});

describe("fx: tails", () => {
  test("switching off closes the send but the echo keeps ringing", async () => {
    const ctx = ctxOf(2);
    const unit = new FxUnit(ctx);
    unit.setEffect("echo");
    unit.setWet(1);
    unit.setParam(0.7);
    unit.setSync(120, 0.5);
    unit.setOn(true);
    impulse(ctx, 0.1).connect(unit.input);
    unit.output.connect(ctx.destination);
    // Schedule the send closed at 0.7 s, after the first two repeats are fed.
    // OfflineAudioContext has no suspend(), so this is scheduled, not callbacked.
    unit.setOn(false, 0.7);
    const d = (await ctx.startRendering()).getChannelData(0);

    // Repeats at 0.35, 0.6 are fed before off; 0.85, 1.1 are pure tail.
    expect(peak(d, 0.84, 0.86)).toBeGreaterThan(0.01);
    expect(peak(d, 1.09, 1.11)).toBeGreaterThan(0.003);
  });
});

describe("fx: reverb", () => {
  test("rings after the input stops, and is silent when bypassed", async () => {
    const render = async (on: boolean) => {
      const ctx = ctxOf(2.5);
      const unit = new FxUnit(ctx);
      unit.setEffect("reverb");
      unit.setWet(1);
      unit.setParam(0.9);
      unit.setOn(on);
      // 100 ms burst, then silence.
      const buf = ctx.createBuffer(1, Math.round(SR * 0.1), SR);
      const ch = buf.getChannelData(0);
      for (let i = 0; i < ch.length; i++) ch[i] = Math.sin((2 * Math.PI * 300 * i) / SR) * 0.5;
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.start(0);
      src.connect(unit.input);
      unit.output.connect(ctx.destination);
      return (await ctx.startRendering()).getChannelData(0);
    };

    const on = await render(true);
    const off = await render(false);
    expect(rms(on, 1.2, 1.4)).toBeGreaterThan(0.002); // tail long after the burst
    expect(rms(off, 1.2, 1.4)).toBeLessThan(1e-4);
  });
});

describe("fx: flanger", () => {
  test("modulates a steady tone", async () => {
    const render = async (on: boolean) => {
      const ctx = ctxOf(1.5);
      const unit = new FxUnit(ctx);
      unit.setEffect("flanger");
      unit.setWet(1);
      unit.setParam(1);
      unit.setSync(120, 1);
      unit.setOn(on);
      const osc = ctx.createOscillator();
      osc.frequency.value = 440;
      osc.connect(unit.input);
      osc.start(0);
      osc.stop(1.5);
      unit.output.connect(ctx.destination);
      return (await ctx.startRendering()).getChannelData(0);
    };
    const variance = (d: Float32Array) => {
      const env = envelope(d, 0.02).slice(10, 60); // skip onset
      const mean = env.reduce((s, v) => s + v, 0) / env.length;
      return env.reduce((s, v) => s + (v - mean) ** 2, 0) / env.length;
    };
    const on = await render(true);
    const dry = await render(false);
    // A swept comb makes the steady tone's level move; the dry tone is flat.
    expect(variance(on)).toBeGreaterThan(variance(dry) * 5);
  });
});

describe("fx: gater", () => {
  test("closes and opens at the division rate", async () => {
    const ctx = ctxOf(1.5);
    const unit = new FxUnit(ctx);
    unit.setEffect("gater");
    unit.setWet(1);
    unit.setSync(120, 0.5); // gate runs at 4 Hz
    unit.setOn(true);
    const osc = ctx.createOscillator();
    osc.frequency.value = 440;
    osc.connect(unit.input);
    osc.start(0);
    osc.stop(1.5);
    unit.output.connect(ctx.destination);
    const d = (await ctx.startRendering()).getChannelData(0);

    const env = envelope(d, 0.005).slice(20);
    const max = Math.max(...env);
    const min = Math.min(...env);
    expect(max).toBeGreaterThan(0.1);
    expect(min).toBeLessThan(max * 0.25); // the gate actually reaches near silence
  });
});

describe("fx: bitcrush", () => {
  test("quantisation changes the waveform, more with fewer bits", async () => {
    const render = async (param: number) => {
      const ctx = ctxOf(0.5);
      const unit = new FxUnit(ctx);
      unit.setEffect("bitcrush");
      unit.setWet(1);
      unit.setParam(param);
      unit.setOn(true);
      const osc = ctx.createOscillator();
      osc.frequency.value = 220;
      osc.connect(unit.input);
      osc.start(0);
      osc.stop(0.5);
      unit.output.connect(ctx.destination);
      return (await ctx.startRendering()).getChannelData(0);
    };
    // Reference: a clean tone through an idle unit.
    const clean = ctxOf(0.5);
    const refUnit = new FxUnit(clean);
    const osc = clean.createOscillator();
    osc.frequency.value = 220;
    osc.connect(refUnit.input);
    osc.start(0);
    osc.stop(0.5);
    refUnit.output.connect(clean.destination);
    const ref = (await clean.startRendering()).getChannelData(0);

    const diff = (d: Float32Array) => {
      let s = 0;
      for (let i = SR * 0.05; i < SR * 0.45; i++) s += Math.abs(d[i] - ref[i]);
      return s / (SR * 0.4);
    };
    const few = await render(1);
    const many = await render(0);
    expect(diff(few)).toBeGreaterThan(diff(many) * 2);
    expect(diff(many)).toBeLessThan(diff(few));
  });
});

describe("fx: mixer insertion", () => {
  test("a unit assigned to Deck A reaches the master bus; unassigned it does not", async () => {
    const render = async (assigned: boolean) => {
      const ctx = new OfflineAudioContext(1, Math.round(SR * 1.5), SR);
      const mixer = new Mixer(ctx as unknown as AudioContext);
      const unit = mixer.fx.units[0];
      unit.setEffect("echo");
      unit.setWet(1);
      unit.setParam(0.6);
      unit.setSync(120, 0.5);
      unit.setOn(true);
      mixer.assignFx(0, assigned ? "A" : null);
      impulse(ctx, 0.1).connect(mixer.fx.slots.A.input);
      return (await ctx.startRendering()).getChannelData(0);
    };

    const on = await render(true);
    const off = await render(false);
    expect(peak(on, 0.34, 0.36)).toBeGreaterThan(0.02); // echo on the master bus
    expect(peak(off, 0.34, 0.36)).toBeLessThan(1e-4); // bypassed: no echo
  });
});
