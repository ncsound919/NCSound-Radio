/**
 * Regression tests for the sequencing-state fixes.
 *
 * Each of these was a defect that produced silence, a frozen fader, or a wrong
 * number, with no log line pointing at it. They assert on the state that was
 * wrong rather than on the log that was missing.
 */

import { describe, expect, test } from "bun:test";
import { Mixer } from "../src/engine/mixer";
import { createHeadlessContext } from "../src/audio/context";
import { BUILTIN_TRACK_SPECS, synthesizeStudioTrack } from "../src/engine/synthTracks";
import { Autopilot } from "../src/ingest/autopilot";
import { runTransition } from "../src/engine/transitions";
import type { DecodedTrack } from "../src/ingest/decode";
import type { TransitionPreset } from "../src/engine/types";

const SR = 48000;
const AUTO: TransitionPreset = { id: "auto", name: "Auto", bars: 4, curve: "equal-power" };

function shortTrack(ctx: BaseAudioContext, index: number, durationSec: number) {
  const spec = { ...BUILTIN_TRACK_SPECS[index % BUILTIN_TRACK_SPECS.length], durationSec };
  return synthesizeStudioTrack(ctx, spec as never);
}

/** A crate entry that is already materialised, so no ffmpeg round trip is needed. */
function crateEntry(
  ctx: BaseAudioContext,
  index: number,
  durationSec: number,
  bpm: number,
  title: string
): DecodedTrack {
  const buffer = shortTrack(ctx, index, durationSec);
  return {
    path: `mem://${title}`,
    id: title.toLowerCase().replace(/\s+/g, "-"),
    title,
    artist: "Test Artist",
    album: null,
    durationSec,
    sampleRate: buffer.sampleRate,
    channels: buffer.numberOfChannels,
    buffer,
    analysis: { bpm, firstBeat: 0.24, key: "8A", energy: 0.7 },
  };
}

describe("loadBuffer rejects an unusable analysis", () => {
  /**
   * `typeof 0 === "number"` and `typeof NaN === "number"`, so "the override has a
   * bpm" used to accept values that divide every timing computation to zero or
   * NaN. These are the values that made runTransition throw.
   */
  const bad: Array<[string, number]> = [
    ["zero", 0],
    ["negative", -120],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
  ];

  for (const [label, bpm] of bad) {
    test(`bpm=${label} falls back to a real analysis`, () => {
      const ctx = createHeadlessContext({ sampleRate: SR });
      const mixer = new Mixer(ctx);
      const buf = shortTrack(ctx, 0, 4);

      const analysis = mixer.loadBuffer(0, buf, { bpm, firstBeat: 0.24 });

      expect(Number.isFinite(analysis.bpm)).toBe(true);
      expect(analysis.bpm).toBeGreaterThan(0);
      expect(analysis.bpm).toBeGreaterThanOrEqual(60);
      expect(analysis.bpm).toBeLessThanOrEqual(200);
      void ctx.close();
    }, 60000);
  }

  test("a usable override is still honoured, not re-analysed away", () => {
    const ctx = createHeadlessContext({ sampleRate: SR });
    const mixer = new Mixer(ctx);
    const buf = shortTrack(ctx, 0, 4);

    const analysis = mixer.loadBuffer(0, buf, { bpm: 128, firstBeat: 1.5 });

    expect(analysis.bpm).toBe(128);
    expect(analysis.firstBeat).toBe(1.5);
    void ctx.close();
  }, 60000);
});

describe("runTransition survives an unusable tempo", () => {
  /**
   * This is the exact throw the handover path used to walk into: a non-finite
   * duration reaches setValueCurveAtTime, which rejects it, after the caller has
   * already muted the incoming deck.
   */
  test("a NaN bar length produces a finite end time instead of throwing", () => {
    const ctx = createHeadlessContext({ sampleRate: SR });
    const mixer = new Mixer(ctx);
    const a = shortTrack(ctx, 0, 6);
    const b = shortTrack(ctx, 1, 6);
    mixer.loadBuffer(0, a, { bpm: 124, firstBeat: 0.24 });
    mixer.loadBuffer(1, b, { bpm: 126, firstBeat: 0.24 });

    for (const bad of [Number.NaN, 0, Number.POSITIVE_INFINITY, -1]) {
      const end = runTransition(mixer.decks[0], mixer.decks[1], AUTO, 1, bad);
      expect(Number.isFinite(end)).toBe(true);
      expect(end).toBeGreaterThan(1);
    }
    void ctx.close();
  }, 60000);

  test("next() reports success and both decks stay schedulable", () => {
    const ctx = createHeadlessContext({ sampleRate: SR });
    const mixer = new Mixer(ctx);
    const a = shortTrack(ctx, 0, 6);
    const b = shortTrack(ctx, 1, 6);
    mixer.loadBuffer(0, a, { bpm: 124, firstBeat: 0.24 });
    mixer.loadBuffer(1, b, { bpm: 126, firstBeat: 0.24 });
    mixer.play();

    // Force the timing state a zero-bpm track would have produced.
    (mixer as unknown as { effBpm: number }).effBpm = 0;
    const res = mixer.next(AUTO);

    expect(res.ok ? true : res.reason).toBe(true);
    const last = mixer.handover[mixer.handover.length - 1];
    expect(last.outcome).toBe("ok");
    expect(last.scheduling?.toStarted).toBe(true);
    void ctx.close();
  }, 60000);
});

describe("the transition window reports what was scheduled", () => {
  test("is live during a handover and closed afterwards", async () => {
    const ctx = createHeadlessContext({ sampleRate: SR });
    const mixer = new Mixer(ctx);
    const a = shortTrack(ctx, 0, 30);
    const b = shortTrack(ctx, 1, 30);
    mixer.loadBuffer(0, a, { bpm: 124, firstBeat: 0.24 });
    mixer.loadBuffer(1, b, { bpm: 126, firstBeat: 0.24 });
    mixer.play();

    expect(mixer.transitionWindow()).toBeNull();

    const res = mixer.next(AUTO);
    expect(res.ok).toBe(true);

    const win = mixer.transitionWindow();
    expect(win).not.toBeNull();
    expect(win!.fromDeck).toBe(0);
    expect(win!.toDeck).toBe(1);
    expect(win!.endsAt).toBeGreaterThan(win!.fadeStart);
    expect(win!.progress).toBeGreaterThanOrEqual(0);
    expect(win!.progress).toBeLessThanOrEqual(1);

    // Wait it out, then the window must close on its own.
    while (mixer.busy) await new Promise((r) => setTimeout(r, 50));
    expect(mixer.transitionWindow()).toBeNull();
    void ctx.close();
  }, 60000);

  test("a pause abandons the window instead of stranding it", () => {
    const ctx = createHeadlessContext({ sampleRate: SR });
    const mixer = new Mixer(ctx);
    const a = shortTrack(ctx, 0, 30);
    const b = shortTrack(ctx, 1, 30);
    mixer.loadBuffer(0, a, { bpm: 124, firstBeat: 0.24 });
    mixer.loadBuffer(1, b, { bpm: 126, firstBeat: 0.24 });
    mixer.play();
    expect(mixer.next(AUTO).ok).toBe(true);
    expect(mixer.busy).toBe(true);

    mixer.pause();

    // Otherwise `busy` stays true, applyFaderGains() returns early forever, and
    // the channel faders are frozen at whatever the transition left them.
    expect(mixer.busy).toBe(false);
    expect(mixer.transitionWindow()).toBeNull();
    void ctx.close();
  }, 60000);
});

describe("info() reads state without changing it", () => {
  test("the crossfader field is untouched by a read", () => {
    const ctx = createHeadlessContext({ sampleRate: SR });
    const mixer = new Mixer(ctx);
    const a = shortTrack(ctx, 0, 20);
    mixer.loadBuffer(0, a, { bpm: 124, firstBeat: 0.24 });
    mixer.play();

    const before = mixer.crossfader;
    for (let i = 0; i < 5; i++) mixer.info();
    expect(mixer.crossfader).toBe(before);
    void ctx.close();
  }, 60000);
});

describe("autopilot restart and recovery", () => {
  test("start() re-enables an autopilot that was stopped", async () => {
    const ctx = createHeadlessContext({ sampleRate: SR });
    const mixer = new Mixer(ctx);
    const track = crateEntry(ctx, 0, 20, 124, "First Track");

    const autopilot = new Autopilot(mixer);
    autopilot.setCrate([track]);

    expect(await autopilot.start(track)).toBe(true);
    autopilot.stop();
    expect(autopilot.enabled).toBe(false);

    mixer.pause();
    // start() used to leave `enabled` false, so tick() returned immediately on
    // every one of its one-second calls and the station never sequenced again.
    expect(await autopilot.start(track)).toBe(true);
    expect(autopilot.enabled).toBe(true);

    autopilot.tick();
    autopilot.stop();
    void ctx.close();
  }, 60000);

  test("recovery rewinds the track it means to play, not the stale deck 0 buffer", async () => {
    const ctx = createHeadlessContext({ sampleRate: SR });
    const mixer = new Mixer(ctx);
    const a = crateEntry(ctx, 0, 20, 124, "Alpha");
    const b = crateEntry(ctx, 1, 20, 126, "Beta");

    const autopilot = new Autopilot(mixer);
    autopilot.setCrate([a, b]);
    expect(await autopilot.start(a)).toBe(true);

    // Run a real handover through autopilot, so autopilot's own belief about the
    // current track advances with the mixer.
    mixer.decks[0].seek(19);
    autopilot.tick();
    await new Promise((r) => setTimeout(r, 100));
    autopilot.tick();

    expect(mixer.active).toBe(1);
    expect(autopilot.nowPlaying?.track.title).toBe("Beta");
    expect(mixer.decks[0].buffer).toBe(a.buffer as AudioBuffer);
    expect(mixer.decks[1].buffer).toBe(b.buffer as AudioBuffer);

    // Put the live track mid-playback, then take the mixer off air without
    // touching autopilot's state: that is what an unexpected pause looks like
    // from the sequencer.
    mixer.decks[1].seek(5);
    mixer.pause();
    autopilot.tick();

    expect(mixer.playing).toBe(true);
    expect(mixer.active).toBe(1);
    expect(mixer.decks[1].buffer).toBe(b.buffer as AudioBuffer);
    expect(mixer.info()?.deck).toBe(1);
    /**
     * The distinguishing assertion. Recovery rewound deck 0 - which holds the
     * finished Alpha - and then called mixer.play(), which resumed Beta from
     * wherever it had got to. So the station came back mid-track having logged
     * "restarted deck 0". Recovery must rewind the deck holding the track it
     * believes is playing.
     */
    expect(mixer.info()!.elapsed).toBeLessThan(1.5);

    autopilot.stop();
    void ctx.close();
  }, 60000);
});