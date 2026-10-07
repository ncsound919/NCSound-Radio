/**
 * Main-thread wrapper around the analysis Worker.
 *
 * One Worker is created lazily and reused. `analyze()` transfers the channel
 * data in (they are copies, so the caller's AudioBuffer is untouched) and
 * resolves with the analysis + waveform back. If `Worker` is unavailable, the
 * caller uses `analyzeChannelsInline` instead, which runs the same code on the
 * main thread.
 */
import { analyzeChannels } from "@ncsound/dj-engine/analysis";
import { computeWaveformChannels, type DeckWaveform } from "../audio/waveform";
import type { TrackAnalysis } from "@ncsound/dj-engine/engine/types";
import type { AnalyzeRequest, AnalyzeResponse } from "./types";

export type AnalyzeResult = { analysis: TrackAnalysis; waveform: DeckWaveform };

/** The same work without a Worker, for environments that have none. */
export function analyzeChannelsInline(channels: Float32Array[], sampleRate: number): AnalyzeResult {
  return {
    analysis: analyzeChannels(channels, sampleRate),
    waveform: computeWaveformChannels(channels, sampleRate),
  };
}

export class AnalysisRunner {
  private worker: Worker | null = null;
  private pending = new Map<string, { resolve: (r: AnalyzeResult) => void; reject: (e: Error) => void }>();
  private seq = 0;

  get supported(): boolean {
    return typeof Worker !== "undefined";
  }

  private ensure(): Worker {
    if (!this.worker) {
      this.worker = new Worker(new URL("./analysisWorker.ts", import.meta.url), { type: "module" });
      this.worker.onmessage = (ev: MessageEvent<AnalyzeResponse>) => this.onMessage(ev.data);
      this.worker.onerror = (ev) => this.rejectAll(new Error(ev.message || "analysis worker crashed"));
    }
    return this.worker;
  }

  analyze(channels: Float32Array[], sampleRate: number): Promise<AnalyzeResult> {
    return new Promise((resolve, reject) => {
      const id = `a${++this.seq}`;
      this.pending.set(id, { resolve, reject });
      const msg: AnalyzeRequest = { id, channels, sampleRate };
      try {
        // Channel copies are owned by us and not needed again, so transfer them.
        this.ensure().postMessage(msg, channels.map((c) => c.buffer));
      } catch (e) {
        this.pending.delete(id);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  private onMessage(msg: AnalyzeResponse): void {
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    if ("error" in msg) p.reject(new Error(msg.error));
    else p.resolve({ analysis: msg.analysis, waveform: msg.waveform });
  }

  private rejectAll(err: Error): void {
    for (const [, p] of this.pending) p.reject(err);
    this.pending.clear();
    this.worker?.terminate();
    this.worker = null;
  }

  terminate(): void {
    // Reject in-flight work rather than clearing the map: a cleared map leaves
    // the caller's promise pending forever.
    for (const [, p] of this.pending) p.reject(new Error("analysis worker terminated"));
    this.pending.clear();
    this.worker?.terminate();
    this.worker = null;
  }
}
