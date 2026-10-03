/**
 * Publishes rendered PCM into Liquidsoap's input.harbor endpoint.
 *
 * Liquidsoap exposes harbor as an Icecast-compatible HTTP source listener
 * (infra/liquidsoap/ncsound.liq). We authenticate as source "engine" and hold a
 * streaming request open, enqueueing interleaved s16le PCM as it is produced.
 *
 * The upload body must be a ReadableStream passed as `body` with
 * `duplex: "half"` — writing to `response.body` instead silently discards
 * everything (it is the server's reply, not our upload) while local counters
 * still increment, which looks like success right up until the listener plays
 * the fallback source instead.
 */

/**
 * Streaming WAV header.
 *
 * Liquidsoap's harbor cannot decode raw `audio/L16` — it answers
 * `Harbor.Make(T).Unknown_codec` and silently keeps playing the fallback
 * source. It does accept `audio/wav`, which it routes through ffmpeg. Sizes
 * are written as 0xFFFFFFFF, the convention for a stream of unknown length.
 */
function wavHeader(sampleRate: number, channels: number): Uint8Array {
  const bitsPerSample = 16;
  const byteRate = (sampleRate * channels * bitsPerSample) / 8;
  const blockAlign = (channels * bitsPerSample) / 8;
  const buf = new ArrayBuffer(44);
  const v = new DataView(buf);
  const ascii = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(offset + i, s.charCodeAt(i));
  };
  ascii(0, "RIFF");
  v.setUint32(4, 0xffffffff, true); // riff size: streaming
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  v.setUint32(16, 16, true); // fmt chunk size
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, channels, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, byteRate, true);
  v.setUint16(32, blockAlign, true);
  v.setUint16(34, bitsPerSample, true);
  ascii(36, "data");
  v.setUint32(40, 0xffffffff, true); // data size: streaming
  return new Uint8Array(buf);
}

export type HarborOptions = {
  host?: string;
  port?: number;
  mount?: string;
  user?: string;
  password?: string;
  channels?: number;
  sampleRate?: number;
  /** Title reported to listeners; fixed for the life of the connection. */
  streamTitle?: string;
};

export type HarborState = {
  connected: boolean;
  bytesSent: number;
  framesSent: number;
  lastError: string | null;
  connectedAt: string | null;
  /** Set once the server has closed the upload (rejected or ended). */
  endedByServer: boolean;
};

export class HarborPublisher {
  private readonly opts: Required<Omit<HarborOptions, "streamTitle">>;
  private readonly streamTitle: string;
  private controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  private state: HarborState = {
    connected: false,
    bytesSent: 0,
    framesSent: 0,
    lastError: null,
    connectedAt: null,
    endedByServer: false,
  };

  constructor(opts: HarborOptions = {}) {
    this.opts = {
      host: opts.host ?? "127.0.0.1",
      port: opts.port ?? 8008,
      mount: opts.mount ?? "dj",
      user: opts.user ?? "engine",
      password: opts.password ?? "REDACTED",
      channels: opts.channels ?? 2,
      sampleRate: opts.sampleRate ?? 48000,
    };
    this.streamTitle = opts.streamTitle ?? "NCSound Radio";
  }

  get status(): HarborState {
    return { ...this.state };
  }

  get title(): string {
    return this.streamTitle;
  }

  /**
   * Open the streaming upload. The returned promise resolves when the server
   * has accepted the connection, which for harbor means it has registered a
   * source. Blocks until it starts buffering.
   */
  async connect(signal?: AbortSignal, title?: string): Promise<void> {
    const { host, port, mount, user, password, channels, sampleRate } = this.opts;
    const auth = Buffer.from(`${user}:${password}`).toString("base64");
    const url = `http://${host}:${port}/${mount.replace(/^\//, "")}`;
    const streamTitle = title ?? this.streamTitle;

    this.state.lastError = null;
    this.state.endedByServer = false;

    const body = new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.controller = controller;
      },
      cancel: () => {
        this.state.endedByServer = true;
      },
    });

    try {
      const res = await fetch(url, {
        method: "POST",
        body,
        // @ts-expect-error duplex is required by undici for streaming bodies
        duplex: "half",
        headers: {
          Authorization: `Basic ${auth}`,
          "Content-Type": "audio/wav",
          "Icy-MetaData": "1",
          "icy-metaint": "16000",
          "icy-name": streamTitle,
        },
        signal,
      });

      if (!res.ok) {
        throw new Error(`harbor responded ${res.status} ${res.statusText}`);
      }

      // Streaming WAV: one header, then bare frames.
      this.controller?.enqueue(wavHeader(sampleRate, channels));

      this.state.connected = true;
      this.state.connectedAt = new Date().toISOString();
      this.state.bytesSent = 0;
      this.state.framesSent = 0;
    } catch (err) {
      this.state.connected = false;
      this.state.lastError = err instanceof Error ? err.message : String(err);
      this.controller = null;
      throw err;
    }
  }

  /** Enqueue one PCM chunk. Interleaves and converts to s16le first. */
  write(
    channels: Float32Array[],
    frames: number,
    interleave: (c: Float32Array[], f: number) => Int16Array,
  ): boolean {
    if (!this.controller || !this.state.connected) return false;
    try {
      const pcm = interleave(channels, frames);
      this.controller.enqueue(new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength));
      this.state.bytesSent += pcm.byteLength;
      this.state.framesSent += frames;
      return true;
    } catch (err) {
      this.state.lastError = err instanceof Error ? err.message : String(err);
      this.disconnect();
      return false;
    }
  }

  disconnect(): void {
    try {
      this.controller?.close();
    } catch {
      /* already closed or errored */
    }
    this.controller = null;
    this.state.connected = false;
  }
}
