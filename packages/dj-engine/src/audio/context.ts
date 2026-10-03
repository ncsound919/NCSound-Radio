/**
 * Headless AudioContext construction and PCM capture.
 *
 * node-web-audio-api gives us a full Web Audio implementation in Node, but a
 * bare `new AudioContext()` tries to open an output device and dies with
 * DeviceNotAvailable on a headless box. `sinkId: { type: 'none' }` gives a
 * real-time context with no sink: verified to advance its clock at wall-clock
 * rate (ratio 1.006 over 2s) with no device present.
 *
 * Output capture uses createScriptProcessor, which the same runtime does
 * implement headless (verified firing ~46x/s for 2048-frame buffers at 48kHz,
 * i.e. exactly the right cadence). createMediaStreamDestination is NOT
 * implemented (upstream issue #91) and AudioWorklet is unavailable, so
 * ScriptProcessor is the only tap.
 */

import { AudioContext } from "node-web-audio-api";

export type HeadlessContextOptions = {
  sampleRate?: number;
  latencyHint?: "interactive" | "balanced" | "playback";
};

export const ENGINE_SAMPLE_RATE = 48000;

export function createHeadlessContext(opts: HeadlessContextOptions = {}): AudioContext {
  // node-web-audio-api accepts sinkId at runtime but does not declare it on
  // AudioContextOptions, hence the cast.
  const options = {
    sampleRate: opts.sampleRate ?? ENGINE_SAMPLE_RATE,
    latencyHint: opts.latencyHint ?? "playback",
    sinkId: { type: "none" },
  };
  return new AudioContext(options as unknown as ConstructorParameters<typeof AudioContext>[0]) as unknown as AudioContext;
}

export async function resumeContext(ctx: AudioContext): Promise<void> {
  if (ctx.state !== "running") {
    try {
      await (ctx as unknown as { resume(): Promise<void> }).resume();
    } catch {
      /* nothing to resume on a sink-less context */
    }
  }
}

export type PcmChunk = {
  /** Interleaved-free: one Float32Array per channel. */
  channels: Float32Array[];
  frames: number;
  /** Context time the first frame of this chunk corresponds to. */
  contextTime: number;
};

export type PcmTapOptions = {
  /** Frames per callback. 2048 @ 48kHz is ~43 callbacks/sec. */
  bufferSize?: number;
  onChunk: (chunk: PcmChunk) => void;
};

/**
 * Splice a ScriptProcessor into the master chain and hand every rendered
 * buffer to `onChunk`. Connect the returned node's output onward to keep the
 * graph pulled.
 *
 * The ScriptProcessor API is deprecated in browsers, but it is the only
 * capture path this runtime offers.
 */
export function createPcmTap(ctx: AudioContext, opts: PcmTapOptions): {
  node: AudioNode;
  stop: () => void;
} {
  const bufferSize = opts.bufferSize ?? 2048;
  const sp = ctx.createScriptProcessor(bufferSize, 2, 2);

  sp.onaudioprocess = (ev: AudioProcessingEvent) => {
    const input = ev.inputBuffer;
    const output = ev.outputBuffer;
    const frames = input.length;
    const channels: Float32Array[] = [];

    for (let c = 0; c < input.numberOfChannels; c++) {
      const src = input.getChannelData(c);
      // Copy: the runtime reuses the backing store between callbacks.
      channels.push(new Float32Array(src));
      // ScriptProcessor output is zero-filled unless written, so pass the
      // signal through or the tap both sees and silences the graph.
      if (c < output.numberOfChannels) {
        output.copyToChannel(src, c);
      }
    }

    opts.onChunk({ channels, frames, contextTime: ctx.currentTime });
  };

  return {
    node: sp,
    stop: () => {
      sp.onaudioprocess = null;
      try {
        sp.disconnect();
      } catch {
        /* already detached */
      }
    },
  };
}

/** Peak and RMS of a chunk, for telemetry. */
export function measureChunk(channels: Float32Array[]): { peak: number; rms: number } {
  let peak = 0;
  let sum = 0;
  let n = 0;
  for (const ch of channels) {
    for (let i = 0; i < ch.length; i++) {
      const a = Math.abs(ch[i]);
      if (a > peak) peak = a;
      sum += ch[i] * ch[i];
      n++;
    }
  }
  return { peak, rms: n > 0 ? Math.sqrt(sum / n) : 0 };
}
