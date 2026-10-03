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

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/**
 * ICY interleaving.
 *
 * With `icy=true` the harbor expects the client to break the audio into
 * 255-byte blocks and follow each one with a length byte plus an optional
 * metadata block. That is how a track change reaches listeners on a connection
 * that is already open, which a request header cannot do.
 */
const ICY_BLOCK = 255;

function icyMetadata(title: string): Uint8Array {
  const payload = new TextEncoder().encode(`StreamTitle='${title.replace(/'/g, "")}';`);
  // One length byte holds multiples of 16.
  const blocks = Math.ceil(payload.length / 16);
  const len = Math.min(255, blocks * 16);
  const out = new Uint8Array(1 + len);
  out[0] = len;
  out.set(payload.subarray(0, len), 1);
  return out;
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
  /** How many times the upload has been re-established after a drop. */
  reconnects: number;
  /** Epoch ms of the next reconnect attempt, or null while connected. */
  nextRetryAtMs: number | null;
};

/** Reconnect backoff bounds. */
const RETRY_BASE_MS = 500;
const RETRY_MAX_MS = 15_000;

/**
 * Backlog thresholds for deciding the peer has stopped reading.
 *
 * Enqueueing into a ReadableStream never fails when the socket is gone - it
 * just buffers. So a dropped Liquidsoap source was invisible: connected stayed
 * true, bytesSent kept climbing, and the station was silent with nothing in the
 * status to say so. A backlog that will not drain is the only in-process signal
 * that the consumer is gone.
 */
const LINGER_BYTES = 512 * 1024;
const BACKLOG_DEAD_BYTES = -192 * 1024;
const BACKLOG_DEAD_MS = 3000;

export class HarborPublisher {
  private readonly opts: Required<Omit<HarborOptions, "streamTitle">>;
  private streamTitle: string;
  private controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  /** Carries sub-block-boundary bytes between writes; ICY blocks are 255 bytes. */
  private carry: Uint8Array = new Uint8Array(0);
  /** Title to re-send at the next ICY block boundary. */
  private pendingMetadata: Uint8Array | null = null;
  private state: HarborState = {
    connected: false,
    bytesSent: 0,
    framesSent: 0,
    lastError: null,
    connectedAt: null,
    endedByServer: false,
    reconnects: 0,
    nextRetryAtMs: null,
  };
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryDelayMs = RETRY_BASE_MS;
  /** Set by disconnect() so an intentional stop does not trigger a retry. */
  private closedByUs = false;
  /** Distinguishes a first connect from a recovery, for the reconnects count. */
  private hasConnectedOnce = false;
  /** When the outbound backlog first exceeded the dead threshold. */
  private backlogSince: number | null = null;
  /** Title to use on the next connect attempt. */
  private lastTitle: string;

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
    this.lastTitle = this.streamTitle;
  }

  get status(): HarborState {
    return { ...this.state };
  }

  get title(): string {
    return this.streamTitle;
  }

  /**
   * Update the local title only.
   *
   * The ICY title travels as a request header, so it cannot change on an
   * already-open upload. Mid-track updates go out over the Liquidsoap control
   * channel instead (see LiquidsoapControl).
   */
  setTitle(title: string): void {
    this.streamTitle = title;
    // Queue for the next block boundary so listeners pick it up live.
    this.pendingMetadata = icyMetadata(title);
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
    if (title) this.lastTitle = title;
    const streamTitle = title ?? this.streamTitle;

    this.state.lastError = null;
    this.state.endedByServer = false;

    const body = new ReadableStream<Uint8Array>(
      {
        start: (controller) => {
          this.controller = controller;
        },
        cancel: () => {
          // The consumer went away. Undetected, this left the publisher
          // enqueueing into a stream nobody was reading.
          this.state.endedByServer = true;
          this.teardown();
          this.scheduleRetry();
        },
      },
      {
        /**
         * Byte-accounted queuing so desiredSize is a real backlog measurement.
         * At 48 kHz stereo s16 this is roughly a second of audio, which is the
         * most lag a live stream should ever accumulate.
         */
        highWaterMark: LINGER_BYTES,
        size: (chunk) => chunk.byteLength,
      },
    );

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
      // Count this as a reconnect only if a previous connection existed, so the
      // number means "times we recovered" rather than "times we started".
      if (this.hasConnectedOnce) this.state.reconnects += 1;
      this.hasConnectedOnce = true;
      // A successful connect resets the backoff, so a transient blip costs one
      // retry rather than locking the station into 15-second attempts.
      this.retryDelayMs = RETRY_BASE_MS;
      this.state.nextRetryAtMs = null;
      this.closedByUs = false;
      this.backlogSince = null;
    } catch (err) {
      this.state.connected = false;
      this.state.lastError = err instanceof Error ? err.message : String(err);
      this.controller = null;
      this.scheduleRetry();
      throw err;
    }
  }

  /**
   * Re-open the upload after a drop, with exponential backoff.
   *
   * Without this, one closed socket ended the broadcast permanently: the engine
   * kept reporting "playing", Icecast kept its last buffered audio, and the
   * station went silent with nothing in the status to say so. A radio station
   * that cannot recover from a dropped ingest connection is not really on air.
   */
  private scheduleRetry(): void {
    if (this.closedByUs) return;
    if (this.retryTimer) return;
    const delay = this.retryDelayMs;
    this.retryDelayMs = Math.min(RETRY_MAX_MS, Math.floor(delay * 2));
    this.state.nextRetryAtMs = Date.now() + delay;

    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.connect(undefined, this.lastTitle).catch(() => {
        // connect() already scheduled the next attempt and recorded the error.
      });
    }, delay);
    // Never hold the process open just to retry.
    (this.retryTimer as unknown as { unref?: () => void }).unref?.();
  }

  /** Bytes actually delivered on the current connection. Frozen when dropped. */
  get bytesSent(): number {
    return this.state.bytesSent;
  }

  /** Enqueue one PCM chunk, framed as WAV then split into ICY blocks. */
  write(
    channels: Float32Array[],
    frames: number,
    interleave: (c: Float32Array[], f: number) => Int16Array,
  ): boolean {
    if (!this.controller || !this.state.connected) return false;
    try {
      /**
       * Liveness check before writing.
       *
       * If the backlog has been growing past the dead threshold for long
       * enough, nothing is reading this stream. Treat it as dropped and let the
       * backoff re-open it, rather than buffering audio into the void while
       * reporting a healthy connection.
       */
      const desired = this.controller.desiredSize;
      if (desired !== null && desired < BACKLOG_DEAD_BYTES) {
        const now = Date.now();
        this.backlogSince ??= now;
        if (now - this.backlogSince >= BACKLOG_DEAD_MS) {
          this.state.lastError =
            `no reader for ${Math.round((now - this.backlogSince) / 1000)}s ` +
            `(backlog ${Math.round(-desired / 1024)} KiB): treating the upload as dropped`;
          this.teardown();
          this.scheduleRetry();
          return false;
        }
      } else {
        this.backlogSince = null;
      }

      const pcm = interleave(channels, frames);
      const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
      this.state.bytesSent += bytes.length;
      this.state.framesSent += frames;

      // Prepend anything left over from the previous call.
      const input =
        this.carry.length > 0 ? concat(this.carry, bytes) : bytes;

      let offset = 0;
      while (input.length - offset >= ICY_BLOCK) {
        const block = input.subarray(offset, offset + ICY_BLOCK);
        offset += ICY_BLOCK;
        this.controller.enqueue(block);
        // Metadata rides in the first block after it changes.
        if (this.pendingMetadata) {
          this.controller.enqueue(this.pendingMetadata);
          this.pendingMetadata = null;
        } else {
          this.controller.enqueue(new Uint8Array([0]));
        }
      }
      this.carry = input.slice(offset);
      return true;
    } catch (err) {
      // The upload was closed underneath us - typically Liquidsoap dropping the
      // source. Record it, tear down, and let the backoff re-open it rather than
      // leaving the station silent.
      this.state.lastError = err instanceof Error ? err.message : String(err);
      this.teardown();
      this.scheduleRetry();
      return false;
    }
  }

  /** Close the current upload without arming a reconnect. */
  private teardown(): void {
    try {
      this.controller?.close();
    } catch {
      /* already closed or errored */
    }
    this.controller = null;
    this.state.connected = false;
  }

  /** Stop publishing for good. No reconnect will be attempted. */
  disconnect(): void {
    this.closedByUs = true;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.state.nextRetryAtMs = null;
    this.teardown();
  }
}
