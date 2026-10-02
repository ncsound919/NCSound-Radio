import { describe, expect, it } from "vitest";
import { buildSliceBank, gridFromBpm } from "../src/analysis/slicerLite";
import { compose } from "../src/composer/compose";
import { gridErrorSec, quantizeBeat } from "../src/composer/placement";
import { DEFAULT_CONFIG } from "../src/config";
import { evaluate } from "../src/critic/rules";
import { buildContext, rulesDirector } from "../src/director/rulesDirector";
import { runScratchAgent } from "../src/pipeline";
import { CTRL_HZ, slewLimit, underdampedSmooth } from "../src/scratch/curves";
import { baby, stab, strokeRate } from "../src/scratch/primitives";
import { renderEvent } from "../src/scratch/render";
import { validateDirectorPlan } from "../src/schemas";
import type { DirectorPlan } from "../src/schemas";

const FS = 44100;
const cfg = DEFAULT_CONFIG;

function tone(sec: number, hz = 220, amp = 0.5) {
  const x = new Float32Array(Math.floor(sec * FS));
  for (let i = 0; i < x.length; i++) x[i] = amp * Math.sin((2 * Math.PI * hz * i) / FS);
  return x;
}

/** Synthetic "vocal": decaying bursts every 250 ms so the onset detector has something to find. */
function bursts(sec: number) {
  const x = new Float32Array(Math.floor(sec * FS));
  for (let t = 0.1; t < sec - 0.3; t += 0.25) {
    const a = Math.floor(t * FS);
    for (let i = 0; i < 0.18 * FS; i++) {
      x[a + i] += 0.7 * Math.exp(-i / (0.06 * FS)) * Math.sin((2 * Math.PI * (180 + 40 * ((t * 4) % 3)) * i) / FS);
    }
  }
  return x;
}

describe("renderer", () => {
  it("baby scratch on a tone is finite, bounded, and stays inside the source", () => {
    const src = tone(2);
    const r = renderEvent(src, FS, baby(0.125, 0.2, 4), 0.5, cfg);
    expect(r.audio.every(Number.isFinite)).toBe(true);
    expect(Math.max(...r.audio.map(Math.abs))).toBeLessThanOrEqual(1);
    expect(r.posMin).toBeGreaterThanOrEqual(0);
    expect(r.posMax).toBeLessThanOrEqual(src.length - 1);
  });

  it("gate edges do not click on a constant source", () => {
    const src = new Float32Array(FS * 2).fill(0.5);
    const r = renderEvent(src, FS, stab(0.2, 0.15), 0.5, cfg);
    expect(r.maxEdgeJump).toBeLessThan(cfg.gate_click_max);
  });

  it("is bit-for-bit deterministic", () => {
    const src = bursts(2);
    const a = renderEvent(src, FS, baby(0.1, 0.15, 3), 0.3, cfg);
    const b = renderEvent(src, FS, baby(0.1, 0.15, 3), 0.3, cfg);
    expect(Buffer.from(a.audio.buffer).equals(Buffer.from(b.audio.buffer))).toBe(true);
  });

  it("stroke covers `span` source-seconds within 1% with slew and smoothing off", () => {
    const rate = strokeRate(0.2, 0.15);
    const pos = rate.reduce((s, v) => s + v, 0) / CTRL_HZ;
    expect(Math.abs(pos - 0.15) / 0.15).toBeLessThan(0.01);
  });

  it("smoother has unity DC gain and no startup transient", () => {
    const y = underdampedSmooth(new Float64Array(200).fill(1.5), CTRL_HZ);
    expect(Math.max(...y.map((v) => Math.abs(v - 1.5)))).toBeLessThan(1e-9);
    const s = slewLimit(Float64Array.from([0, 10, 10]), 0.1);
    expect(s[1]).toBeCloseTo(0.1);
  });
});

describe("composer", () => {
  const src = bursts(6);
  const bank = buildSliceBank(src, FS);
  const grid = gridFromBpm(96, 0, 6);
  const plan: DirectorPlan = {
    bars: 2,
    style: "sparse",
    items: [
      { slice_id: bank.slices[0].id, primitive: "stab", beat: 0.13, length_beats: 0.5, intensity: 0.6 },
      { slice_id: bank.slices[1].id, primitive: "baby", beat: 1, length_beats: 1, intensity: 0.9 },
      { slice_id: bank.slices[2].id, primitive: "stab", beat: 2, length_beats: 0.5, intensity: 0.4 },
      { slice_id: bank.slices[3].id, primitive: "stab", beat: 3.9, length_beats: 0.5, intensity: 0.3 },
      { slice_id: bank.slices[0].id, primitive: "rest", beat: 4, length_beats: 1, intensity: 0.5 },
    ],
  };
  const hook = { ...cfg, placement_mode: "hook" as const };

  it("finds slices in the synthetic source", () => expect(bank.slices.length).toBeGreaterThan(5));

  it("quantizes to 16ths and applies swing to off-16ths only", () => {
    expect(quantizeBeat(0.13, 4, 0)).toBe(0.25);
    expect(quantizeBeat(0.25, 4, 0.2)).toBeCloseTo(0.25 + 0.05);
    expect(quantizeBeat(0.5, 4, 0.2)).toBe(0.5);
  });

  it("respects the density cap, drops rests and unplayed last-beat items", () => {
    const ev = compose(plan, bank, grid, hook, { seed: 1, phraseStartBeat: 0, srcDuration: 6 });
    expect(ev.length).toBe(3); // 4th item is in the last beat at intensity 0.3, rest is skipped
    expect(ev.every((e) => e.primitive !== "rest")).toBe(true);
    const perBar = ev.filter((e) => e.t0 < (60 / 96) * 4).length;
    expect(perBar).toBeLessThanOrEqual(cfg.density_cap.sparse);
  });

  it("is deterministic and seed-sensitive in micro-timing", () => {
    const o = { phraseStartBeat: 0, srcDuration: 6 };
    const a = compose(plan, bank, grid, hook, { seed: 5, ...o });
    const b = compose(plan, bank, grid, hook, { seed: 5, ...o });
    const c = compose(plan, bank, grid, hook, { seed: 6, ...o });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(c));
  });

  it("keeps events within a few ms of the grid and peak rate under max_rate", () => {
    const ev = compose(plan, bank, grid, hook, { seed: 2, phraseStartBeat: 0, srcDuration: 6 });
    for (const e of ev) {
      expect(gridErrorSec(grid.beats, e.t0, 4, 0) * 1000).toBeLessThan(15);
      expect((Math.PI * e.span) / (2 * e.stroke_T)).toBeLessThanOrEqual(cfg.max_rate + 1e-9);
    }
  });

  it("answer mode never lets an attack land on a vocal onset", () => {
    const ans = { ...cfg, placement_mode: "answer" as const };
    const ev = compose(plan, bank, grid, ans, { seed: 3, phraseStartBeat: 0, srcDuration: 6 });
    for (const e of ev) {
      for (const on of bank.vocal_onsets) {
        const d = on - e.t0;
        expect(d > -cfg.onset_margin_s && d < cfg.attack_check_s).toBe(false);
      }
    }
  });
});

describe("critic", () => {
  const src = bursts(6);
  const bank = buildSliceBank(src, FS);
  const grid = gridFromBpm(96, 0, 6);
  const hook = { ...cfg, placement_mode: "hook" as const };
  const ctx = buildContext(bank, grid, 2, "medium");
  const plan = rulesDirector(ctx, 1, hook);
  const events = compose(plan, bank, grid, hook, { seed: 1, phraseStartBeat: 0, srcDuration: 6 });
  const base = () => ({
    events,
    audio: new Float64Array(FS).fill(0.1),
    rendered: [{ audio: new Float64Array(1), posMin: 100, posMax: 5000, maxEdgeJump: 0, sumSq: 1, n: 100 }],
    grid,
    style: "medium" as const,
    srcLenSamples: src.length,
    srcDuration: 6,
    phraseStartTime: 0,
    cfg: hook,
  });
  const named = (r: ReturnType<typeof evaluate>, n: string) => r.checks.find((c) => c.name === n)!;

  it("catches NaN, clipping, silence, range overruns and off-grid events", () => {
    const nan = base();
    nan.audio[5] = NaN;
    expect(evaluate(nan).fatal).toContain("finite_audio");

    const clip = base();
    clip.audio[3] = 1.5;
    expect(named(evaluate(clip), "clipping").passed).toBe(false);

    const quiet = base();
    quiet.rendered[0].sumSq = 0;
    expect(named(evaluate(quiet), "silence").passed).toBe(false);

    const range = base();
    range.rendered[0].posMax = src.length + 10;
    expect(evaluate(range).fatal).toContain("source_range");

    const off = base();
    off.events = events.map((e) => ({ ...e, t0: e.t0 + 0.04 })); // ~40 ms late
    expect(named(evaluate(off), "grid_adherence").passed).toBe(false);
  });

  it("marks intelligibility as NOT MEASURED", () => {
    expect(named(evaluate(base()), "intelligibility").note).toBe("NOT MEASURED");
  });
});

describe("plan validation", () => {
  it("rejects out-of-range values", () => {
    expect(validateDirectorPlan({ bars: 3, style: "sparse", items: [] }).ok).toBe(false);
    expect(validateDirectorPlan({ bars: 2, style: "sparse", items: [{ slice_id: 1, primitive: "baby", beat: 0, length_beats: 5, intensity: 0.5 }] }).ok).toBe(false);
    expect(validateDirectorPlan({ bars: 2, style: "sparse", items: [] }).ok).toBe(true);
  });
});

describe("pipeline", () => {
  it("runs end-to-end with the rules director and is deterministic for a seed", async () => {
    const src = bursts(6);
    const bank = buildSliceBank(src, FS);
    const grid = gridFromBpm(96, 0, 6);
    const opts = { src, fs: FS, bank, grid, bars: 2 as const, style: "medium" as const, seed: 7, phraseStartBeat: 0, cfg: { placement_mode: "hook" as const } };
    const a = await runScratchAgent(opts);
    const b = await runScratchAgent(opts);
    expect(a.events.length).toBeGreaterThan(0);
    expect(a.audio.every(Number.isFinite)).toBe(true);
    expect(Buffer.from(a.audio.buffer).equals(Buffer.from(b.audio.buffer))).toBe(true);
    expect(a.attempts.length).toBeGreaterThan(0);
  });
});
