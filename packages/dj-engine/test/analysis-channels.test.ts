/**
 * The Worker path must produce the same analysis as the main thread.
 *
 * `analyzeChannels` is what the library's background indexer runs: a Worker has
 * no AudioBuffer, so it hands the analyser decoded `Float32Array` channels and a
 * sample rate. This proves that path exists, runs without an AudioBuffer, and
 * agrees with the AudioBuffer entry point sample-for-sample.
 */
import { describe, test, expect } from "bun:test";
import { analyze, analyzeChannels, extractWaveformAndCuesChannels } from "../src/engine/analysis";

const SR = 44100;

function clickTrack(bpm: number, first = 0.37, secs = 40): Float32Array {
  const d = new Float32Array(SR * secs);
  const p = 60 / bpm;
  const hit = (t: number, amp: number) => {
    const s = Math.round(t * SR);
    for (let k = 0; k < 400 && s + k < d.length; k++) d[s + k] += amp * Math.sin(k * 0.3) * Math.exp(-k / 80);
  };
  for (let t = first; t < secs - 0.1; t += p) hit(t, 1);
  return d;
}

describe("analyzeChannels (Worker entry point)", () => {
  test("matches analyze(AudioBuffer) exactly", () => {
    const channels = [clickTrack(124, 0.31)];
    const fromBuffer = analyze({ sampleRate: SR, getChannelData: () => channels[0] });
    const fromChannels = analyzeChannels(channels, SR);

    expect(fromChannels.bpm).toBe(fromBuffer.bpm);
    expect(fromChannels.firstBeat).toBe(fromBuffer.firstBeat);
    expect(fromChannels.key).toBe(fromBuffer.key);
    expect(fromChannels.keyName).toBe(fromBuffer.keyName);
    expect(fromChannels.cuePoints).toEqual(fromBuffer.cuePoints as never);
    expect(Array.from(fromChannels.waveform!.low)).toEqual(Array.from(fromBuffer.waveform!.low));
  });

  test("produces a valid in-range analysis from plain Float32Arrays", () => {
    const a = analyzeChannels([clickTrack(128)], SR);
    expect(a.bpm).toBeGreaterThan(60);
    expect(a.bpm).toBeLessThan(200);
    expect(Number.isFinite(a.firstBeat)).toBe(true);
    expect(a.firstBeat).toBeGreaterThanOrEqual(0);
    expect(a.key).toBeTruthy();
    expect(a.cuePoints).toBeTruthy();
    expect(a.waveform!.low.length).toBe(480);
    const c = a.cuePoints!;
    expect(c.intro).toBeLessThanOrEqual(c.drop);
    expect(c.drop).toBeLessThanOrEqual(c.breakdown);
    expect(c.breakdown).toBeLessThanOrEqual(c.outro);
  });

  test("extractWaveformAndCuesChannels returns the 3-band waveform", () => {
    const out = extractWaveformAndCuesChannels([clickTrack(126)], SR, 126, 0.2);
    expect(out.waveform.low.length).toBe(480);
    expect(out.waveform.energyCurve.length).toBe(480);
    expect(Number.isFinite(out.rmsDb)).toBe(true);
  });

  test("refuses an empty channel list rather than inventing a source", () => {
    expect(() => analyzeChannels([], SR)).toThrow();
  });
});
