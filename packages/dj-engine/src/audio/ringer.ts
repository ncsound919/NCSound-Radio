import { createPcmTap, createHeadlessContext, measureChunk, resumeContext } from "./context";

/** Interleave planar channels into s16le PCM, the shape Liquidsoap's harbor wants. */
export function interleaveToInt16(channels: Float32Array[], frames: number): Int16Array {
  const n = channels.length;
  const out = new Int16Array(frames * n);
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < n; c++) {
      const ch = channels[c];
      const s = i < ch.length ? Math.max(-1, Math.min(1, ch[i])) : 0;
      out[i * n + c] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
  }
  return out;
}

export type RingerOptions = {
  sampleRate?: number;
  bufferSize?: number;
  onFrames?: (info: { frames: number; peak: number; rms: number }) => void;
  /** Receives the raw rendered samples, for publishing downstream. */
  onChunk?: (info: { channels: Float32Array[]; frames: number; contextTime: number }) => void;
};

/**
 * Drives the engine's master output and reports every rendered frame.
 *
 * The tap is spliced between the mixer's master limiter and the (absent)
 * destination, so what it sees is exactly what would hit the PA.
 */
export class MasterRinger {
  private readonly ctx;
  private readonly tap;
  private source: AudioNode | null = null;
  private running = false;
  private totalFrames = 0;
  private lastBlockAtMs = 0;

  constructor(opts: RingerOptions = {}) {
    this.ctx = createHeadlessContext({
      sampleRate: opts.sampleRate,
      latencyHint: "playback",
    });
    this.tap = createPcmTap(this.ctx, {
      bufferSize: opts.bufferSize,
      onChunk: ({ channels, frames, contextTime }) => {
        this.totalFrames += frames;
        this.lastBlockAtMs = performance.now();
        if (opts.onFrames) {
          const m = measureChunk(channels);
          opts.onFrames({ frames, peak: m.peak, rms: m.rms });
        }
        opts.onChunk?.({ channels, frames, contextTime });
      },
    });
  }

  get context(): AudioContext {
    return this.ctx;
  }

  get framesRendered(): number {
    return this.totalFrames;
  }

  get isRunning(): boolean {
    return this.running;
  }

  /** The ScriptProcessor node, so a caller can register it as a durable tap. */
  get tapNode(): AudioNode {
    return this.tap.node;
  }

  /**
   * Re-attach the tap to the master bus.
   *
   * `AudioNode.disconnect()` removes every outgoing connection of a node,
   * including ones made from outside the mixer. Anything that re-routes the
   * master bus therefore silently detaches this tap, and the consequence is
   * severe and quiet: `onaudioprocess` stops firing, `onChunk` stops publishing,
   * harbor receives nothing, and the station goes silent while every status field
   * still reports a playing engine.
   *
   * Recovery from that is to put the connection back, which is what this does.
   */
  reattach(from: AudioNode): void {
    this.source = from;
    try {
      from.connect(this.tap.node);
    } catch {
      /* already connected */
    }
    // The ScriptProcessor only runs while something pulls its output.
    try {
      this.tap.node.connect(this.ctx.destination);
    } catch {
      /* already connected */
    }
  }

  /** True when this tap has seen a block recently enough to be publishing. */
  get lastBlockAgeMs(): number {
    return this.lastBlockAtMs === 0 ? Infinity : performance.now() - this.lastBlockAtMs;
  }

  async start(from: AudioNode): Promise<void> {
    await resumeContext(this.ctx);
    this.source = from;
    from.connect(this.tap.node);
    // ScriptProcessor only fires while its output is pulled, so give it a sink.
    this.tap.node.connect(this.ctx.destination);
    this.running = true;
  }

  stop(): void {
    this.tap.stop();
    try {
      this.source?.disconnect();
    } catch {
      /* already detached */
    }
    this.running = false;
  }

  async close(): Promise<void> {
    this.stop();
    try {
      await (this.ctx as unknown as { close(): Promise<void> }).close();
    } catch {
      /* nothing to close */
    }
  }
}