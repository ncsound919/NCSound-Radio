/**
 * Output devices and the headphone cue (plan 3A).
 *
 * Master output uses `AudioContext.setSinkId` (Chromium). The cue path is a
 * separate `MediaStreamAudioDestinationNode`: the pre-fader cue bus plus an
 * optional master blend are summed into it, and it plays through an `<audio>`
 * element on the chosen headphone device. Both fall back honestly on browsers
 * without the APIs rather than silently doing nothing.
 */
import type { Mixer } from "@ncsound/dj-engine/mixer";

export type OutputDevice = { id: string; label: string };

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** `AudioContext.setSinkId` is Chromium-only. */
export const masterOutputSupported = (): boolean =>
  typeof AudioContext !== "undefined" && "setSinkId" in AudioContext.prototype;

/** `HTMLMediaElement.setSinkId` is Chromium-only. */
export const headphoneSupported = (): boolean =>
  typeof HTMLMediaElement !== "undefined" && "setSinkId" in HTMLMediaElement.prototype;

/**
 * List output devices. Labels are hidden by the browser until some media
 * permission has been granted, so `requestPermission` briefly opens (and closes)
 * the microphone to unlock them — that is the only way the spec allows it.
 */
export async function listOutputs(requestPermission = false): Promise<OutputDevice[]> {
  if (typeof navigator === "undefined" || !navigator.mediaDevices?.enumerateDevices) return [];
  if (requestPermission) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((t) => t.stop());
    } catch {
      /* denied: we fall back to generic labels */
    }
  }
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices
    .filter((d) => d.kind === "audiooutput")
    .map((d, i) => ({ id: d.deviceId || "default", label: d.label || `Output ${i + 1}` }));
}

export async function setMasterOutput(mixer: Mixer, deviceId: string): Promise<{ ok: boolean; message: string }> {
  const ctx = mixer.ctx as AudioContext & { setSinkId?: (id: string | { type: string; id?: string }) => Promise<void> };
  if (typeof ctx.setSinkId !== "function") {
    return { ok: false, message: "This browser can't pick an output device; using the system default." };
  }
  try {
    await ctx.setSinkId(deviceId);
    return { ok: true, message: "" };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Couldn't switch the master output." };
  }
}

export class HeadphoneCue {
  private cueGain?: GainNode;
  private masterBlend?: GainNode;
  private levelGain?: GainNode;
  private dest?: MediaStreamAudioDestinationNode;
  private el?: HTMLAudioElement;
  private mix = 1;
  private level = 0.8;

  constructor(private mixer: Mixer) {}

  get active(): boolean {
    return !!this.dest;
  }

  async start(deviceId: string): Promise<{ ok: boolean; message: string }> {
    if (!headphoneSupported()) {
      return { ok: false, message: "This browser can't send audio to a second device; single output only." };
    }
    const ctx = mixerCtx(this.mixer);
    if (!this.dest) {
      this.dest = ctx.createMediaStreamDestination();
      this.cueGain = ctx.createGain();
      this.masterBlend = ctx.createGain();
      const sum = ctx.createGain();
      this.levelGain = ctx.createGain();
      this.cueGain.connect(sum);
      this.masterBlend.connect(sum);
      sum.connect(this.levelGain);
      this.levelGain.connect(this.dest);
      // Taps survive the engine's own re-routing.
      this.mixer.addCueTap(this.cueGain);
      this.mixer.addProgramTap(this.masterBlend);
      this.applyGains();
    }
    const el = this.el ?? new Audio();
    el.srcObject = this.dest.stream;
    el.autoplay = true;
    try {
      await (el as HTMLMediaElement & { setSinkId(id: string): Promise<void> }).setSinkId(deviceId);
    } catch {
      /* device may have vanished; fall through to default sink */
    }
    try {
      await el.play();
    } catch {
      return { ok: false, message: "Couldn't start the headphone output; click anywhere and try again." };
    }
    this.el = el;
    return { ok: true, message: "" };
  }

  stop(): void {
    if (this.el) {
      this.el.pause();
      this.el.srcObject = null;
    }
  }

  setMix(v: number): void {
    this.mix = clamp01(v);
    this.applyGains();
  }

  setLevel(v: number): void {
    this.level = clamp01(v);
    this.applyGains();
  }

  /** Web Audio's reported latency for this path, in ms. The `<audio>` element may add more. */
  latencyMs(): number | null {
    const ctx = mixerCtx(this.mixer) as AudioContext & { outputLatency?: number };
    const base = ctx.baseLatency;
    if (typeof base !== "number") return null;
    const out = typeof ctx.outputLatency === "number" ? ctx.outputLatency : 0;
    return (base + out) * 1000;
  }

  private applyGains(): void {
    if (!this.cueGain || !this.masterBlend || !this.levelGain) return;
    const now = this.mixer.ctx.currentTime;
    this.cueGain.gain.setTargetAtTime(this.mix, now, 0.01);
    this.masterBlend.gain.setTargetAtTime(1 - this.mix, now, 0.01);
    this.levelGain.gain.setTargetAtTime(this.level, now, 0.01);
  }
}

function mixerCtx(mixer: Mixer): AudioContext {
  return mixer.ctx as AudioContext;
}
