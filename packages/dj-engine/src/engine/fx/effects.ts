/**
 * The five real effects (plan phase 3B.5). Each is a small Web Audio graph with
 * a stable `input` and `output`; the `FxUnit` owns dry/wet mixing, gating and
 * beat sync, so the effects only build and update their own nodes.
 *
 * No effect is a placeholder: echo is a filtered feedback delay, reverb a real
 * convolution with a generated exponential-noise impulse, flanger a swept comb,
 * gater a tempo-locked square gate, bitcrush a quantising wave shaper.
 */
import type { FxKind } from "./types";

export type FxParams = { wet: number; param: number; divisionBeats: number; bpm: number };

export interface FxEffect {
  readonly input: AudioNode;
  readonly output: AudioNode;
  /** True for effects that replace the signal rather than sit beside it. */
  readonly serial: boolean;
  update(p: FxParams): void;
  dispose(): void;
}

const now = (ctx: BaseAudioContext) => ctx.currentTime;
const ramp = (p: AudioParam, v: number, ctx: BaseAudioContext, tau = 0.01) => p.setTargetAtTime(v, now(ctx), tau);

/* ---------- echo ---------- */

class EchoEffect implements FxEffect {
  readonly input: AudioNode;
  readonly output: AudioNode;
  readonly serial = false;
  private delay: DelayNode;
  private feedback: GainNode;
  private tone: BiquadFilterNode;
  private ctx: BaseAudioContext;
  private lastKey = "";

  constructor(ctx: BaseAudioContext) {
    this.ctx = ctx;
    this.input = ctx.createGain();
    this.output = ctx.createGain();
    this.delay = ctx.createDelay(4);
    this.feedback = ctx.createGain();
    this.tone = ctx.createBiquadFilter();
    this.tone.type = "lowpass";
    this.tone.frequency.value = 2800;
    // Wet output only: input -> delay -> tone -> {feedback back to delay, output}.
    this.input.connect(this.delay);
    this.delay.connect(this.tone);
    this.tone.connect(this.feedback);
    this.feedback.connect(this.delay);
    this.tone.connect(this.output);
  }

  update(p: FxParams) {
    const delaySec = Math.min(3.9, Math.max(0.01, p.divisionBeats * (60 / Math.max(1, p.bpm))));
    const fb = Math.min(0.85, Math.max(0, p.param * 0.85));
    const key = `${delaySec.toFixed(4)}:${fb.toFixed(3)}`;
    if (key === this.lastKey) return;
    this.lastKey = key;
    ramp(this.delay.delayTime, delaySec, this.ctx, 0.02);
    ramp(this.feedback.gain, fb, this.ctx, 0.05);
  }

  dispose() {
    try { this.input.disconnect(); this.delay.disconnect(); this.tone.disconnect(); this.feedback.disconnect(); this.output.disconnect(); } catch { /* already detached */ }
  }
}

/* ---------- reverb ---------- */

/** Deterministic PRNG so the impulse (and the tests) are reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function exponentialNoiseImpulse(ctx: BaseAudioContext, seconds: number, decay: number): AudioBuffer {
  const sr = ctx.sampleRate;
  const len = Math.max(1, Math.floor(sr * seconds));
  const buf = ctx.createBuffer(2, len, sr);
  const rnd = mulberry32(0x9e3779b9);
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < len; i++) {
      const t = i / sr;
      d[i] = (rnd() * 2 - 1) * Math.exp(-(t * (5 / Math.max(0.35, decay))));
    }
  }
  return buf;
}

class ReverbEffect implements FxEffect {
  readonly input: AudioNode;
  readonly output: AudioNode;
  readonly serial = false;
  private conv: ConvolverNode;
  private ctx: BaseAudioContext;
  private lastDecay = -1;

  constructor(ctx: BaseAudioContext) {
    this.ctx = ctx;
    this.input = ctx.createGain();
    this.output = ctx.createGain();
    this.conv = ctx.createConvolver();
    this.input.connect(this.conv);
    this.conv.connect(this.output);
    this.update({ wet: 1, param: 0.5, divisionBeats: 1, bpm: 120 });
  }

  update(p: FxParams) {
    const decay = 0.8 + p.param * 3.2; // 0.8 .. 4 s
    if (Math.abs(decay - this.lastDecay) < 0.02) return;
    this.lastDecay = decay;
    this.conv.buffer = exponentialNoiseImpulse(this.ctx, Math.min(4.2, decay * 1.15), decay);
  }

  dispose() {
    try { this.input.disconnect(); this.conv.disconnect(); this.output.disconnect(); } catch { /* already detached */ }
  }
}

/* ---------- flanger ---------- */

class FlangerEffect implements FxEffect {
  readonly input: AudioNode;
  readonly output: AudioNode;
  readonly serial = false;
  private delay: DelayNode;
  private lfo: OscillatorNode;
  private depth: GainNode;
  private ctx: BaseAudioContext;
  private lastKey = "";

  constructor(ctx: BaseAudioContext) {
    this.ctx = ctx;
    this.input = ctx.createGain();
    this.output = ctx.createGain();
    this.delay = ctx.createDelay(0.05);
    this.delay.delayTime.value = 0.005;
    this.lfo = ctx.createOscillator();
    this.lfo.type = "sine";
    this.lfo.frequency.value = 0.5;
    this.depth = ctx.createGain();
    this.depth.gain.value = 0.003;
    this.lfo.connect(this.depth);
    this.depth.connect(this.delay.delayTime);
    this.input.connect(this.delay);
    this.delay.connect(this.output);
    this.lfo.start();
  }

  update(p: FxParams) {
    const rate = (p.bpm / 60) / Math.max(0.05, p.divisionBeats);
    const ms = 1 + p.param * 6; // 1 .. 7 ms sweep width
    const key = `${rate.toFixed(4)}:${ms.toFixed(3)}`;
    if (key === this.lastKey) return;
    this.lastKey = key;
    ramp(this.lfo.frequency, Math.min(20, Math.max(0.01, rate)), this.ctx, 0.03);
    ramp(this.depth.gain, ms / 2000, this.ctx, 0.03);
  }

  dispose() {
    try { this.lfo.stop(); } catch { /* not started */ }
    try { this.input.disconnect(); this.delay.disconnect(); this.depth.disconnect(); this.lfo.disconnect(); this.output.disconnect(); } catch { /* already detached */ }
  }
}

/* ---------- gater ---------- */

class GaterEffect implements FxEffect {
  readonly input: AudioNode;
  readonly output: AudioNode;
  readonly serial = true;
  private gate: GainNode;
  private lfo: OscillatorNode;
  private depth: GainNode;
  private ctx: BaseAudioContext;
  private lastRate = -1;

  constructor(ctx: BaseAudioContext) {
    this.ctx = ctx;
    this.input = ctx.createGain();
    this.output = ctx.createGain();
    this.gate = ctx.createGain();
    this.gate.gain.value = 0.5; // LFO adds +-0.5, so the gate swings 0 .. 1
    this.lfo = ctx.createOscillator();
    this.lfo.type = "square";
    this.lfo.frequency.value = 2;
    this.depth = ctx.createGain();
    this.depth.gain.value = 0.5;
    this.lfo.connect(this.depth);
    this.depth.connect(this.gate.gain);
    this.input.connect(this.gate);
    this.gate.connect(this.output);
    this.lfo.start();
  }

  update(p: FxParams) {
    const rate = (p.bpm / 60) / Math.max(0.05, p.divisionBeats);
    if (Math.abs(rate - this.lastRate) < 0.001) return;
    this.lastRate = rate;
    ramp(this.lfo.frequency, Math.min(40, Math.max(0.05, rate)), this.ctx, 0.02);
  }

  dispose() {
    try { this.lfo.stop(); } catch { /* not started */ }
    try { this.input.disconnect(); this.gate.disconnect(); this.depth.disconnect(); this.lfo.disconnect(); this.output.disconnect(); } catch { /* already detached */ }
  }
}

/* ---------- bitcrush ---------- */

function crushCurve(bits: number): Float32Array {
  const levels = Math.pow(2, Math.max(1, bits - 1));
  const n = 4096;
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = Math.round(x * levels) / levels;
  }
  return curve;
}

class BitcrushEffect implements FxEffect {
  readonly input: AudioNode;
  readonly output: AudioNode;
  readonly serial = true;
  private shaper: WaveShaperNode;
  private ctx: BaseAudioContext;
  private lastBits = -1;

  constructor(ctx: BaseAudioContext) {
    this.ctx = ctx;
    this.input = ctx.createGain();
    this.output = ctx.createGain();
    this.shaper = ctx.createWaveShaper();
    this.shaper.oversample = "none";
    this.input.connect(this.shaper);
    this.shaper.connect(this.output);
    this.setBits(10);
  }

  update(p: FxParams) {
    this.setBits(Math.max(3, Math.round(16 - p.param * 13)));
  }

  /**
   * Swap in a freshly built shaper. The spec allows assigning `curve` once per
   * node, so a bits change needs a new node rather than a new curve.
   */
  private setBits(bits: number): void {
    if (bits === this.lastBits) return;
    this.lastBits = bits;
    const next = this.ctx.createWaveShaper();
    next.oversample = "none";
    next.curve = crushCurve(bits) as Float32Array<ArrayBuffer>;
    try { this.input.disconnect(this.shaper); } catch { /* already detached */ }
    try { this.shaper.disconnect(); } catch { /* already detached */ }
    this.input.connect(next);
    next.connect(this.output);
    this.shaper = next;
  }

  dispose() {
    try { this.input.disconnect(); this.shaper.disconnect(); this.output.disconnect(); } catch { /* already detached */ }
  }
}

export function createEffect(ctx: BaseAudioContext, kind: FxKind): FxEffect {
  switch (kind) {
    case "echo": return new EchoEffect(ctx);
    case "reverb": return new ReverbEffect(ctx);
    case "flanger": return new FlangerEffect(ctx);
    case "gater": return new GaterEffect(ctx);
    case "bitcrush": return new BitcrushEffect(ctx);
  }
}
