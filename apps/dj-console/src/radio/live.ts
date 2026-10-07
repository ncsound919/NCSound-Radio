/**
 * Go live from the console (plan 5.3).
 *
 * The console's master bus is encoded by MediaRecorder (Opus in WebM) and sent
 * in 250 ms chunks over a WebSocket to ingest's `/live`, which pipes it through
 * ffmpeg into Liquidsoap's `live` harbor. Liquidsoap's fallback puts that mount
 * ahead of autopilot while it is connected and falls back when it is not.
 *
 * What this file will NOT do (plan 5.4): say "on air" because a button was
 * pressed. The phase only becomes `on_air` when ingest reports that Liquidsoap
 * confirmed our live source is the one connected to the harbor. Until then the
 * console says it is sending and waiting.
 *
 * Everything external (fetch, the socket, the encoder, the clock) is injected
 * so the state machine is tested without a browser or a station.
 */
import { Store } from "../state/store";
import type { LiveSnapshot } from "@ncsound/station-core";

export type LivePhase =
  /** Nothing happening. */
  | "idle"
  /** Running the go-live checks. */
  | "preflight"
  /** Checks passed; counting down before the mount connects. */
  | "countdown"
  /** Socket opening and redeeming the live key. */
  | "connecting"
  /** Audio is flowing to ingest; Liquidsoap has not confirmed the mount yet. */
  | "armed"
  /** Ingest reports Liquidsoap is carrying our live source. */
  | "on_air"
  /** Hand-back sent; waiting for the bridge to finish. */
  | "ending"
  /** The connection dropped or the station dropped us. Autopilot takes over. */
  | "lost"
  /** Handed back cleanly. */
  | "ended"
  /** A check or the connection failed before going live. */
  | "failed";

export type CheckId = "ingest" | "encoder" | "arm" | "socket";
export type Check = { id: CheckId; label: string; state: "pending" | "pass" | "fail"; detail: string };

export type LiveClientState = {
  phase: LivePhase;
  checks: Check[];
  /** Seconds left in the countdown, or null. */
  countdown: number | null;
  bitrateKbps: 128 | 192;
  /** Wall-clock ms when ingest says the live source went on air. */
  onAirSince: number | null;
  /** Encoded bytes this console handed to the socket this session. */
  sentBytes: number;
  /** Measured send rate from this console, kbit/s, over the last second. */
  sendKbps: number | null;
  /** Bytes queued in the socket and not yet sent. Grows when the uplink is too slow. */
  queuedBytes: number;
  /** The bridge's own report, read from ingest `/status`. */
  server: LiveSnapshot | null;
  /** One plain line for the operator. */
  message: string;
  /** Auto-rejoin deadline (wall-clock ms) after a drop, or null. */
  retryUntil: number | null;
  /** Rejoin attempts made since the last drop. */
  attempts: number;
};

export type LiveSocket = {
  binaryType: string;
  readonly bufferedAmount: number;
  readonly readyState: number;
  send(data: string | Blob | ArrayBuffer | Uint8Array): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev?: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number; reason: string }) => void) | null;
  onerror: ((ev?: unknown) => void) | null;
};

/** Anything with a byte size: a Blob from MediaRecorder, or bytes in tests. */
export type Chunk = Blob | Uint8Array;

export type LiveEncoder = {
  start(timesliceMs: number): void;
  /** Stops and flushes; resolves after the last chunk has been delivered. */
  stop(): Promise<void>;
};

export type LiveDeps = {
  /** fetch against ingest; `path` is like `/status`. Never throws: network errors resolve to `{ status: 0 }`. */
  request(path: string, init?: { method?: string; headers?: Record<string, string> }): Promise<{ status: number; body: unknown }>;
  openSocket(): LiveSocket;
  /** Whether MediaRecorder can produce Opus in WebM here. Null reason = supported. */
  encoderProblem(): string | null;
  createEncoder(bitrateKbps: number, onChunk: (c: Chunk) => void, onError: (message: string) => void): LiveEncoder;
  /** Control-plane token, if ingest requires one. The console normally has none. */
  token: string | null;
  /**
   * Retake the air by itself after a drop (default true). The owner riding out
   * a Wi-Fi blip wants it; a guest should come back deliberately, so it is off
   * for host/guest sessions.
   */
  autoRejoin?: boolean;
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
};

export const COUNTDOWN_SEC = 8;
export const CHUNK_MS = 250;
/** Plan 5.3: a send stalled for more than 3 s is a drop. */
export const STALL_SEC = 3;
export const RETRY_WINDOW_MS = 60_000;
export const RETRY_EVERY_MS = 5_000;
const ARMED_TIMEOUT_MS = 5_000;
const END_TIMEOUT_MS = 6_000;
const POLL_MS = 1_000;
const WATCH_MS = 500;

const CHECKS: Array<[CheckId, string]> = [
  ["ingest", "Station engine reachable"],
  ["encoder", "Opus encoder available"],
  ["arm", "Live mount free and key issued"],
  ["socket", "Live connection accepted"],
];

const freshChecks = (): Check[] => CHECKS.map(([id, label]) => ({ id, label, state: "pending", detail: "" }));

function size(c: Chunk): number {
  return c instanceof Uint8Array ? c.byteLength : (c as Blob).size;
}

const LOST_MESSAGE =
  "Connection lost. Liquidsoap hands the station back to autopilot when the live source drops (harbor timeout up to 8 s).";

export class LiveClient {
  readonly store: Store<LiveClientState>;
  private readonly d: LiveDeps;
  private socket: LiveSocket | null = null;
  private encoder: LiveEncoder | null = null;
  private key: string | null = null;
  private timers = new Set<unknown>();
  /** Bumped per session attempt so callbacks from an old socket are ignored. */
  private gen = 0;
  private closingByUs = false;
  private rateWindow: Array<{ at: number; bytes: number }> = [];
  private stalledSince: number | null = null;

  constructor(deps: LiveDeps, bitrateKbps: 128 | 192 = 192) {
    this.d = deps;
    this.store = new Store<LiveClientState>({
      phase: "idle",
      checks: freshChecks(),
      countdown: null,
      bitrateKbps,
      onAirSince: null,
      sentBytes: 0,
      sendKbps: null,
      queuedBytes: 0,
      server: null,
      message: "Not live. Autopilot runs the station.",
      retryUntil: null,
      attempts: 0,
    });
  }

  get state(): LiveClientState {
    return this.store.get();
  }

  get busy(): boolean {
    const p = this.state.phase;
    return p !== "idle" && p !== "ended" && p !== "failed" && !(p === "lost" && this.state.retryUntil === null);
  }

  setBitrate(kbps: 128 | 192): void {
    if (this.busy) return;
    this.store.set({ bitrateKbps: kbps });
  }

  /** Arm, count down, connect. `countdown: false` is used by Rejoin. */
  async goLive(opts: { countdown?: boolean } = {}): Promise<void> {
    if (this.busy) return;
    this.clearTimers();
    this.gen++;
    this.store.set({
      phase: "preflight",
      checks: freshChecks(),
      countdown: null,
      onAirSince: null,
      sentBytes: 0,
      sendKbps: null,
      queuedBytes: 0,
      server: null,
      retryUntil: null,
      attempts: 0,
      message: "Checking the station…",
    });
    const ok = await this.preflight(this.gen);
    if (!ok) return;
    if (opts.countdown === false) {
      this.connect(this.gen);
      return;
    }
    this.startCountdown(this.gen);
  }

  /** Abort a countdown or a pending connection before audio goes out. */
  cancel(): void {
    const p = this.state.phase;
    if (p !== "preflight" && p !== "countdown" && p !== "connecting") return;
    this.gen++;
    this.teardown(4000, "cancelled");
    // The issued key simply expires; ingest refuses a second arm until it does
    // or it is used, and says so.
    this.store.set({ phase: "idle", countdown: null, message: "Cancelled. Autopilot runs the station." });
  }

  /** Operator hand-back. */
  async end(): Promise<void> {
    const p = this.state.phase;
    if (p === "lost") {
      // Stop retrying; the station is already on autopilot.
      this.gen++;
      this.clearTimers();
      this.store.set({ phase: "ended", retryUntil: null, message: "Stopped rejoining. Autopilot runs the station." });
      return;
    }
    if (p !== "armed" && p !== "on_air") return;
    const gen = this.gen;
    this.store.set({ phase: "ending", message: "Handing back to autopilot…" });
    try {
      await this.encoder?.stop();
    } catch {
      /* already stopped */
    }
    this.encoder = null;
    if (gen !== this.gen) return;
    try {
      this.socket?.send(JSON.stringify({ type: "live.end" }));
    } catch {
      /* socket already gone: ingest treats that as the end of the session */
    }
    // Wait for ingest to confirm the bridge finished, or give up and close.
    this.after(END_TIMEOUT_MS, gen, () => this.finishEnd(gen, "Handed back. The bridge did not confirm in time; the connection was closed."));
  }

  /** Called by the poll when ingest reports the session is over after a hand-back. */
  private finishEnd(gen: number, message = "Handed back. Autopilot runs the station."): void {
    if (gen !== this.gen || this.state.phase !== "ending") return;
    this.gen++;
    this.teardown(1000, "handed back");
    this.store.set({ phase: "ended", message, sendKbps: null, queuedBytes: 0 });
  }

  /* ---------------- preflight ---------------- */

  private setCheck(id: CheckId, state: Check["state"], detail: string): void {
    this.store.set((s) => ({ checks: s.checks.map((c) => (c.id === id ? { ...c, state, detail } : c)) }));
  }

  private fail(gen: number, message: string): false {
    if (gen === this.gen) {
      this.teardown(4000, "failed");
      this.store.set({ phase: "failed", countdown: null, message });
    }
    return false;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { "content-type": "application/json" };
    if (this.d.token) h.authorization = `Bearer ${this.d.token}`;
    return h;
  }

  private async preflight(gen: number): Promise<boolean> {
    // 1. ingest reachable and new enough to carry a live bridge.
    const st = await this.d.request("/status");
    if (gen !== this.gen) return false;
    const live = (st.body as { live?: LiveSnapshot } | null)?.live;
    if (st.status !== 200) {
      this.setCheck("ingest", "fail", st.status === 0 ? "No answer from ingest. Is the station engine running?" : `ingest answered ${st.status}`);
      return this.fail(gen, "The station engine is not reachable.");
    }
    if (!live) {
      this.setCheck("ingest", "fail", "This ingest has no live bridge. Update and restart it.");
      return this.fail(gen, "The station engine does not support going live.");
    }
    if (live.state === "armed" || live.state === "on_air") {
      this.setCheck("ingest", "fail", "Another console is live right now.");
      return this.fail(gen, "Someone else holds the live mount.");
    }
    this.setCheck("ingest", "pass", "Reachable");

    // 2. Encoder.
    const problem = this.d.encoderProblem();
    if (problem) {
      this.setCheck("encoder", "fail", problem);
      return this.fail(gen, problem);
    }
    this.setCheck("encoder", "pass", `Opus/WebM at ${this.state.bitrateKbps} kbps`);

    // 3. Arm: proves the token (if any) and origin are accepted and the mount is free.
    const arm = await this.d.request("/live/arm", { method: "POST", headers: this.headers() });
    if (gen !== this.gen) return false;
    const body = (arm.body ?? {}) as { ok?: boolean; key?: string; error?: string };
    if (arm.status === 200 && body.ok && body.key) {
      this.key = body.key;
      this.setCheck("arm", "pass", "Key issued (single use, expires in 60 s)");
      return true;
    }
    const detail =
      arm.status === 401
        ? "ingest requires a token. Start the console with INGEST_TOKEN set; its server adds it to every request, the page never holds it."
        : arm.status === 403
          ? "ingest refused this console's origin. Add it to INGEST_ALLOWED_ORIGINS."
          : arm.status === 409
            ? body.error ?? "A live session or key is already active."
            : arm.status === 0
              ? "No answer from ingest."
              : body.error ?? `ingest answered ${arm.status}`;
    this.setCheck("arm", "fail", detail);
    return this.fail(gen, `Can't go live: ${detail}`);
  }

  /* ---------------- countdown and connect ---------------- */

  private startCountdown(gen: number): void {
    let left = COUNTDOWN_SEC;
    this.store.set({ phase: "countdown", countdown: left, message: `Going live in ${left} s. Cue your first track.` });
    const tick = () => {
      if (gen !== this.gen) return;
      left--;
      if (left <= 0) {
        this.store.set({ countdown: null });
        this.connect(gen);
        return;
      }
      this.store.set({ countdown: left, message: `Going live in ${left} s. Cue your first track.` });
      this.after(1000, gen, tick);
    };
    this.after(1000, gen, tick);
  }

  private connect(gen: number): void {
    const key = this.key;
    this.key = null;
    if (!key) {
      this.fail(gen, "No live key. Try again.");
      return;
    }
    this.store.set({ phase: "connecting", message: "Connecting the live mount…" });
    this.closingByUs = false;
    let ws: LiveSocket;
    try {
      ws = this.d.openSocket();
    } catch (e) {
      this.setCheck("socket", "fail", e instanceof Error ? e.message : "could not open the socket");
      this.fail(gen, "Could not open the live connection.");
      return;
    }
    ws.binaryType = "arraybuffer";
    this.socket = ws;
    let armed = false;

    ws.onopen = () => {
      if (gen !== this.gen) return;
      ws.send(JSON.stringify({ token: this.d.token ?? undefined, key }));
    };
    ws.onmessage = (ev) => {
      if (gen !== this.gen || armed || typeof ev.data !== "string") return;
      let frame: { type?: string } | null = null;
      try {
        frame = JSON.parse(ev.data) as { type?: string };
      } catch {
        return;
      }
      if (frame?.type !== "live.armed") return;
      armed = true;
      this.setCheck("socket", "pass", "Accepted");
      this.startSending(gen);
    };
    ws.onclose = (ev) => {
      if (gen !== this.gen) return;
      if (this.closingByUs) return;
      if (!armed) {
        const why =
          ev.code === 4401 ? "ingest rejected the token." :
          ev.code === 4403 ? "the live key was refused or expired." :
          ev.code === 4409 ? `the encoder could not start: ${ev.reason}` :
          `the connection closed (${ev.code}${ev.reason ? `: ${ev.reason}` : ""}).`;
        this.setCheck("socket", "fail", why);
        this.fail(gen, `Can't go live: ${why}`);
        return;
      }
      this.lose(gen, `connection closed (${ev.code}${ev.reason ? `: ${ev.reason}` : ""})`);
    };
    ws.onerror = () => {
      /* onclose follows and carries the code */
    };
    this.after(ARMED_TIMEOUT_MS, gen, () => {
      if (!armed && this.state.phase === "connecting") {
        this.setCheck("socket", "fail", "No answer from the live bridge within 5 s.");
        this.fail(gen, "The live bridge did not answer.");
      }
    });
  }

  private startSending(gen: number): void {
    this.rateWindow = [];
    this.stalledSince = null;
    this.encoder = this.d.createEncoder(
      this.state.bitrateKbps,
      (chunk) => {
        if (gen !== this.gen || !this.socket || this.socket.readyState !== 1) return;
        const n = size(chunk);
        if (n === 0) return;
        this.socket.send(chunk);
        this.rateWindow.push({ at: this.d.now(), bytes: n });
        this.store.set((s) => ({ sentBytes: s.sentBytes + n }));
      },
      (message) => {
        if (gen === this.gen) this.lose(gen, `encoder error: ${message}`);
      },
    );
    this.encoder.start(CHUNK_MS);
    this.store.set({ phase: "armed", message: "Sending. Waiting for the station to confirm the live mount…" });
    this.watch(gen);
    this.poll(gen);
  }

  /* ---------------- health ---------------- */

  /** Send rate and stall detection, every 500 ms. */
  private watch(gen: number): void {
    const run = () => {
      if (gen !== this.gen) return;
      const p = this.state.phase;
      if (p !== "armed" && p !== "on_air" && p !== "ending") return;
      const now = this.d.now();
      this.rateWindow = this.rateWindow.filter((r) => now - r.at <= 1000);
      const bytes = this.rateWindow.reduce((a, r) => a + r.bytes, 0);
      const queued = this.socket?.bufferedAmount ?? 0;
      // More than STALL_SEC of audio waiting in the socket means the uplink
      // can't keep up; and nothing leaving the encoder for that long means
      // the capture died.
      const bytesPerSec = (this.state.bitrateKbps * 1000) / 8;
      const behind = queued > bytesPerSec * STALL_SEC;
      const silent = p !== "ending" && bytes === 0;
      if (behind || silent) this.stalledSince ??= now;
      else this.stalledSince = null;
      this.store.set({ sendKbps: Math.round((bytes * 8) / 1000), queuedBytes: queued });
      if (this.stalledSince !== null && now - this.stalledSince > STALL_SEC * 1000 && p !== "ending") {
        this.lose(gen, behind ? "the uplink fell more than 3 s behind" : "the encoder stopped producing audio");
        return;
      }
      this.after(WATCH_MS, gen, run);
    };
    this.after(WATCH_MS, gen, run);
  }

  /** Ingest's view of the bridge, once a second: the only source of "on air". */
  private poll(gen: number): void {
    const run = async () => {
      if (gen !== this.gen) return;
      const res = await this.d.request("/status");
      if (gen !== this.gen) return;
      const server = (res.body as { live?: LiveSnapshot } | null)?.live ?? null;
      const p = this.state.phase;
      if (server) {
        this.store.set({ server });
        if (p === "armed" && server.state === "on_air") {
          const since = server.onAirSince ? Date.parse(server.onAirSince) : this.d.now();
          this.store.set({ phase: "on_air", onAirSince: since, message: "The station is carrying this console. Hand back when you're done." });
        } else if ((p === "armed" || p === "on_air") && (server.state === "offline" || server.state === "ended")) {
          this.lose(gen, server.error ? `the station dropped the session: ${server.error}` : "the station ended the session");
          return;
        } else if (p === "ending" && (server.state === "ended" || server.state === "offline")) {
          this.finishEnd(gen);
          return;
        }
      }
      if (this.state.phase === "armed" || this.state.phase === "on_air" || this.state.phase === "ending") {
        this.after(POLL_MS, gen, () => void run());
      }
    };
    this.after(POLL_MS, gen, () => void run());
  }

  /* ---------------- drop-out and rejoin ---------------- */

  private lose(gen: number, why: string): void {
    if (gen !== this.gen) return;
    this.gen++;
    const now = this.d.now();
    const auto = this.d.autoRejoin !== false;
    this.teardown(4001, "lost");
    this.store.set({
      phase: "lost",
      onAirSince: null,
      sendKbps: null,
      queuedBytes: 0,
      // No window means no automatic retry; the Rejoin key is offered instead.
      retryUntil: auto ? now + RETRY_WINDOW_MS : null,
      attempts: 0,
      message: auto
        ? `${LOST_MESSAGE} Cause: ${why}. Rejoining for 60 s…`
        : `${LOST_MESSAGE} Cause: ${why}. Press Rejoin when you are ready to go back on air.`,
    });
    if (auto) this.scheduleRetry(this.gen);
  }

  private scheduleRetry(gen: number): void {
    // Never sleep past the window: the give-up must land at 60 s, not at the
    // next 5 s tick after it.
    const until = this.state.retryUntil;
    const delay = until === null ? RETRY_EVERY_MS : Math.max(0, Math.min(RETRY_EVERY_MS, until - this.d.now()));
    this.after(delay, gen, () => void this.retry(gen));
  }

  private async retry(gen: number): Promise<void> {
    if (gen !== this.gen || this.state.phase !== "lost") return;
    const until = this.state.retryUntil;
    if (until === null || this.d.now() >= until) {
      this.store.set({ retryUntil: null, message: `${LOST_MESSAGE} Rejoin gave up after 60 s. Press Rejoin to try again.` });
      return;
    }
    this.store.set((s) => ({ attempts: s.attempts + 1 }));
    // A quiet preflight: the previous session may still be closing on the
    // server (409), in which case wait for the next tick.
    const arm = await this.d.request("/live/arm", { method: "POST", headers: this.headers() });
    if (gen !== this.gen || this.state.phase !== "lost") return;
    const body = (arm.body ?? {}) as { ok?: boolean; key?: string };
    if (arm.status === 200 && body.ok && body.key) {
      this.key = body.key;
      this.connect(gen);
      return;
    }
    this.scheduleRetry(gen);
  }

  /** Manual Rejoin after the automatic window. */
  async rejoin(): Promise<void> {
    if (this.state.phase !== "lost" && this.state.phase !== "failed") return;
    this.store.set({ phase: "idle", retryUntil: null });
    await this.goLive({ countdown: false });
  }

  /* ---------------- plumbing ---------------- */

  private after(ms: number, gen: number, fn: () => void): void {
    const h = this.d.setTimeout(() => {
      this.timers.delete(h);
      if (gen === this.gen) fn();
    }, ms);
    this.timers.add(h);
  }

  private clearTimers(): void {
    for (const h of this.timers) this.d.clearTimeout(h);
    this.timers.clear();
  }

  private teardown(code: number, reason: string): void {
    this.clearTimers();
    const enc = this.encoder;
    this.encoder = null;
    if (enc) void enc.stop().catch(() => {});
    const ws = this.socket;
    this.socket = null;
    if (ws) {
      this.closingByUs = true;
      try {
        ws.close(code, reason);
      } catch {
        /* already closed */
      }
    }
  }
}

/* ---------------- browser wiring ---------------- */

/**
 * Capture a program-bus MediaStream (post-limiter master, so it carries the
 * decks, sampler and mic talkover) and build the real deps.
 */
export function browserLiveDeps(programStream: () => MediaStream, token: string | null = null, opts: { autoRejoin?: boolean } = {}): LiveDeps {
  const MIME = "audio/webm;codecs=opus";
  return {
    token,
    autoRejoin: opts.autoRejoin,
    now: () => Date.now(),
    setTimeout: (fn, ms) => window.setTimeout(fn, ms),
    clearTimeout: (h) => window.clearTimeout(h as number),
    async request(path, init) {
      try {
        const res = await fetch(`/ingest${path}`, {
          method: init?.method ?? "GET",
          // The session token goes on every call, /status included: the preflight
          // read has no per-call headers, and a tunnelled /status needs the token.
          headers: { accept: "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}), ...(init?.headers ?? {}) },
          cache: "no-store",
          signal: AbortSignal.timeout(4000),
        });
        let body: unknown = null;
        try {
          body = await res.json();
        } catch {
          body = null;
        }
        return { status: res.status, body };
      } catch {
        return { status: 0, body: null };
      }
    },
    openSocket() {
      const proto = location.protocol === "https:" ? "wss:" : "ws:";
      return new WebSocket(`${proto}//${location.host}/ingest/live`) as unknown as LiveSocket;
    },
    encoderProblem() {
      if (typeof MediaRecorder === "undefined") return "This browser has no MediaRecorder.";
      if (!MediaRecorder.isTypeSupported(MIME)) return "This browser can't encode Opus in WebM. Use Chrome or Edge.";
      return null;
    },
    createEncoder(bitrateKbps, onChunk, onError) {
      const rec = new MediaRecorder(programStream(), { mimeType: MIME, audioBitsPerSecond: bitrateKbps * 1000 });
      let stopped: (() => void) | null = null;
      rec.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) onChunk(e.data);
      };
      rec.onerror = (e) => onError(String((e as unknown as { error?: Error }).error?.message ?? "MediaRecorder error"));
      rec.onstop = () => stopped?.();
      return {
        start: (ms) => rec.start(ms),
        stop: () =>
          new Promise<void>((resolve) => {
            if (rec.state === "inactive") return resolve();
            stopped = resolve;
            rec.stop();
          }),
      };
    },
  };
}
