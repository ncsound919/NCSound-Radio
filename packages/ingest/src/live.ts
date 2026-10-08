/**
 * The live bridge (plan 5.2).
 *
 * A browser cannot speak to Liquidsoap's harbor: harbor only accepts an
 * Icecast/Shoutcast *source*, not a WebSocket. So the console streams Opus in
 * WebM to this process, and this process re-encodes it to MP3 with ffmpeg and
 * feeds it to a second harbor mount, `live`, which sits ahead of the autopilot
 * feed in Liquidsoap's fallback. Keeping the bridge here also keeps the harbor
 * password off the browser.
 *
 * Everything that touches a process is injectable (`spawn`), so the whole state
 * machine — arm, backpressure, single-session, loss, hand-back — is unit-tested
 * against a fake without a real ffmpeg or Liquidsoap.
 *
 * What this bridge does NOT do: decide that we are on air. Immediately after
 * ffmpeg starts, the mount is still carrying autopilot. Only Liquidsoap can say
 * our source won, and that arrives via `markOnAir()`.
 */

import { spawn as nodeSpawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import type { LiveEvent, LiveSnapshot, LiveState } from "@ncsound/station-core";

/** The sliver of `ChildProcess` this module uses, so tests can supply a fake. */
export type LiveProcess = {
  stdin: {
    write(chunk: Uint8Array): boolean;
    end(): void;
    on(event: "drain" | "error" | "close", cb: (arg?: unknown) => void): void;
  } | null;
  stderr?: { on(event: "data", cb: (chunk: Buffer) => void): void } | null;
  on(event: "exit" | "error" | "close", cb: (arg?: unknown, arg2?: unknown) => void): void;
  kill(signal?: string): void;
  pid?: number;
};

export type LiveSpawn = (
  command: string,
  args: string[],
  options: { stdio: ["pipe", "ignore", "pipe"] },
) => LiveProcess;

export type LiveHarbor = {
  host: string;
  port: number;
  mount: string;
  user: string;
  password: string;
};

export type LiveBridgeOptions = {
  harbor?: Partial<LiveHarbor>;
  ffmpegPath?: string;
  /** Output bitrate (MP3) — this is what a listener actually receives. */
  bitrateKbps?: number;
  /** How long ffmpeg's stdin may stay blocked before the session is dropped. */
  blockDropMs?: number;
  /** How long ffmpeg may go without producing progress before the session is dropped. */
  stallDropMs?: number;
  statsIntervalMs?: number;
  spawn?: LiveSpawn;
  now?: () => number;
  onEvent?: (event: LiveEvent) => void;
};

const DEFAULT_HARBOR: LiveHarbor = {
  host: "127.0.0.1",
  port: 8008,
  mount: "live",
  user: "live",
  password: "",
};

/**
 * Strip credentials from a URL before it can reach a status field or a log.
 *
 * ffmpeg's icecast output URL carries the harbor password, and on a connect
 * failure ffmpeg prints that URL to stderr. That stderr line used to be copied
 * verbatim into `lastError`, which `/status` then served to any reader — moving
 * the credential rather than protecting it. Anything stored or logged goes
 * through here first.
 */
export function redactCredentials(text: string): string {
  return text.replace(/([a-z][a-z0-9+.-]*):\/\/[^:@/\s]+:[^@/\s]+@/gi, "$1://***@");
}

/**
 * The exact ffmpeg command line. The password is embedded in the icecast URL
 * because ffmpeg's icecast muxer takes no separate credential flag; this means
 * the password is visible in the process argv to anything that can list this
 * process. Accepted for a loopback bridge, but never log the returned args.
 */
export function liveFfmpegArgs(harbor: LiveHarbor, bitrateKbps: number): string[] {
  const url = `icecast://${harbor.user}:${harbor.password}@${harbor.host}:${harbor.port}/${harbor.mount}`;
  return [
    "-hide_banner",
    "-loglevel",
    "warning",
    "-f",
    "webm",
    "-i",
    "pipe:0",
    // Machine-readable progress on stderr (`out_time_us=…`), every 0.5 s by
    // default: the encoder's own audio clock, used for the drift figure.
    "-progress",
    "pipe:2",
    "-c:a",
    "libmp3lame",
    "-b:a",
    `${bitrateKbps}k`,
    "-f",
    "mp3",
    url,
  ];
}

export class LiveBridge {
  private readonly opts: Required<
    Omit<LiveBridgeOptions, "harbor" | "spawn" | "now" | "onEvent">
  > & { harbor: LiveHarbor; spawn: LiveSpawn; now: () => number; onEvent: (e: LiveEvent) => void };

  private proc: LiveProcess | null = null;
  private _state: LiveState = "offline";
  private sessionId: string | null = null;
  private armedAtMs: number | null = null;
  private onAirSinceMs: number | null = null;
  private bytesSent = 0;
  private bytesPerSec = 0;
  private lastSampleBytes = 0;
  private lastSampleAt = 0;
  private blockedSinceMs: number | null = null;
  /** Wall clock of the first audio byte this session. */
  private firstByteAtMs: number | null = null;
  /** ffmpeg's reported audio time (out_time), seconds; null until reported. */
  private encoderAudioSec: number | null = null;
  /** Wall clock of the last ffmpeg progress line, or null before the first. */
  private lastProgressAtMs: number | null = null;
  private lastError: string | null = null;
  /** Why the process ended: "ended" (operator) vs a loss reason. */
  private ending: { byUs: boolean; reason: string } | null = null;
  private timers: Array<ReturnType<typeof setInterval>> = [];

  constructor(options: LiveBridgeOptions = {}) {
    const harbor: LiveHarbor = { ...DEFAULT_HARBOR, ...options.harbor };
    if (!harbor.password) harbor.password = process.env.LIVE_HARBOR_PASSWORD ?? "";
    this.opts = {
      harbor,
      ffmpegPath:
        options.ffmpegPath ??
        process.env.NCSOUND_FFMPEG ??
        (process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg"),
      bitrateKbps: options.bitrateKbps ?? 192,
      blockDropMs: options.blockDropMs ?? 2000,
      stallDropMs: options.stallDropMs ?? 3000,
      statsIntervalMs: options.statsIntervalMs ?? 1000,
      spawn: options.spawn ?? (nodeSpawn as unknown as LiveSpawn),
      now: options.now ?? (() => Date.now()),
      onEvent: options.onEvent ?? (() => {}),
    };
  }

  get state(): LiveState {
    return this._state;
  }

  /** No session in progress. Used by `/live/arm` to refuse a second one. */
  get available(): boolean {
    return this.proc === null && this._state !== "armed" && this._state !== "on_air";
  }

  get snapshot(): LiveSnapshot {
    return {
      state: this._state,
      sessionId: this.sessionId,
      armedAt: this.armedAtMs === null ? null : new Date(this.armedAtMs).toISOString(),
      onAirSince: this.onAirSinceMs === null ? null : new Date(this.onAirSinceMs).toISOString(),
      bytesSent: this.bytesSent,
      bytesPerSec: Math.round(this.bytesPerSec),
      driftSec: +this.driftSec().toFixed(2),
      driftMeasured: this.encoderAudioSec !== null && this.firstByteAtMs !== null,
      blockedMs: this.blockedSinceMs === null ? 0 : this.opts.now() - this.blockedSinceMs,
      error: this.lastError,
    };
  }

  private driftSec(): number {
    if (this.encoderAudioSec === null || this.firstByteAtMs === null) return 0;
    const wallSec = (this.opts.now() - this.firstByteAtMs) / 1000;
    return this.encoderAudioSec - wallSec;
  }

  /**
   * Read ffmpeg's stderr: `-progress` key=value lines update the audio clock;
   * anything that looks like an error becomes `lastError` (redacted). Every
   * line in the chunk is examined, because progress lines arrive in the same
   * chunks as errors and taking only the last line would hide the error.
   */
  private readStderr(chunk: unknown): void {
    for (const raw of String(chunk).split(/\r?\n/)) {
      const line = raw.trim();
      if (!line) continue;
      const us = /^out_time_us=(\d+)$/.exec(line) ?? /^out_time_ms=(\d+)$/.exec(line);
      if (us) {
        // out_time_ms is microseconds too (a long-standing ffmpeg misnomer).
        this.encoderAudioSec = Number(us[1]) / 1e6;
        this.lastProgressAtMs = this.opts.now();
        continue;
      }
      if (/^[a-z_]+=/.test(line)) continue; // other progress keys
      if (/error|invalid|failed|refused|denied/i.test(line)) {
        this.lastError = redactCredentials(line).slice(0, 240);
      }
    }
  }

  /**
   * Start the encoder. Throws when a session is already running, so a second
   * console cannot silently steal the mount.
   */
  arm(session: { sessionId: string; expiresAt: string }): LiveSnapshot {
    if (this.proc) throw new Error("a live session is already in progress");
    this.sessionId = session.sessionId;
    const at = this.opts.now();
    this.armedAtMs = at;
    this.bytesSent = 0;
    this.bytesPerSec = 0;
    this.lastSampleBytes = 0;
    this.lastSampleAt = at;
    this.blockedSinceMs = null;
    this.onAirSinceMs = null;
    this.firstByteAtMs = null;
    this.encoderAudioSec = null;
    this.lastProgressAtMs = null;
    this.lastError = null;
    this.ending = null;

    const args = liveFfmpegArgs(this.opts.harbor, this.opts.bitrateKbps);
    const proc = this.opts.spawn(this.opts.ffmpegPath, args, { stdio: ["pipe", "ignore", "pipe"] });
    this.proc = proc;

    proc.stdin?.on("drain", () => {
      this.blockedSinceMs = null;
    });
    proc.stdin?.on("error", (err) => {
      this.lastError = `encoder stdin: ${err instanceof Error ? err.message : String(err)}`;
    });
    proc.stderr?.on("data", (chunk) => this.readStderr(chunk));
    proc.on("error", (err) => {
      this.lastError = `ffmpeg could not start: ${err instanceof Error ? err.message : String(err)}`;
    });
    proc.on("exit", () => this.onExit());

    this.setState("armed");
    this.startTimers();
    this.emit({ type: "live.armed", at: this.iso(), sessionId: session.sessionId, expiresAt: session.expiresAt });
    return this.snapshot;
  }

  /**
   * Feed one encoded chunk. Returns whether the encoder accepted it without
   * backpressure. When blocked past `blockDropMs`, the session is dropped
   * rather than letting chunks pile up in memory.
   */
  write(chunk: Uint8Array): boolean {
    if (!this.proc || (this._state !== "armed" && this._state !== "on_air")) return false;
    const stdin = this.proc.stdin;
    if (!stdin) return false;
    let ok = false;
    try {
      ok = stdin.write(chunk);
    } catch (err) {
      this.abort(`encoder rejected audio: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
    this.bytesSent += chunk.byteLength;
    this.firstByteAtMs ??= this.opts.now();
    if (!ok && this.blockedSinceMs === null) this.blockedSinceMs = this.opts.now();
    return ok;
  }

  /** Liquidsoap says our live source is carrying the mount. */
  markOnAir(): void {
    if (this._state !== "armed" && this._state !== "on_air") return;
    if (this._state === "on_air") return;
    this.onAirSinceMs = this.opts.now();
    this.setState("on_air");
    if (this.sessionId) this.emit({ type: "live.on_air", at: this.iso(), sessionId: this.sessionId });
  }

  /** Operator hand-back: close stdin and let ffmpeg finish. */
  end(): void {
    if (!this.proc) return;
    this.ending = { byUs: true, reason: "handed back" };
    try {
      this.proc.stdin?.end();
    } catch {
      /* already closing */
    }
  }

  /** Drop the session immediately (backpressure, auth loss, socket close). */
  abort(reason: string): void {
    if (!this.proc) return;
    // A clean hand-back is already in progress. Killing here would truncate the
    // flush and, because `ending` is overwritten, report the operator's own
    // hand-back as a loss. Let end() finish through onExit.
    if (this.ending?.byUs) return;
    this.ending = { byUs: false, reason };
    this.lastError = this.lastError ?? reason;
    try {
      this.proc.kill();
    } catch {
      /* already gone */
    }
    // A real process exits and calls onExit; a fake may not. Either way, the
    // session is over now, so settle it if the exit never comes.
    if (this.proc) setTimeout(() => this.onExit(), 0).unref?.();
  }

  /**
   * Operator override: drop the session now, even mid hand-back, and settle it
   * synchronously so the caller sees `offline` rather than a half-dead state.
   * Unlike abort(), this wins over an in-progress hand-back. Returns whether
   * there was a session to kill.
   */
  kill(reason: string): boolean {
    if (!this.proc) return false;
    this.ending = { byUs: false, reason };
    this.lastError = reason;
    try {
      this.proc.kill();
    } catch {
      /* already gone */
    }
    this.onExit();
    return true;
  }

  private onExit(): void {
    if (!this.proc && this._state !== "armed" && this._state !== "on_air") return;
    const sid = this.sessionId;
    const ending = this.ending ?? { byUs: false, reason: this.lastError ?? "encoder exited" };
    this.proc = null;
    this.clearTimers();
    this.blockedSinceMs = null;
    this.lastProgressAtMs = null;
    this.sessionId = null;
    this.ending = null;

    if (ending.byUs) {
      // Keep "ended" (not "offline") until the next arm, so the operator surface
      // can tell a completed hand-back from a session that never started. The
      // store's `available` getter treats "ended" as free to re-arm.
      this.setState("ended");
      this.emit({ type: "live.ended", at: this.iso(), sessionId: sid ?? "unknown" });
    } else {
      this.lastError = ending.reason;
      this.setState("offline");
      this.emit({ type: "live.lost", at: this.iso(), sessionId: sid ?? "unknown", reason: ending.reason });
    }
  }

  private startTimers(): void {
    const stats = setInterval(() => {
      const now = this.opts.now();
      const dt = (now - this.lastSampleAt) / 1000;
      if (dt > 0) {
        this.bytesPerSec = (this.bytesSent - this.lastSampleBytes) / dt;
        this.lastSampleBytes = this.bytesSent;
        this.lastSampleAt = now;
      }
      this.emit({
        type: "live.stats",
        at: this.iso(),
        sessionId: this.sessionId ?? "unknown",
        bytesSent: this.bytesSent,
        bytesPerSec: Math.round(this.bytesPerSec),
        driftSec: +this.driftSec().toFixed(2),
        blockedMs: this.blockedSinceMs === null ? 0 : now - this.blockedSinceMs,
      });
    }, this.opts.statsIntervalMs);

    const guard = setInterval(() => {
      const now = this.opts.now();
      if (this.blockedSinceMs !== null && now - this.blockedSinceMs > this.opts.blockDropMs) {
        this.abort("encoder backpressure: ffmpeg stopped draining for over 2 s");
        return;
      }
      // Progress-stall: ffmpeg accepted input but stopped producing output. The
      // console's own 3 s detector only covers console->ingest, so a stall
      // between ingest and Liquidsoap otherwise surfaces at the harbor's ~8 s
      // timeout. Dropping here lets the console learn within a few seconds.
      if (this.ending?.byUs) return;
      if (this.lastProgressAtMs !== null && now - this.lastProgressAtMs > this.opts.stallDropMs) {
        this.abort(`encoder output stalled: no ffmpeg progress for over ${Math.round(this.opts.stallDropMs / 1000)} s`);
      } else if (this.lastProgressAtMs === null && this.firstByteAtMs !== null && now - this.firstByteAtMs > this.opts.stallDropMs) {
        this.abort("encoder never started producing progress");
      }
    }, 250);

    (stats as unknown as { unref?: () => void }).unref?.();
    (guard as unknown as { unref?: () => void }).unref?.();
    this.timers = [stats, guard];
  }

  private clearTimers(): void {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
  }

  dispose(): void {
    this.clearTimers();
    try {
      this.proc?.kill();
    } catch {
      /* gone */
    }
    this.proc = null;
  }

  private setState(state: LiveState): void {
    this._state = state;
  }

  private emit(event: LiveEvent): void {
    try {
      this.opts.onEvent(event);
    } catch {
      /* a bad listener must not break audio */
    }
  }

  private iso(): string {
    return new Date(this.opts.now()).toISOString();
  }
}

/**
 * One-time live keys, issued at Arm and redeemed when the audio socket opens.
 *
 * This is the second factor the plan calls for: the control token authenticates
 * the control plane, but the audio path gets its own short-lived key so a stale
 * token alone cannot push audio to the station.
 */
export class LiveKeyStore {
  private current: { key: string; expiresAtMs: number } | null = null;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly random: (n: number) => Buffer;

  constructor(opts: { ttlMs?: number; now?: () => number; random?: (n: number) => Buffer } = {}) {
    this.ttlMs = opts.ttlMs ?? 60_000;
    this.now = opts.now ?? (() => Date.now());
    this.random = opts.random ?? ((n) => randomBytes(n));
  }

  issue(): { key: string; expiresAt: string } {
    const key = this.random(24).toString("hex");
    const expiresAtMs = this.now() + this.ttlMs;
    this.current = { key, expiresAtMs };
    return { key, expiresAt: new Date(expiresAtMs).toISOString() };
  }

  /** Consume the key if it matches and has not expired. One use only. */
  redeem(key: string): boolean {
    const c = this.current;
    if (!c) return false;
    if (this.now() > c.expiresAtMs) {
      this.current = null;
      return false;
    }
    if (!timingSafeStringEqual(key, c.key)) return false;
    this.current = null;
    return true;
  }

  invalidate(): void {
    this.current = null;
  }

  get armed(): boolean {
    return this.current !== null && this.now() <= this.current.expiresAtMs;
  }
}

function timingSafeStringEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
