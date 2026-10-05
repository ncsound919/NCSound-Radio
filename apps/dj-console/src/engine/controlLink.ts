/**
 * The control link: the console's connection to the headless engine.
 *
 * Until now this did not exist. The ingest service had a WebSocket control
 * plane that accepted commands, published results and pushed stream updates —
 * and no client anywhere called it. `sendCommand()` in station-web had zero
 * call sites, and `new WebSocket` appeared in no file of the repository. Every
 * UI control therefore changed only local browser state while the badge said
 * ON AIR, and the engine, which owns the audio, never heard about it.
 *
 * Design:
 *   - WebSocket to `/ingest/ws` is the primary channel: it carries command
 *     results and `stream.status` pushes, so nothing has to poll.
 *   - HTTP `POST /ingest/command` is the fallback when the socket is down, so
 *     a failed upgrade degrades to a slower working control path rather than
 *     a dead one.
 *   - `GET /status` stays with `broadcastLink.ts`. The server never emits
 *     `engine.*` events (only `command.result` and `stream.status`), so engine
 *     state, uptime and crate size still come from the HTTP poll.
 *
 * Envelope ids are minted client-side so a retried command is the same
 * command: the ingest service replays a cached result instead of running it
 * twice. Without that, a reconnect that resends a transport command could
 * start a track twice.
 */

import type {
  Actor,
  CommandErrorCode,
  CommandResult,
  DjCommand,
  EngineState,
  ServerEvent,
  StreamStatus,
} from "@ncsound/station-core/contract";

/** Structural subset of WebSocket so the transport can be faked in tests. */
export type SocketLike = {
  readyState: number;
  send(data: string): void;
  close(): void;
  onopen: (() => void) | null;
  onclose: (() => void) | null;
  onerror: ((ev?: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
};

export type SocketFactory = (url: string) => SocketLike;

export type ControlTransport = "connecting" | "websocket" | "http" | "offline";

export type ControlState = {
  /** Which channel a command would currently travel on. */
  transport: ControlTransport;
  /** A `connection.ready` frame arrived on the current socket. */
  ready: boolean;
  /**
   * Either channel has proved the engine answers.
   *
   * Separate from `transport` because a WS-only view reads "not ready" while
   * HTTP `GET /status` is perfectly healthy, and the mode badge would then
   * claim REHEARSAL during a working session.
   */
  reachable: boolean;
  actor: Actor;
  /** Freshest push from the engine, or null before the first one. */
  stream: StreamStatus | null;
  /** Fields the server only exposes over HTTP `GET /status`. */
  engineState: EngineState | null;
  /** Last command result, success or failure. */
  lastResult: CommandResult | null;
  lastError: string | null;
  lastEventAt: string | null;
  reconnects: number;
  /** Commands handed to a transport, and the ones it refused. */
  sent: number;
  failed: number;
};

export type ControlLinkOptions = {
  /**
   * Path the vite proxy forwards to ingest. Same proxy as `broadcastLink`.
   *
   * Same-origin in the console. An absolute URL (`http://host:port`) switches
   * the WebSocket to that host too — but the HTTP fallback will then be blocked
   * by CORS, because ingest sends no `Access-Control-Allow-Origin` and answers
   * no `OPTIONS`. Use the proxy unless you have added CORS to ingest.
   */
  base?: string;
  actor?: Actor;
  /**
   * `INGEST_TOKEN`, required when ingest is bound beyond loopback.
   *
   * Without it every command is refused with UNAUTHORIZED and the console
   * reports the engine as unreachable. There is deliberately no default: the
   * token is a server secret, so it is supplied by whoever wires the console
   * up rather than baked into the bundle.
   */
  token?: string | null;
  socketFactory?: SocketFactory;
  /** Per-command wait before the result is declared lost. */
  commandTimeoutMs?: number;
  connectTimeoutMs?: number;
  minBackoffMs?: number;
  maxBackoffMs?: number;
  now?: () => number;
};

const DEFAULT_ACTOR: Actor = {
  id: "console",
  role: "console",
  label: "dj console",
};

/** 1xx–3xx are not "open" on any implementation; only 1 means usable. */
const OPEN = 1;

function freshState(actor: Actor): ControlState {
  return {
    transport: "connecting",
    ready: false,
    reachable: false,
    actor,
    stream: null,
    engineState: null,
    lastResult: null,
    lastError: null,
    lastEventAt: null,
    reconnects: 0,
    sent: 0,
    failed: 0,
  };
}

type Pending = {
  resolve: (r: CommandResult) => void;
  timer: ReturnType<typeof setTimeout>;
};

export class ControlLink {
  private state: ControlState;
  private socket: SocketLike | null = null;
  private pending = new Map<string, Pending>();
  /** Ids already answered, so the server's direct send and its broadcast copy
   *  both resolve once instead of racing. */
  private answered = new Set<string>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  private backoffMs: number;
  private attempts = 0;
  private stopped = true;
  private listeners = new Set<(s: ControlState) => void>();
  private readonly opts: Required<Omit<ControlLinkOptions, "socketFactory" | "now">> & {
    socketFactory: SocketFactory;
    now: () => number;
  };

  constructor(options: ControlLinkOptions = {}) {
    const base = options.base ?? "/ingest";
    this.opts = {
      base: base.endsWith("/") ? base.slice(0, -1) : base,
      actor: options.actor ?? DEFAULT_ACTOR,
      token: options.token ?? null,
      commandTimeoutMs: options.commandTimeoutMs ?? 8000,
      connectTimeoutMs: options.connectTimeoutMs ?? 6000,
      minBackoffMs: options.minBackoffMs ?? 300,
      maxBackoffMs: options.maxBackoffMs ?? 8000,
      socketFactory: options.socketFactory ?? ((url) => new WebSocket(url) as unknown as SocketLike),
      now: options.now ?? (() => Date.now()),
    };
    this.backoffMs = this.opts.minBackoffMs;
    this.state = freshState(this.opts.actor);
  }

  get status(): ControlState {
    return this.state;
  }

  subscribe(fn: (s: ControlState) => void): () => void {
    this.listeners.add(fn);
    fn(this.state);
    return () => this.listeners.delete(fn);
  }

  /** Open the socket. Safe to call again after `stop()`. */
  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.connectTimer) clearTimeout(this.connectTimer);
    this.reconnectTimer = null;
    this.connectTimer = null;
    this.detach();
    this.release({ ok: false, id: "", appliedAt: new Date().toISOString(), code: "ENGINE_OFFLINE", error: "control link stopped" });
    this.patch({ transport: "offline", ready: false, reachable: false });
  }

  /**
   * Send one command to the engine.
   *
   * Resolves with the engine's own verdict — including a refusal — because a
   * rejected command is information the operator needs, not an exception to
   * swallow. Unreachable transport resolves to an `ENGINE_OFFLINE` result so
   * callers have one shape to render.
   */
  async send(command: DjCommand, timeoutMs = this.opts.commandTimeoutMs): Promise<CommandResult> {
    const id = envelopeId();
    this.answered.delete(id);
    this.patch({ sent: this.state.sent + 1 });

    const socket = this.socket;
    if (socket && socket.readyState === OPEN && this.state.ready) {
      try {
        socket.send(
          JSON.stringify({
            id,
            actor: this.opts.actor,
            token: this.opts.token,
            command,
          }),
        );
        return await this.await(id, timeoutMs);
      } catch (err) {
        this.patch({ lastError: describe(err) });
        // Fall through to HTTP rather than failing the operator's click.
      }
    }
    return this.sendHttp(id, command, timeoutMs);
  }

  private async sendHttp(id: string, command: DjCommand, timeoutMs: number): Promise<CommandResult> {
    this.patch({ transport: this.socket ? "http" : "offline" });
    try {
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (this.opts.token) headers.authorization = `Bearer ${this.opts.token}`;
      const res = await fetch(`${this.opts.base}/command`, {
        method: "POST",
        headers,
        signal: AbortSignal.timeout(timeoutMs),
        body: JSON.stringify({ id, actor: this.opts.actor, command }),
      });
      const body = (await res.json()) as CommandResult;
      if (!body || typeof body.ok !== "boolean") {
        return this.fail(id, "INTERNAL", `ingest replied ${res.status} without a result`);
      }
      this.onResult(body);
      if (body.ok) this.patch({ reachable: true });
      else if (body.code === "ENGINE_OFFLINE") this.patch({ reachable: false });
      return body;
    } catch (err) {
      this.patch({ reachable: false });
      return this.fail(id, "ENGINE_OFFLINE", describe(err));
    }
  }

  private await(id: string, timeoutMs: number): Promise<CommandResult> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve(this.fail(id, "ENGINE_OFFLINE", `no result for command ${id}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, timer });
    });
  }

  private fail(id: string, code: CommandErrorCode, error: string): CommandResult {
    const result: CommandResult = {
      id,
      ok: false,
      appliedAt: new Date(this.opts.now()).toISOString(),
      code,
      error,
    };
    // "The engine did not answer" is a statement about reachability, and the
    // mode badge must not keep claiming ON AIR while every click times out.
    if (code === "ENGINE_OFFLINE") this.patch({ reachable: false });
    this.onResult(result);
    return result;
  }

  /** Resolve every in-flight command, used on shutdown and socket loss. */
  private release(result: CommandResult): void {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.resolve({ ...result, id });
      // Deliberately NOT recorded in `answered`. Those ids stay live on the
      // engine: marking them answered here meant a result that arrived after a
      // reconnect was discarded, so `lastResult` never updated and the operator
      // re-clicked — stopping the engine twice. Ids are unique per send, so
      // there is nothing to double-resolve.
    }
    this.pending.clear();
  }

  private onResult(result: CommandResult): void {
    this.patch({ lastResult: result, lastEventAt: new Date(this.opts.now()).toISOString() });
    if (this.answered.has(result.id)) return;
    this.answered.add(result.id);
    // Bounded: a long session mints thousands of ids and this set exists only
    // to swallow the server's duplicate send, which arrives within a tick.
    if (this.answered.size > 512) {
      const oldest = this.answered.values().next().value;
      if (oldest !== undefined) this.answered.delete(oldest);
    }
    if (!result.ok) {
      this.patch({ failed: this.state.failed + 1, lastError: result.error });
    }
    const pending = this.pending.get(result.id);
    if (pending) {
      clearTimeout(pending.timer);
      this.pending.delete(result.id);
      pending.resolve(result);
    }
  }

  private connect(): void {
    if (this.stopped) return;
    this.detach();
    if (this.connectTimer) {
      clearTimeout(this.connectTimer);
      this.connectTimer = null;
    }
    this.patch({ transport: "connecting", ready: false });

    let socket: SocketLike;
    try {
      socket = this.opts.socketFactory(this.wsUrl());
    } catch (err) {
      this.patch({ lastError: describe(err) });
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;

    this.connectTimer = setTimeout(() => {
      this.connectTimer = null;
      // Keyed on `ready`, not on the transport string: `onopen` already set
      // transport to "websocket", so a socket that opened but never delivered
      // `connection.ready` used to sit here forever with no reconnect — every
      // command silently took the HTTP path and the badge stayed REHEARSAL.
      if (!this.state.ready) {
        this.patch({ lastError: "control socket opened but never became ready" });
        this.detach();
        this.scheduleReconnect();
      }
    }, this.opts.connectTimeoutMs);

    socket.onopen = () => {
      this.attempts = 0;
      this.backoffMs = this.opts.minBackoffMs;
      this.patch({ transport: "websocket" });
    };
    socket.onmessage = (ev) => this.receive(ev.data);
    socket.onerror = () => {
      /* `onclose` always follows; handling both would double-schedule. */
    };
    socket.onclose = () => {
      this.socket = null;
      if (this.stopped) return;
      this.release({
        id: "",
        ok: false,
        appliedAt: new Date(this.opts.now()).toISOString(),
        code: "ENGINE_OFFLINE",
        error: "control socket closed before the engine answered",
      });
      this.patch({ ready: false, reachable: false, transport: "connecting" });
      this.scheduleReconnect();
    };
  }

  private receive(raw: unknown): void {
    const event = parseEvent(raw);
    if (!event) return;
    this.patch({ lastEventAt: new Date(this.opts.now()).toISOString() });

    switch (event.type) {
      case "connection.ready":
        if (this.connectTimer) {
          clearTimeout(this.connectTimer);
          this.connectTimer = null;
        }
        this.attempts = 0;
        this.patch({ ready: true, reachable: true, transport: "websocket", actor: event.actor, lastError: null });
        break;
      case "stream.status":
        this.patch({ stream: event.status });
        break;
      case "command.result":
        this.onResult(event.result);
        break;
      case "engine.status":
        this.patch({ engineState: event.state });
        break;
      case "engine.error":
        this.patch({ lastError: event.message });
        break;
      case "engine.onAir":
      case "engine.telemetry":
        // Held for callers that care; the console currently renders stream
        // state only, so there is nothing to put these on yet.
        break;
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    this.attempts += 1;
    const jitter = Math.floor(this.backoffMs * 0.25 * Math.random());
    const delay = this.backoffMs + jitter;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.stopped) return;
      this.patch({ reconnects: this.state.reconnects + 1 });
      this.connect();
    }, delay);
    this.backoffMs = Math.min(this.backoffMs * 2, this.opts.maxBackoffMs);
  }

  private detach(): void {
    const socket = this.socket;
    if (!socket) return;
    socket.onopen = null;
    socket.onclose = null;
    socket.onerror = null;
    socket.onmessage = null;
    try {
      socket.close();
    } catch {
      /* already closing */
    }
    this.socket = null;
  }

  /**
   * Resolve the socket URL.
   *
   * Normally the base is a same-origin proxy path (`/ingest`), so the socket
   * hangs off `location.origin`. An absolute base is also accepted, which is
   * how this can be pointed at a remote ingest service without the vite proxy.
   *
   * WebSocket only: ingest sends no CORS headers and does not answer OPTIONS,
   * so the HTTP fallback in `sendHttp` is same-origin only. With an absolute
   * cross-origin base the socket works and the POST is blocked by the browser —
   * see `base` in `ControlLinkOptions`.
   */
  private wsUrl(): string {
    if (/^https?:\/\//i.test(this.opts.base)) {
      const absolute = new URL(this.opts.base);
      absolute.protocol = absolute.protocol === "https:" ? "wss:" : "ws:";
      absolute.pathname = `${absolute.pathname.replace(/\/$/, "")}/ws`;
      absolute.search = "";
      absolute.hash = "";
      return absolute.toString();
    }
    const origin = typeof location === "undefined" ? "http://127.0.0.1" : location.origin;
    const url = new URL(`${this.opts.base}/ws`, origin);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    return url.toString();
  }

  private patch(next: Partial<ControlState>): void {
    this.state = { ...this.state, ...next };
    for (const fn of this.listeners) fn(this.state);
  }
}

function describe(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * `crypto.randomUUID` needs a secure context, and the console is routinely
 * opened over plain http on a LAN address where it does not exist.
 */
function envelopeId(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  if (c && typeof c.getRandomValues === "function") {
    const bytes = c.getRandomValues(new Uint8Array(16));
    return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  }
  return `env-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function parseEvent(raw: unknown): ServerEvent | null {
  if (typeof raw !== "string") return null;
  try {
    const parsed = JSON.parse(raw) as ServerEvent;
    if (!parsed || typeof parsed !== "object" || typeof parsed.type !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}
