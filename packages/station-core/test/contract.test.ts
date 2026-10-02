import { describe, expect, test } from "bun:test";
import { djCommandSchema, commandEnvelopeSchema } from "../src/schema/index.ts";
import { COMMAND_TYPES } from "../src/contract/control.ts";

const actor = { id: "console-1", role: "console", label: "DJ Console" };

const SAMPLES: Record<string, Record<string, unknown>> = {
  "mix.setCrossfader": { position: 0 },
  "mix.setCrossfaderCurve": { curve: "blend" },
  "mix.setDeckVolume": { slot: 0, volume: 0.5 },
  "mix.setEq": { slot: 0, band: "low", db: 0 },
  "mix.setFilter": { slot: 0, bipolar: 0 },
  "mix.setMasterGain": { gain: 0.5 },
  "mix.setAutoGain": { enabled: true },
  "mix.setTransitionBars": { bars: 4 },
  "mix.mixNext": {},
  "cue.track": { trackId: "t" },
  "cue.request": { requestId: "r" },
  "cue.seek": { slot: 0, seconds: 10 },
  "cue.hotCue": { slot: 0, cue: "intro" },
  "cue.loop": { slot: 0, enabled: true },
  "sync.deck": { slot: 0 },
  "sync.both": {},
  "sync.masterBpm": { bpm: 124 },
  "sync.phaseAlign": {},
  "scratch.pattern": { patternId: "baby" },
  "scratch.agent": {},
  "imaging.play": { jingleId: "j1" },
  "autopilot.set": { enabled: true },
  "autopilot.setVibe": { templateId: "club-peak" },
  "autopilot.resequence": {},
  "autopilot.setEnergyTarget": { energy: 0.5 },
  "library.load": { path: "/m/a.mp3" },
  "library.analyze": { trackIds: ["a"] },
  "library.setPitchRange": { range: 8 },
  "library.setPreset": { preset: { id: "auto", name: "Auto", bars: 4, curve: "equal-power" } },
  "query.analysis": { trackId: "t" },
};

describe("command coverage", () => {
  test("every declared command type has a schema branch", () => {
    expect(djCommandSchema.options.length).toBe(COMMAND_TYPES.length);
  });

  test.each(COMMAND_TYPES)("%s accepts a minimal valid payload", (type) => {
    const r = djCommandSchema.safeParse({ type, ...(SAMPLES[type] ?? {}) });
    expect(r.success).toBe(true);
  });
});

describe("valid commands", () => {
  const valid: unknown[] = [
    { type: "transport.play" },
    { type: "mix.setCrossfader", position: -1 },
    { type: "mix.setCrossfader", position: 1 },
    { type: "mix.setCrossfader", position: 0 },
    { type: "mix.setEq", slot: 0, band: "high", db: -6 },
    { type: "mix.setEq", slot: 1, band: "low", db: -48 },
    { type: "cue.track", trackId: "abc", slot: 1 },
    { type: "cue.track", trackId: "abc" },
    { type: "cue.hotCue", slot: 1, cue: "drop" },
    { type: "scratch.pattern", patternId: "transformer" },
    { type: "scratch.agent", bars: 4, style: "busy", seed: 7, useLlm: true },
    { type: "scratch.agent", bars: 2 },
    { type: "autopilot.setEnergyTarget", energy: 0 },
    { type: "autopilot.setEnergyTarget", energy: 1 },
    { type: "library.analyze", trackIds: ["a", "b"], analyzer: "essentia" },
    { type: "library.setPitchRange", range: 16 },
    { type: "sync.deck", slot: 1, multiplier: 0.5 },
    { type: "library.setPreset", preset: { id: "vb", name: "Vinyl Brake", bars: 2, curve: "linear", style: "vinyl-brake" } },
  ];

  test.each(valid)("accepts %j", (c) => {
    expect(djCommandSchema.safeParse(c).success).toBe(true);
  });
});

describe("malformed and hostile input is rejected", () => {
  // NB: enumerated with an explicit loop rather than test.each -- bun 1.3.14
  // hangs when a test.each table entry is itself an empty array.
  const invalid: Array<[string, unknown]> = [
    ["crossfader above range", { type: "mix.setCrossfader", position: 2 }],
    ["crossfader below range", { type: "mix.setCrossfader", position: -2 }],
    ["crossfader wrong type", { type: "mix.setCrossfader", position: "loud" }],
    ["crossfader missing param", { type: "mix.setCrossfader" }],
    ["unknown command type", { type: "transport.explode" }],
    ["deck slot out of range", { type: "mix.setEq", slot: 2, band: "high", db: -6 }],
    ["unknown eq band", { type: "mix.setEq", slot: 0, band: "treble", db: -6 }],
    ["non-enum pitch range", { type: "library.setPitchRange", range: 7 }],
    ["unknown scratch pattern", { type: "scratch.pattern", patternId: "uzis-not-real" }],
    ["empty track id", { type: "cue.request", requestId: "" }],
    ["empty track list", { type: "library.analyze", trackIds: [] }],
    ["energy target above 1", { type: "autopilot.setEnergyTarget", energy: 1.5 }],
    ["non-enum bar count", { type: "scratch.agent", bars: 3 }],
    ["absurd bpm", { type: "sync.masterBpm", bpm: 12 }],
    ["null", null],
    ["undefined", undefined],
    ["number", 42],
    ["bare string", "transport.play"],
    ["empty array", []],
    ["empty object", {}],
    ["array of commands", [{ type: "transport.play" }]],
  ];

  for (const [label, payload] of invalid) {
    test(`rejects ${label}`, () => {
      expect(djCommandSchema.safeParse(payload).success).toBe(false);
    });
  }

  test("ignores a __proto__ key without polluting Object.prototype", () => {
    const payload = JSON.parse('{"type":"transport.play","__proto__":{"polluted":"yes"}}');
    const r = djCommandSchema.safeParse(payload);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(r.success).toBe(true);
    expect(r.success && r.data).toEqual({ type: "transport.play" });
  });
});

describe("envelope", () => {
  test("accepts a full envelope", () => {
    const r = commandEnvelopeSchema.safeParse({
      id: "cmd-1",
      issuedAt: new Date().toISOString(),
      actor,
      command: { type: "cue.track", trackId: "t1", slot: 0 },
    });
    expect(r.success).toBe(true);
  });

  test("rejects role escalation", () => {
    const r = commandEnvelopeSchema.safeParse({
      id: "cmd-1",
      issuedAt: "2026-01-01T00:00:00.000Z",
      actor: { id: "x", role: "root", label: "x" },
      command: { type: "transport.play" },
    });
    expect(r.success).toBe(false);
  });

  test("rejects an unknown actor role", () => {
    const r = commandEnvelopeSchema.safeParse({
      id: "cmd-1",
      issuedAt: "2026-01-01T00:00:00.000Z",
      actor: { id: "x", role: "admin", label: "x" },
      command: { type: "transport.play" },
    });
    expect(r.success).toBe(false);
  });
});