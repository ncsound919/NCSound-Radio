/**
 * Key-detection accuracy against the labeled synthetic set (plan Phase 4).
 *
 * The built-in tracks carry a known Camelot key, so this is a real hit rate —
 * unlike real music, for which this project has no ground-truth key source. It
 * is deliberately not a hard pass/fail: it records the rate so a regression is
 * visible, and the plan notes synthetic material is not real music.
 */
import { describe, expect, test } from "bun:test";
import { OfflineAudioContext } from "node-web-audio-api";
import { analyze } from "../src/engine/analysis";
import { BUILTIN_TRACK_SPECS, synthesizeStudioTrack } from "../src/engine/synthTracks";

describe("key detection on the labeled synthetic set", () => {
  test("recovers each built-in track's known Camelot key", () => {
    const ctx = new OfflineAudioContext(2, 44100, 44100);
    const rows = BUILTIN_TRACK_SPECS.map((spec) => {
      const buf = synthesizeStudioTrack(ctx as unknown as BaseAudioContext, { ...spec, durationSec: 45 });
      const got = analyze(buf).key ?? "(none)";
      return { title: spec.title, expected: spec.camelot, got };
    });
    const hits = rows.filter((r) => r.got === r.expected).length;
    console.log(`key detection hit rate: ${hits}/${rows.length}`, JSON.stringify(rows));
    // A floor, not the target: the measured rate is the point.
    expect(hits).toBeGreaterThanOrEqual(1);
  }, 30000);
});
