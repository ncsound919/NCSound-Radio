import http from "node:http";

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
 * Declared length of the WAV data chunk, in bytes.
 *
 * This is finite on purpose. A streaming WAV conventionally writes 0xFFFFFFFF
 * here, and that is exactly what stopped the station ever reaching air:
 * Liquidsoap decodes harbor uploads through ffmpeg, whose WAV demuxer will not
 * emit frames from a chunk claiming to be unbounded. Harbor sat at "need more
 * buffering" gaining about 700 bytes a second against 192 KB/s being sent, so it
 * never finished its startup buffer, the switch never selected it, and
 * listeners got the dead-air fallback tone while every counter looked healthy.
 *
 * Verified by sending the same audio with finite sizes: harbor played all 20
 * seconds of it.
 *
 * 0x7FFFFFFF is a little over 2 GB, roughly three hours of 48 kHz stereo s16.
 * The publisher re-sends a fresh header before reaching it (see
 * WAV_RECONNECT_MARGIN), so a permanent stream is unaffected.
 */
const WAV_DATA_LIMIT = 0x7fffffff;

/** Start a fresh WAV a little before the declared length is reached. */
const WAV_RECONNECT_MARGIN = 16 * 1024 * 1024;

/**
 * Streaming WAV header.
 *
 * Liquidsoap's harbor cannot decode raw `audio/L16` - it answers
 * `Harbor.Make(T).Unknown_codec` and silently keeps playing the fallback
 * source. It does accept `audio/wav`, which it routes through ffmpeg. See
 * WAV_DATA_LIMIT for why the size field must be finite.
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
  v.setUint32(4, 36 + WAV_DATA_LIMIT, true); // riff size: matches the data chunk
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
  v.setUint32(40, WAV_DATA_LIMIT, true); // finite, see WAV_DATA_LIMIT
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
/** Metadata block cadence advertised to the harbor, in bytes. */
const ICY_METADATA_INTERVAL = 16000;
/** Length byte meaning "no metadata follows" in the ICY framing. */
const ICY_NO_METADATA = new Uint8Array([0]);

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
 * Backlog threshold for deciding the peer has stopped reading.
 *
 * Writing to a socket never fails when the peer is gone - Node buffers it. So a
 * dropped Liquidsoap source was invisible: connected stayed true, bytesSent kept
 * climbing, and the station was silent with nothing in the status to say so. An
 * outbound backlog that keeps growing is the only in-process signal that
 * nothing is reading.
 *
 * Two megabytes is about eleven seconds of 48 kHz stereo s16, which is far more
 * than a healthy link should ever queue.
 */
const BACKLOG_DEAD_BYTES = 2 * 1024 * 1024;
const BACKLOG_DEAD_MS = 3000;
/** A connection must last this long before it counts as a stable recovery. */
const STABLE_CONNECTION_MS = 10_000;

export class HarborPublisher {
  private readonly opts: Required<Omit<HarborOptions, "streamTitle">>;
  private streamTitle: string;
  /** The live upload request. A raw socket, so no HTTP body timeout applies. */
  private req: http.ClientRequest | null = null;
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
  /** Epoch ms the current connection was accepted, for stability checks. */
  private connectedAtMs = 0;
  /**
   * Interleave ICY metadata blocks into the upload. OFF by default.
   *
   * With this on, Liquidsoap's harbor fed the stream to ffmpeg at about 700
   * bytes a second rather than the 192 KB/s being sent, never filled its startup
   * buffer, and was never selected - so the station broadcast its dead-air
   * fallback tone while every counter looked healthy. The 255-byte framing and
   * its metadata length bytes desynchronised the WAV stream.
   *
   * Now-playing titles go out through Liquidsoap's own icy_song callback
   * instead. HARBOR_ICY=1 re-enables the old behaviour for comparison.
   */
  private readonly icyEnabled = process.env.HARBOR_ICY === "1";
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
  /**
   * Open the streaming upload over a raw socket.
   *
   * This deliberately does not use fetch(). A streaming request body under
   * undici carries a 300-second body timeout, and the upload was being torn
   * down at almost exactly that mark every time - Liquidsoap logging
   * `Failure("hd")` about five minutes after each connect, then falling back to
   * silence. A broadcast is expected to run for hours, so the transport needs
   * no timeout at all, which means owning the socket.
   */
  async connect(_signal?: AbortSignal, title?: string): Promise<void> {
    const { host, port, mount, user, password, channels, sampleRate } = this.opts;
    const auth = Buffer.from(`${user}:${password}`).toString("base64");
    if (title) this.lastTitle = title;
    const streamTitle = title ?? this.streamTitle;

    this.state.lastError = null;
    this.state.endedByServer = false;

    await new Promise<void>((resolve, reject) => {
      const req = http.request(
        {
          host,
          port,
          path: `/${mount.replace(/^\//, "")}`,
          method: "POST",
          headers: {
            Authorization: `Basic ${auth}`,
            "Content-Type": "audio/wav",
            ...(this.icyEnabled
              ? { "Icy-MetaData": "1", "icy-metaint": String(ICY_METADATA_INTERVAL) }
              : {}),
            "icy-name": streamTitle,
            /**
             * Deliberately NO Transfer-Encoding header. Setting it by hand makes
             * Node treat the body as pre-framed, and Liquidsoap's harbor then
             * consumed the stream at roughly 700 bytes a second - far too slowly
             * to ever fill its startup buffer, so it sat at "need more
             * buffering" indefinitely and the station played the fallback tone.
             * Omitting it lets Node add chunked framing itself, which is what the
             * server expects.
             */
          },
        },
        // Harbor answers as soon as it has registered the source, so the
        // response is not the end of the conversation.
        (res) => {
          const status = res.statusCode ?? 0;
          res.resume();
          if (status < 200 || status >= 300) {
            this.state.connected = false;
            this.state.lastError = `harbor responded ${status}`;
            req.destroy();
            reject(new Error(`harbor responded ${status}`));
            return;
          }
          this.onConnectAccepted(streamTitle, sampleRate, channels);
          resolve();
        },
      );

      // No idle timeout: this connection is supposed to stay open for days.
      req.setTimeout(0);
      req.setNoDelay(true);

      req.on("error", (err) => {
        const message = err instanceof Error ? err.message : String(err);
        // A destroy we initiated is not a failure to report.
        if (!this.state.connected) return;
        this.state.connected = false;
        this.state.lastError = message;
        this.scheduleRetry();
      });

      // The server closing the socket is the drop this whole class of bug is
      // about, so it must trigger recovery rather than pass unnoticed.
      req.on("close", () => {
        if (!this.state.connected || this.closedByUs) return;
        this.state.connected = false;
        this.state.lastError ??= "harbor closed the connection";
        this.teardown();
        this.scheduleRetry();
      });

      this.req = req;
      // Send the request head and keep the body open. req.end() here would
      // finish the upload immediately, so the WAV header written after the
      // response arrived went nowhere and Liquidsoap saw an empty body.
      req.flushHeaders();
    });
  }

  /** The server accepted the upload: mark live and prime the stream. */
  private onConnectAccepted(title: string, sampleRate: number, channels: number): void {
    this.state.connected = true;
    this.state.connectedAt = new Date().toISOString();
    this.state.bytesSent = 0;
    this.state.framesSent = 0;
    /**
     * A new connection is a new WAV stream, so the partial ICY block from the
     * previous one must be dropped. Carrying it over prepended stale bytes to
     * the fresh header, which Liquidsoap rejected as "Packet corrupt" /
     * Failure("hd") and then stopped feeding.
     */
    this.carry = new Uint8Array(0);
    this.pendingMetadata = icyMetadata(title);
    // Count this as a reconnect only if a previous connection existed, so the
    // number means "times we recovered" rather than "times we started".
    if (this.hasConnectedOnce) this.state.reconnects += 1;
    this.hasConnectedOnce = true;
    // A successful connect resets the backoff, so a transient blip costs one
    // retry rather than locking the station into 15-second attempts. Only a
    // connection that actually held counts: resetting on every accept turned a
    // connect-then-immediately-drop loop into a 2-per-second reconnect storm
    // that hammered Liquidsoap instead of recovering.
    if (Date.now() - this.connectedAtMs > STABLE_CONNECTION_MS) {
      this.retryDelayMs = RETRY_BASE_MS;
    }
    this.connectedAtMs = Date.now();
    this.state.nextRetryAtMs = null;
    this.closedByUs = false;
    this.backlogSince = null;

    // Streaming WAV: one header, then bare frames.
    this.req?.write(Buffer.from(wavHeader(sampleRate, channels)));
  }

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
    if (!this.req || !this.state.connected) return false;
    try {
      /**
       * Liveness check before writing.
       *
       * If the backlog has been growing past the dead threshold for long
       * enough, nothing is reading this stream. Treat it as dropped and let the
       * backoff re-open it, rather than buffering audio into the void while
       * reporting a healthy connection.
       */
      const desired = this.req.writableLength;
      if (desired > BACKLOG_DEAD_BYTES) {
        const now = Date.now();
        this.backlogSince ??= now;
        if (now - this.backlogSince >= BACKLOG_DEAD_MS) {
          this.state.lastError =
            `no reader for ${Math.round((now - this.backlogSince) / 1000)}s ` +
            `(backlog ${Math.round(desired / 1024)} KiB): treating the upload as dropped`;
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
      if (this.icyEnabled) {
        while (input.length - offset >= ICY_BLOCK) {
          const block = input.subarray(offset, offset + ICY_BLOCK);
          offset += ICY_BLOCK;
          this.req.write(block);
          // Metadata rides in the first block after it changes.
          if (this.pendingMetadata) {
            this.req.write(this.pendingMetadata);
            this.pendingMetadata = null;
          } else {
            this.req.write(ICY_NO_METADATA);
          }
        }
        this.carry = input.slice(offset);
      } else {
        // Raw PCM, no ICY framing: the default, and the only mode Liquidsoap's
        // harbor actually decodes at full rate.
        this.req.write(input);
        this.carry = new Uint8Array(0);
      }

      /**
       * Refresh the WAV header before the declared finite data size runs out,
       * so the limit is never actually reached. At 48 kHz stereo s16 that is
       * about three hours from now; the reconnect is sub-second and lands on
       * the next bar rather than mid-phrase of consequence.
       */
      if (this.state.bytesSent > WAV_DATA_LIMIT - WAV_RECONNECT_MARGIN) {
        this.state.bytesSent = 0;
        this.carry = new Uint8Array(0);
        this.teardown();
        this.scheduleRetry();
        return false;
      }

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
      this.req?.destroy();
    } catch {
      /* already destroyed */
    }
    this.req = null;
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
