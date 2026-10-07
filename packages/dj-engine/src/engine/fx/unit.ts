/**
 * FxUnit: one beat-synced insert effect with dry/wet, an on/off send and a beat
 * division. FxSlot: the insertion point on a bus. FxRack: two units and the
 * three slots (Deck A, Deck B, master), with click-free assignment.
 *
 * On/off closes the *send* into the effect, not the effect output, so echo and
 * reverb tails ring out after switch-off (plan 3B.3). An effect that replaces
 * the signal (gater, bitcrush) crossfades dry to `1 - wet`; a parallel effect
 * (echo, reverb, flanger) keeps the dry at full and adds the wet.
 */
import { createEffect, type FxEffect, type FxParams } from "./effects";
import { FX_DIVISIONS, type FxDivision, type FxKind, type FxState, type FxTarget } from "./types";

const ramp = (p: AudioParam, v: number, ctx: BaseAudioContext, tau = 0.01) => p.setTargetAtTime(v, ctx.currentTime, tau);

export class FxUnit {
  readonly input: GainNode;
  readonly output: GainNode;
  private dry: GainNode;
  private wetGain: GainNode;
  private send: GainNode;
  private effect: FxEffect | null = null;
  private kind: FxKind = "echo";
  private on = false;
  private wetAmount = 0.5;
  private param = 0.5;
  private division: FxDivision = 0.5;
  private bpm = 120;
  private target: FxTarget | null = null;
  private ctx: BaseAudioContext;

  constructor(ctx: BaseAudioContext) {
    this.ctx = ctx;
    this.input = ctx.createGain();
    this.output = ctx.createGain();
    this.dry = ctx.createGain();
    this.wetGain = ctx.createGain();
    this.send = ctx.createGain();
    this.dry.gain.value = 1;
    this.wetGain.gain.value = 0;
    this.send.gain.value = 0;
    this.input.connect(this.dry);
    this.dry.connect(this.output);
    this.input.connect(this.send);
    this.wetGain.connect(this.output);
    // No effect is built until one is chosen (or the unit is switched on). This
    // keeps a bypassed mixer's graph to plain gains, so the autopilot and the
    // ingest path never pay for delay/convolver nodes they do not use.
  }

  state(): FxState {
    return { kind: this.kind, target: this.target, on: this.on, wet: this.wetAmount, param: this.param, division: this.division };
  }

  setTarget(target: FxTarget | null): void {
    this.target = target;
  }

  /** Rebuild the effect graph. The send is momentarily closed so no burst leaks. */
  setEffect(kind: FxKind): void {
    if (kind === this.kind && this.effect) return;
    this.kind = kind;
    this.buildEffect(kind);
  }

  private buildEffect(kind: FxKind): void {
    this.send.gain.setValueAtTime(0, this.ctx.currentTime);
    if (this.effect) {
      try { this.send.disconnect(this.effect.input); } catch { /* already detached */ }
      this.effect.dispose();
    }
    this.effect = createEffect(this.ctx, kind);
    this.send.connect(this.effect.input);
    this.effect.output.connect(this.wetGain);
    this.applyParams();
    // Restore the send without a click; only if it was open.
    ramp(this.send.gain, this.on ? 1 : 0, this.ctx, 0.01);
  }

  setOn(on: boolean): void {
    this.on = on;
    if (on && !this.effect) this.buildEffect(this.kind);
    this.applyGains();
  }

  setWet(wet: number): void {
    this.wetAmount = Math.min(1, Math.max(0, wet));
    this.applyGains();
  }

  setParam(param: number): void {
    this.param = Math.min(1, Math.max(0, param));
    this.applyParams();
  }

  /** Follow a deck's effective BPM and the chosen beat division. */
  setSync(bpm: number, division: FxDivision): void {
    this.bpm = Number.isFinite(bpm) && bpm > 0 ? bpm : 120;
    this.division = division;
    this.applyParams();
  }

  setDivision(division: FxDivision): void {
    this.division = division;
    this.applyParams();
  }

  private applyParams(): void {
    const p: FxParams = { wet: this.wetAmount, param: this.param, divisionBeats: this.division, bpm: this.bpm };
    this.effect?.update(p);
  }

  private applyGains(): void {
    const serial = this.effect?.serial ?? false;
    const dryTarget = serial ? (this.on ? 1 - this.wetAmount : 1) : 1;
    ramp(this.dry.gain, dryTarget, this.ctx, 0.01);
    ramp(this.wetGain.gain, this.wetAmount, this.ctx, 0.01);
    // Off closes the send, never the output: tails ring out.
    ramp(this.send.gain, this.on ? 1 : 0, this.ctx, 0.01);
  }

  dispose(): void {
    this.effect?.dispose();
    try { this.input.disconnect(); this.dry.disconnect(); this.wetGain.disconnect(); this.send.disconnect(); this.output.disconnect(); } catch { /* already detached */ }
  }
}

/** One insertion point on a bus: a dry path and a send/return around a unit. */
export class FxSlot {
  readonly input: GainNode;
  readonly output: GainNode;
  private dry: GainNode;
  private send: GainNode;
  private ret: GainNode;
  unit: FxUnit | null = null;
  private ctx: BaseAudioContext;

  constructor(ctx: BaseAudioContext) {
    this.ctx = ctx;
    this.input = ctx.createGain();
    this.output = ctx.createGain();
    this.dry = ctx.createGain();
    this.send = ctx.createGain();
    this.ret = ctx.createGain();
    this.dry.gain.value = 1;
    this.send.gain.value = 0;
    this.ret.gain.value = 0;
    this.input.connect(this.dry);
    this.dry.connect(this.output);
    this.input.connect(this.send);
    this.ret.connect(this.output);
  }

  attach(unit: FxUnit): void {
    this.detach();
    this.unit = unit;
    this.send.connect(unit.input);
    unit.output.connect(this.ret);
    ramp(this.dry.gain, 0, this.ctx, 0.01);
    ramp(this.send.gain, 1, this.ctx, 0.01);
    ramp(this.ret.gain, 1, this.ctx, 0.01);
  }

  detach(): void {
    const u = this.unit;
    if (!u) return;
    this.unit = null;
    // The evicted unit is no longer on any bus; clear its route so the UI does
    // not report a bus the sound is not actually on.
    u.setTarget(null);
    ramp(this.dry.gain, 1, this.ctx, 0.01);
    ramp(this.send.gain, 0, this.ctx, 0.01);
    ramp(this.ret.gain, 0, this.ctx, 0.01);
    try { this.send.disconnect(u.input); } catch { /* already detached */ }
    try { u.output.disconnect(this.ret); } catch { /* already detached */ }
  }
}

export class FxRack {
  readonly units: [FxUnit, FxUnit];
  readonly slots: Record<FxTarget, FxSlot>;

  constructor(ctx: BaseAudioContext) {
    this.units = [new FxUnit(ctx), new FxUnit(ctx)];
    this.slots = { A: new FxSlot(ctx), B: new FxSlot(ctx), master: new FxSlot(ctx) };
  }

  /** Patch a unit onto a bus (or `null` to bypass). A unit lives on one bus at a time. */
  assign(unitIndex: 0 | 1, target: FxTarget | null): void {
    const unit = this.units[unitIndex];
    for (const t of ["A", "B", "master"] as const) {
      if (this.slots[t].unit === unit) this.slots[t].detach();
    }
    unit.setTarget(target);
    if (target) this.slots[target].attach(unit);
  }

  dispose(): void {
    for (const u of this.units) u.dispose();
  }
}

export { FX_DIVISIONS };
