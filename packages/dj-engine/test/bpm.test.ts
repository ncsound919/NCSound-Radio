/**
 * BPM and first-beat regression test against the generated test library.
 *
 * The library must be built first:
 *   sh infra/make-test-library.sh
 *
 * Ground truth is the tempo baked into each file by the generator. This asserts
 * the FULL analyze() output, including the fitBeats refinement that runs after
 * the coarse tempogram, because the coarse estimate alone can look fine while
 * the refinement drags the reported BPM away.
 */
import { describe, test, expect } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { OfflineAudioContext } from "node-web-audio-api";
import { analyze } from "../src/engine/analysis";

const LIB = join(import.meta.dir, "..", "..", "..", "library");

const TRUTH: Array<[string, number]> = [
  ["01. Deepwater - Undertow.wav", 124],
  ["02. Static Field - Half Light.wav", 126],
  ["03. Marlow - Nightshift.wav", 120],
  ["04. Kestrel - Blue Channel.wav", 128],
  ["05. Pale Harbor - Slack Water.wav", 122],
  ["06. Ashgrove - Tidewater.wav", 130],
  ["07. Longshore - Fathom.wav", 118],
  ["08. Rivergate - Slow Water.wav", 132],
];

// Under 0.5% of tempo. Beatmatching only needs to know what to align to.
const TOLERANCE_PCT = 0.005;

function readWavMono(path: string, seconds: number): Float32Array {
  const b = readFileSync(path);
  let off = 12;
  let dataOff = -1;
  let dataLen = 0;
  while (off + 8 <= b.length) {
    const id = b.toString("ascii", off, off + 4);
    const size = b.readUInt32LE(off + 4);
    if (id === "data") {
      dataOff = off + 8;
      dataLen = size;
      break;
    }
    off += 8 + size + (size % 2);
  }
  const n = Math.min(Math.floor(dataLen / 4), Math.floor(seconds * 48000));
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = (b.readInt16LE(dataOff + i * 4) + b.readInt16LE(dataOff + i * 4 + 2)) / 65536;
  }
  return out;
}

describe.skipIf(!existsSync(LIB))("bpm detection", () => {
  const ctx = new OfflineAudioContext(1, 128, 48000);

  for (const [name, truth] of TRUTH) {
    test(`${name} reads ${truth} bpm`, () => {
      const mono = readWavMono(join(LIB, name), 60);
      const buf = ctx.createBuffer(1, mono.length, 48000);
      buf.getChannelData(0).set(mono);

      const { bpm, firstBeat } = analyze(buf);

      expect(Math.abs(bpm - truth) / truth).toBeLessThan(TOLERANCE_PCT);
      // The first beat must land inside the first bar of a 4/4 file.
      expect(firstBeat).toBeGreaterThanOrEqual(0);
      expect(firstBeat).toBeLessThan(4 * (60 / truth));
    });
  }

  test("mean error across the library stays under 0.5%", () => {
    let sum = 0;
    for (const [name, truth] of TRUTH) {
      const mono = readWavMono(join(LIB, name), 60);
      const buf = ctx.createBuffer(1, mono.length, 48000);
      buf.getChannelData(0).set(mono);
      sum += Math.abs(analyze(buf).bpm - truth) / truth;
    }
    expect(sum / TRUTH.length).toBeLessThan(TOLERANCE_PCT);
  });
});
