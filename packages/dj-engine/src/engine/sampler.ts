/**
 * One-shot sampler (plan 3C).
 *
 * 4 banks x 16 pads. Each pad holds a decoded buffer plus a small config: gain,
 * mode (one-shot / gate / loop), choke group, and quantize. Output is a bus and
 * a volume, connected by the caller to the master bus pre-limiter, so samples
 * reach the recording, the radio-live feed and OBS capture like any other sound.
 *
 * Velocity maps to gain on a squared curve. A quantized hit is scheduled on the
 * next grid line supplied by the mixer's beat anchor.
 */
export type PadMode = "oneshot" | "gate" | "loop";
/** Quantize in beats: off, 1/16, 1 beat, 1 bar. */
export type PadQuantize = 0 | 0.25 | 1 | 4;

export type PadConfig = {
  name: string;
  /** 0..1 pad gain. */
  gain: number;
  mode: PadMode;
  /** 0 = none; pads in the same choke group cut each other. */
  choke: number;
  quantize: PadQuantize;
  /** Index into the UI's fixed 6-swatch colour set. */
  color: number;
};

export const SAMPLER_BANKS = 4;
export const SAMPLER_PADS = 16;
export const DEFAULT_PAD: PadConfig = { name: "", gain: 1, mode: "oneshot", choke: 0, quantize: 0, color: 0 };

export type TriggerOptions = {
  /** 0..1, defaults to 1. Mapped to gain on a squared curve. */
  velocity?: number;
  /** Overrides the pad's own quantize. */
  quantize?: PadQuantize;
};

type Voice = { bank: number; pad: number; src: AudioBufferSourceNode; gain: GainNode };

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

export class Sampler {
  /** Sampler bus; the caller connects this to the master bus. */
  readonly out: GainNode;
  /** Sampler volume, downstream of `out`. */
  readonly volume: GainNode;

  private ctx: BaseAudioContext;
  private buffers: Array<Array<AudioBuffer | null>>;
  private configs: Array<Array<PadConfig>>;
  private voices: Voice[] = [];
  private nextGrid: (divisionBeats: number, now: number) => number;

  constructor(ctx: BaseAudioContext, destination: AudioNode, nextGrid: (divisionBeats: number, now: number) => number) {
    this.ctx = ctx;
    this.nextGrid = nextGrid;
    this.out = ctx.createGain();
    this.volume = ctx.createGain();
    this.volume.gain.value = 0.9;
    this.out.connect(this.volume);
    this.volume.connect(destination);
    this.buffers = Array.from({ length: SAMPLER_BANKS }, () => Array<AudioBuffer | null>(SAMPLER_PADS).fill(null));
    this.configs = Array.from({ length: SAMPLER_BANKS }, () =>
      Array.from({ length: SAMPLER_PADS }, () => ({ ...DEFAULT_PAD })),
    );
  }

  getPad(bank: number, pad: number): PadConfig {
    return { ...this.configs[bank][pad] };
  }

  hasBuffer(bank: number, pad: number): boolean {
    return this.buffers[bank][pad] != null;
  }

  getBuffer(bank: number, pad: number): AudioBuffer | null {
    return this.buffers[bank][pad];
  }

  setBuffer(bank: number, pad: number, buffer: AudioBuffer | null, name?: string): void {
    this.buffers[bank][pad] = buffer;
    if (name !== undefined) this.configs[bank][pad].name = name;
  }

  setPad(bank: number, pad: number, patch: Partial<PadConfig>): void {
    this.configs[bank][pad] = { ...this.configs[bank][pad], ...patch };
  }

  setVolume(v: number): void {
    this.volume.gain.setTargetAtTime(clamp01(v), this.ctx.currentTime, 0.01);
  }

  /** Serialisable config for one bank, for persistence. */
  bankConfig(bank: number): PadConfig[] {
    return this.configs[bank].map((c) => ({ ...c }));
  }

  /**
   * Fire a pad. Returns the context time the voice starts, or null when the pad
   * is empty or the requested bank/pad is out of range.
   */
  trigger(bank: number, pad: number, opts: TriggerOptions = {}): number | null {
    const buffer = this.buffers[bank]?.[pad];
    if (!buffer) return null;
    const cfg = this.configs[bank][pad];
    const velocity = clamp01(opts.velocity ?? 1);
    const level = clamp01(cfg.gain) * velocity * velocity;
    const quantize = opts.quantize ?? cfg.quantize;
    const now = this.ctx.currentTime;
    const when = quantize > 0 ? Math.max(now, this.nextGrid(quantize, now)) : now;

    if (cfg.choke > 0) this.chokeGroup(cfg.choke);

    const gain = this.ctx.createGain();
    gain.gain.value = level;
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    if (cfg.mode === "loop") {
      src.loop = true;
    }
    src.connect(gain);
    gain.connect(this.out);
    src.start(when);
    if (cfg.mode === "oneshot") src.stop(when + buffer.duration);

    const voice: Voice = { bank, pad, src, gain };
    src.onended = () => this.dropVoice(voice);
    this.voices.push(voice);
    return when;
  }

  /** Release a held gate/loop pad; a one-shot ignores this. */
  release(bank: number, pad: number): void {
    for (const v of this.voices) {
      if (v.bank === bank && v.pad === pad && this.configs[bank][pad].mode !== "oneshot") {
        this.stopVoice(v);
      }
    }
  }

  stop(bank: number, pad: number): void {
    for (const v of this.voices) {
      if (v.bank === bank && v.pad === pad) this.stopVoice(v);
    }
  }

  stopAll(): void {
    for (const v of [...this.voices]) this.stopVoice(v);
  }

  /** Pads currently sounding. */
  activeCount(): number {
    return this.voices.length;
  }

  private chokeGroup(group: number): void {
    // The new voice is not in `voices` yet, so this also cuts a retrigger of the
    // same pad — a choke pad is monophonic.
    for (const v of [...this.voices]) {
      if (this.configs[v.bank][v.pad].choke === group) this.stopVoice(v);
    }
  }

  private stopVoice(v: Voice): void {
    const now = this.ctx.currentTime;
    v.gain.gain.setTargetAtTime(0, now, 0.008);
    try { v.src.stop(now + 0.04); } catch { /* already stopped */ }
  }

  private dropVoice(v: Voice): void {
    const i = this.voices.indexOf(v);
    if (i >= 0) this.voices.splice(i, 1);
  }
}
