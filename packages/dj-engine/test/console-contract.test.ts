/**
 * Console contract: characterization tests for the Mixer API the redesigned DJ
 * console is built on (plan phase 0.7).
 *
 * These pin today's behaviour of every call the new UI makes - load, play,
 * pause, per-deck play, pitch, key lock and shift, loops, hot cues, beat jump,
 * EQ kills, crossfader law - against a real Web Audio graph (node-web-audio-api,
 * headless), not mocks. Where a check needs sound it measures the master bus.
 * If one of these fails after a UI phase, the engine changed under the console.
 */
import { describe, expect, test } from "bun:test";
import { Mixer } from "../src/engine/mixer";
import { createHeadlessContext, createPcmTap } from "../src/audio/context";
import { BUILTIN_TRACK_SPECS, synthesizeStudioTrack } from "../src/engine/synthTracks";

const SR = 48000;
const BPM = 124;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function rig() {
  const ctx = createHeadlessContext({ sampleRate: SR });
  const mixer = new Mixer(ctx);
  const track = (i: number, sec = 20) =>
    synthesizeStudioTrack(ctx, { ...BUILTIN_TRACK_SPECS[i % BUILTIN_TRACK_SPECS.length], durationSec: sec } as never);
  mixer.loadBuffer(0, track(0), { bpm: BPM, firstBeat: 0 });
  mixer.loadBuffer(1, track(1), { bpm: 126, firstBeat: 0 });

  // Master-bus probe: peak of everything rendered since the last reset.
  let peak = 0;
  const tap = createPcmTap(ctx as unknown as AudioContext, {
    bufferSize: 2048,
    onChunk: ({ channels }) => {
      for (const v of channels[0]) peak = Math.max(peak, Math.abs(v));
    },
  });
  (mixer as unknown as { masterLimiter: AudioNode }).masterLimiter.connect(tap.node);
  tap.node.connect(ctx.destination);

  return {
    ctx,
    mixer,
    probe: { reset: () => void (peak = 0), get peak() { return peak; } },
    close: () => { tap.stop(); void ctx.close(); },
  };
}

describe("console contract: transport", () => {
  test("load reports the analysis it was given; play starts deck A with sound", async () => {
    const r = rig();
    expect(r.mixer.decks[0].analysis?.bpm).toBe(BPM);
    expect(r.mixer.info()).toBeNull(); // nothing playing yet
    expect(r.mixer.play()).toBe(true);
    r.probe.reset();
    await sleep(600);
    const info = r.mixer.info();
    expect(info).not.toBeNull();
    expect(info!.deck).toBe(0);
    expect(info!.effBpm).toBeCloseTo(BPM, 1);
    expect(info!.elapsed).toBeGreaterThan(0.2);
    expect(r.probe.peak).toBeGreaterThan(0.01); // audio actually reaches the master
    r.close();
  }, 20000);

  test("pause stops playback and the master goes quiet", async () => {
    const r = rig();
    r.mixer.play();
    await sleep(300);
    r.mixer.pause();
    await sleep(400); // let the release ramp finish
    r.probe.reset();
    await sleep(400);
    expect(r.mixer.info()).toBeNull();
    expect(r.probe.peak).toBeLessThan(0.01);
    r.close();
  }, 20000);

  test("toggleDeckPlay starts and stops one deck independently", async () => {
    const r = rig();
    const on = r.mixer.toggleDeckPlay(1);
    expect(on).toBe(true);
    expect(r.mixer.decks[1].playing).toBe(true);
    const off = r.mixer.toggleDeckPlay(1);
    expect(off).toBe(false);
    expect(r.mixer.decks[1].playing).toBe(false);
    r.close();
  }, 20000);
});

describe("console contract: per-deck controls", () => {
  test("pitch: returns the resulting BPM, sets the deck rate, clamps to the fader range", () => {
    const r = rig();
    // Returns BPM, not percent. It does NOT write deck.pitchPct - the UI must
    // keep its own slider value.
    expect(r.mixer.setDeckPitchPct(0, 4)).toBeCloseTo(BPM * 1.04, 2);
    expect(r.mixer.decks[0].rate).toBeCloseTo(1.04, 5);
    const range = r.mixer.pitchFaderRange;
    expect(r.mixer.setDeckPitchPct(0, 1000)).toBeCloseTo(BPM * (1 + range / 100), 2);
    r.close();
  });

  test("key lock and key shift are stored flags only: nothing in the audio path reads them", () => {
    const r = rig();
    const first = r.mixer.toggleDeckKeyLock(0);
    expect(r.mixer.toggleDeckKeyLock(0)).toBe(!first);
    expect(r.mixer.nudgeDeckKey(0, 2)).toBe(2);
    expect(r.mixer.nudgeDeckKey(0, -1)).toBe(1);
    r.mixer.resetDeckKey(0);
    expect(r.mixer.decks[0].pitchShiftSemitones).toBe(0);
    r.close();
  });

  test("loops: set, halve, double, off", () => {
    const r = rig();
    const d = r.mixer.decks[0];
    d.setLoop(1, true);
    expect(d.loopBars).toBe(1);
    d.halveLoop();
    expect(d.loopBars).toBe(0.5);
    d.doubleLoop();
    d.doubleLoop();
    expect(d.loopBars).toBe(2);
    d.setLoop(0, true);
    expect(d.loopBars).toBe(0);
    r.close();
  });

  test("EQ kill toggles on then off", () => {
    const r = rig();
    const d = r.mixer.decks[0];
    expect(d.toggleEqKill("low")).toBe(true);
    expect(d.toggleEqKill("low")).toBe(false);
    r.close();
  });

  test("hot cue stores the playhead; beat jump moves it by whole beats", async () => {
    const r = rig();
    r.mixer.play();
    await sleep(500);
    const cue = r.mixer.setHotCue(0, "drop");
    expect(cue).not.toBeNull();
    expect(cue!).toBeGreaterThan(0.2);
    // Measure the landing point, not the return value: beatJump returns the
    // offset read before the re-seek takes effect, so it under-reports the
    // jump by the seek's scheduling lead. The UI must read the playhead instead.
    const t0 = r.ctx.currentTime;
    const before = r.mixer.decks[0].currentOffset();
    r.mixer.beatJump(0, 4);
    await sleep(500);
    const landed = r.mixer.decks[0].currentOffset() - (r.ctx.currentTime - t0);
    // 4 beats at 124 BPM = 1.935 s.
    expect(landed - before).toBeGreaterThan(1.8);
    expect(landed - before).toBeLessThan(2.1);
    r.close();
  }, 20000);
});

describe("console contract: crossfader law", () => {
  test("position runs -1 (A) .. +1 (B); default curve is equal-power", () => {
    const r = rig();
    const [a0, b0] = r.mixer.computeCrossfaderGains(-1);
    const [a1, b1] = r.mixer.computeCrossfaderGains(1);
    const [am, bm] = r.mixer.computeCrossfaderGains(0);
    expect(am * am + bm * bm).toBeCloseTo(1, 5); // equal power at centre
    expect(a0).toBeGreaterThan(0.95);
    expect(b0).toBeLessThan(0.05);
    expect(a1).toBeLessThan(0.05);
    expect(b1).toBeGreaterThan(0.95);
    expect(am).toBeGreaterThan(0.3);
    expect(bm).toBeGreaterThan(0.3);
    expect(Math.abs(am - bm)).toBeLessThan(0.01);
    r.close();
  });
});

describe("console contract: manual mixing (new console)", () => {
  test("play leaves the crossfader where the DJ put it", () => {
    const r = rig();
    r.mixer.manualMix = true;
    r.mixer.setCrossfader(0);
    r.mixer.toggleDeckPlay(0);
    expect(r.mixer.crossfader).toBe(0);
    r.close();
  });

  test("moving the crossfader toward a paused deck does not start it", async () => {
    const r = rig();
    r.mixer.manualMix = true;
    r.mixer.setCrossfader(-1);
    r.mixer.toggleDeckPlay(0);
    await sleep(100);
    r.mixer.setCrossfader(1);
    expect(r.mixer.decks[1].playing).toBe(false);
    r.close();
  }, 20000);

  test("without manual mixing the autopilot behaviour is unchanged", async () => {
    const r = rig();
    r.mixer.toggleDeckPlay(0);
    expect(r.mixer.crossfader).toBe(-1);
    await sleep(100);
    r.mixer.setCrossfader(1);
    expect(r.mixer.decks[1].playing).toBe(true);
    r.close();
  }, 20000);

  test("both decks play and both reach the master at a centred crossfader", async () => {
    const r = rig();
    r.mixer.manualMix = true;
    r.mixer.setCrossfader(0);
    r.mixer.toggleDeckPlay(0);
    r.mixer.toggleDeckPlay(1);
    await sleep(700);
    expect(r.mixer.decks[0].playing && r.mixer.decks[1].playing).toBe(true);
    expect(r.mixer.decks[0].getLevel()).toBeGreaterThan(0.01);
    expect(r.mixer.decks[1].getLevel()).toBeGreaterThan(0.01);
    r.close();
  }, 20000);
});

describe("console contract: effective key is the key heard", () => {
  test("no detected key reads empty, not a made-up 8A", () => {
    const r = rig();
    expect(r.mixer.decks[0].analysis?.key).toBeUndefined();
    expect(r.mixer.decks[0].getEffectiveKey()).toBe("");
    r.close();
  });

  test("a rate change shifts the reported key, because the audio pitch moves with it", () => {
    const r = rig();
    const d = r.mixer.decks[0];
    d.analysis!.key = "8A";
    expect(d.getEffectiveKey()).toBe("8A");
    d.setRate(Math.pow(2, 1 / 12)); // +1 semitone of speed
    expect(d.getEffectiveKey()).toBe("3A");
    r.close();
  });
});
