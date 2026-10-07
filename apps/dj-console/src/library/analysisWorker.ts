/**
 * The library's analysis Worker (plan 4.1).
 *
 * Decoding stays on the main thread (`decodeAudioData` is async and decodes
 * off-thread internally). The decoded channel data is copied and transferred
 * here, where `analyze()` and `computeWaveform()` run off the main thread, so a
 * 300-track folder index never blocks a frame.
 */
/// <reference lib="webworker" />
import { analyzeChannels } from "@ncsound/dj-engine/analysis";
import { computeWaveformChannels } from "../audio/waveform";
import type { AnalyzeRequest, AnalyzeResponse } from "./types";

type WorkerScope = {
  onmessage: ((ev: MessageEvent<AnalyzeRequest>) => void) | null;
  postMessage(message: AnalyzeResponse, transfer?: Transferable[]): void;
};

const ctx = self as unknown as WorkerScope;

function transferables(arrays: Array<Float32Array | undefined>): Transferable[] {
  const out: Transferable[] = [];
  for (const a of arrays) if (a) out.push(a.buffer);
  return out;
}

ctx.onmessage = (ev) => {
  const { id, channels, sampleRate } = ev.data;
  try {
    const analysis = analyzeChannels(channels, sampleRate);
    const waveform = computeWaveformChannels(channels, sampleRate);
    const bands = analysis.waveform;
    ctx.postMessage(
      { id, analysis, waveform },
      transferables([
        bands?.low,
        bands?.mid,
        bands?.high,
        bands?.peaks,
        bands?.energyCurve,
        waveform.body,
        waveform.mid,
        waveform.high,
        waveform.peak,
      ]),
    );
  } catch (e) {
    ctx.postMessage({ id, error: e instanceof Error ? e.message : String(e) });
  }
};
