import type { ScratchConfig } from "../config";
import { CTRL_HZ, gateCurve, slewLimit, underdampedSmooth } from "./curves";
import type { Primitive } from "./primitives";
import { baby, cutForward, stab, transform } from "./primitives";
import { readSinc } from "./resample";
import type { ScratchEvent } from "../schemas";

export interface RenderedEvent {
  audio: Float64Array;
  posMin: number; // source samples
  posMax: number;
  maxEdgeJump: number; // max |sample-to-sample jump| where the gate changes
  sumSq: number;
  n: number;
}

export interface Placed {
  t0: number; // output seconds
  prim: Primitive;
  s0: number; // source start, seconds
  gain: number;
}

export type RenderCfg = Pick<
  ScratchConfig,
  "max_slew" | "f0" | "zeta" | "ramp_ms" | "sinc_half" | "sinc_beta" | "ring_off_s"
>;

export function renderEvent(
  src: ArrayLike<number>,
  fs: number,
  prim: Primitive,
  startSec: number,
  cfg: RenderCfg,
  gain = 1,
): RenderedEvent {
  const tail = Math.floor(cfg.ring_off_s * CTRL_HZ);
  const raw = new Float64Array(prim.rate.length + tail);
  raw.set(prim.rate);
  const rate = underdampedSmooth(slewLimit(raw, cfg.max_slew / CTRL_HZ), CTRL_HZ, cfg.f0, cfg.zeta);

  const n = Math.floor((rate.length / CTRL_HZ) * fs);
  // linear interpolation of the control-rate curve up to audio rate
  const rA = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const c = (i / fs) * CTRL_HZ;
    const k = Math.min(Math.floor(c), rate.length - 1);
    const k1 = Math.min(k + 1, rate.length - 1);
    rA[i] = rate[k] + (rate[k1] - rate[k]) * (c - k);
  }
  // rate is source-sec per output-sec; source sr == fs, so one unit = one source sample per output sample
  const pos = new Float64Array(n);
  let acc = startSec * fs;
  let posMin = Infinity;
  let posMax = -Infinity;
  for (let i = 0; i < n; i++) {
    acc += rA[i];
    pos[i] = acc;
    if (acc < posMin) posMin = acc;
    if (acc > posMax) posMax = acc;
  }

  const y = readSinc(src, pos, rA, cfg.sinc_half, cfg.sinc_beta);
  const g = gateCurve(prim.gate, n, fs, cfg.ramp_ms);
  let maxEdgeJump = 0;
  let sumSq = 0;
  for (let i = 0; i < n; i++) {
    y[i] *= g[i] * gain;
    sumSq += y[i] * y[i];
    if (i > 0 && Math.abs(g[i] - g[i - 1]) > 1e-4) {
      const j = Math.abs(y[i] - y[i - 1]);
      if (j > maxEdgeJump) maxEdgeJump = j;
    }
  }
  return { audio: y, posMin, posMax, maxEdgeJump, sumSq, n };
}

/** Sum rendered events onto a timeline. Returns the mix plus each event's stats. */
export function renderTimeline(
  src: ArrayLike<number>,
  fs: number,
  placed: Placed[],
  totalSec: number,
  cfg: RenderCfg,
): { audio: Float64Array; rendered: RenderedEvent[] } {
  const out = new Float64Array(Math.floor(totalSec * fs));
  const rendered: RenderedEvent[] = [];
  for (const p of placed) {
    const r = renderEvent(src, fs, p.prim, p.s0, cfg, p.gain);
    rendered.push(r);
    const a = Math.max(0, Math.floor(p.t0 * fs));
    const b = Math.min(out.length, a + r.audio.length);
    for (let i = a; i < b; i++) out[i] += r.audio[i - a];
  }
  return { audio: out, rendered };
}

/** Build the primitive that a composed ScratchEvent describes. */
export function eventToPrimitive(ev: ScratchEvent): Primitive {
  switch (ev.primitive) {
    case "baby":
      return baby(ev.stroke_T, ev.span, ev.n_strokes);
    case "cut_forward":
      return cutForward(ev.stroke_T, ev.span, ev.n_strokes);
    case "stab":
      return stab(ev.stroke_T, ev.span);
    case "transform":
      return transform(ev.stroke_T, ev.span, ev.params.n_chops ?? 4, ev.params.duty ?? 0.5);
    default:
      throw new Error(`cannot render primitive "${ev.primitive}"`);
  }
}

/** Peak-normalize headroom, applied at export only. Never hides a Critic failure. */
export function applyHeadroom(y: Float64Array, headroomDb: number) {
  let peak = 0;
  for (let i = 0; i < y.length; i++) peak = Math.max(peak, Math.abs(y[i]));
  const target = Math.pow(10, headroomDb / 20);
  const k = peak > target ? target / peak : 1;
  const out = new Float32Array(y.length);
  for (let i = 0; i < y.length; i++) out[i] = y[i] * k;
  return out;
}
