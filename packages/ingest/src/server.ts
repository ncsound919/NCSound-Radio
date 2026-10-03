/**
 * Ingest service — the control plane between the apps and the DJ engine.
 *
 *   station-web  ─┐
 *   dj-console   ─┼─HTTP + WebSocket─> ingest ─> HeadlessEngine ─PCM─> Liquidsoap ─> Icecast
 *   automation   ─┘                      │
 *                                        └─polls─> Icecast /status-json.xsl (listener counts)
 *
 * The engine is single-owner: exactly one HeadlessEngine per process, and every
 * mutation goes through CommandDispatcher so it lands in the shared contract's
 * result shape.
 */

import type { Actor, CommandEnvelope, ServerEvent } from "@ncsound/station-core";
import { djCommandSchema } from "@ncsound/station-core/schema";
import { HeadlessEngine, type HeadlessEngineOptions } from "@ncsound/dj-engine";

import { CommandDispatcher, type DispatcherDeps } from "./commands";
import { IcecastPoller, ListenerHistory, listenerCountsFrom, type IcecastOptions } from "./icecast";

export type IngestOptions = {
  port?: number;
  host?: string;
  engine?: HeadlessEngineOptions;
  icecast?: IcecastOptions;
  /** Bearer token required on mutating routes. Unset means open (localhost only). */
  token?: string;
  isAuthorised?: DispatcherDeps["isAuthorised"];
  resolveCueRequest?: DispatcherDeps["resolveCueRequest"];
  playImaging?: DispatcherDeps["playImaging"];
};

export class IngestService {
  readonly engine: HeadlessEngine;
  readonly dispatcher: CommandDispatcher;
  readonly icecast: IcecastPoller;
  readonly history = new ListenerHistory();

  private readonly opts: IngestOptions;
  private readonly sockets = new Set<Bun.ServerWebSocket<undefined>>();
  private server: { stop(force?: boolean): void } | null = null;

  constructor(opts: IngestOptions = {}) {
    this.opts = opts;
    this.engine = new HeadlessEngine(opts.engine ?? {});
    this.dispatcher = new CommandDispatcher(
      {
        engine: this.engine,
        isAuthorised: opts.isAuthorised,
        resolveCueRequest: opts.resolveCueRequest,
        playImaging: opts.playImaging,
      },
      // Cueing decodes on demand, so it must use the same settings and the same
      // analysis cache as the crate scan.
      {
        sampleRate: opts.engine?.sampleRate ?? 48000,
        cacheDir: opts.engine?.analysisCacheDir,
      },
    );
    this.icecast = new IcecastPoller(opts.icecast ?? {});
  }

  get streamStatus() {
    return this.icecast.status;
  }

  /** Push an event to every connected client. */
  broadcast(event: ServerEvent): void {
    const payload = JSON.stringify(event);
    for (const ws of this.sockets) {
      try {
        ws.send(payload);
      } catch {
        this.sockets.delete(ws);
      }
    }
  }

  private async submit(command: unknown, actor: Actor) {
    const envelope: CommandEnvelope = {
      id: crypto.randomUUID(),
      issuedAt: new Date().toISOString(),
      actor,
      command: command as never,
    };
    const result = await this.dispatcher.dispatch(envelope);
    this.broadcast({ type: "command.result", at: new Date().toISOString(), result });
    return result;
  }

  private authorised(req: Request): boolean {
    if (!this.opts.token) return true;
    return req.headers.get("authorization") === `Bearer ${this.opts.token}`;
  }

  private json(data: unknown, status = 200): Response {
    return new Response(JSON.stringify(data), {
      status,
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    });
  }

  async handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;

    // Reads are always open; mutations need the token.
    if (req.method === "GET" || req.method === "HEAD") {
      switch (path) {
        case "/health": {
          // "up" and "on air" are different claims. A caller that gets ok:true
          // here knows the process is listening; only ready:true means the
          // engine has a crate loaded and is actually broadcasting.
          const engine = this.engine.status;
          const ready = engine.state === "playing" || engine.state === "idle";
          const harbor = this.engine.harbor?.status ?? null;
          return this.json({
            ok: true,
            ready,
            engineState: engine.state,
            crateSize: engine.autopilot.crateSize,
            icecast: this.icecast.status?.icecast.reachable ?? false,
            onAir: engine.onAir !== null,
            /**
             * The engine -> Liquidsoap link, which nothing else exposes. Without
             * it, a station that renders audio but fails to publish looks
             * identical to one that is broadcasting.
             */
            harbor: harbor
              ? {
                  connected: harbor.connected,
                  bytesSent: harbor.bytesSent,
                  framesSent: harbor.framesSent,
                  connectedAt: harbor.connectedAt,
                  reconnects: harbor.reconnects,
                  nextRetryAtMs: harbor.nextRetryAtMs,
                  lastError: harbor.lastError,
                }
              : null,
          });
        }
        case "/status":
          return this.json({
            engine: this.engine.status,
            stream: this.icecast.status,
          });
        case "/stream":
          return this.json(this.icecast.status);
        case "/listeners/history":
          return this.json(this.history.all());
        case "/crate":
          return this.json(
            this.engine.library.map((t) => ({
              id: t.id,
              title: t.title,
              artist: t.artist,
              bpm: t.analysis?.bpm ?? null,
              key: t.analysis?.key ?? null,
            })),
          );
        default:
          break;
      }
    }

    if (req.method === "POST") {
      if (!this.authorised(req)) return this.json({ error: "unauthorized" }, 401);
      let body: { actor?: Actor; command?: unknown };
      try {
        body = (await req.json()) as typeof body;
      } catch {
        return this.json({ error: "body must be JSON" }, 400);
      }
      if (!body.command) return this.json({ error: "missing command" }, 400);
      if (!djCommandSchema.safeParse(body.command).success) {
        return this.json({ error: "command failed validation" }, 400);
      }
      const actor: Actor = body.actor ?? { id: "anonymous", role: "ops", label: "anonymous" };
      const result = await this.submit(body.command, actor);
      return this.json(result, result.ok ? 200 : 400);
    }

    return this.json({ error: "not found" }, 404);
  }

  /**
   * Start the HTTP + WebSocket listener.
   *
   * WebSocket clients get a ready frame, then every command result and stream
   * update, so the DJ console does not have to poll.
   */
  listen(port = this.opts.port ?? 8099, host = this.opts.host ?? "127.0.0.1") {
    const service = this;

    const server = Bun.serve({
      port,
      hostname: host,
      idleTimeout: 60,
      async fetch(req, srv) {
        if (new URL(req.url).pathname === "/ws") {
          const ok = srv.upgrade(req);
          return ok ? undefined : new Response("expected websocket", { status: 400 });
        }
        return service.handle(req);
      },
      websocket: {
        open(ws) {
          service.sockets.add(ws);
          ws.send(
            JSON.stringify({
              type: "connection.ready",
              at: new Date().toISOString(),
              actor: { id: "console", role: "console", label: "dj console" },
            } satisfies ServerEvent),
          );
          const stream = service.icecast.status;
          if (stream) {
            ws.send(
              JSON.stringify({
                type: "stream.status",
                at: new Date().toISOString(),
                status: stream,
              } satisfies ServerEvent),
            );
          }
        },
        close(ws) {
          service.sockets.delete(ws);
        },
        async message(ws, raw) {
          const frame = tryParse(raw);
          if (service.opts.token) {
            // The upgrade carries no request headers, so the token rides in
            // the frame itself.
            if (!frame || frame.token !== service.opts.token) {
              ws.send(
                JSON.stringify({
                  type: "command.result",
                  at: new Date().toISOString(),
                  result: { id: "ws", ok: false, appliedAt: new Date().toISOString(), code: "UNAUTHORIZED", error: "bad or missing token" },
                } satisfies ServerEvent),
              );
              return;
            }
          }
          if (!frame?.command) {
            ws.send(
              JSON.stringify({
                type: "command.result",
                at: new Date().toISOString(),
                result: { id: "ws", ok: false, appliedAt: new Date().toISOString(), code: "INVALID_PARAMS", error: "frame had no command" },
              } satisfies ServerEvent),
            );
            return;
          }
          const actor: Actor = {
            id: String(frame.actor?.id ?? "console"),
            role: "console",
            label: String(frame.actor?.label ?? "dj console"),
          };
          const result = await service.submit(frame.command, actor);
          ws.send(JSON.stringify({ type: "command.result", at: new Date().toISOString(), result } satisfies ServerEvent));
        },
      },
    });

    this.server = server as unknown as { stop(force?: boolean): void };
    return server;
  }

  /** Begin polling Icecast and feeding real listener counts to the engine. */
  startStreamPolling(): void {
    // "Ingest healthy" means audio is actually reaching Liquidsoap, which is
    // what the harbor's connection state reports. Deriving it from the engine
    // state string instead meant a poll taken while the engine was starting
    // claimed the station was off air for a whole interval after it was live.
    const isIngestHealthy = () => {
      const harbor = this.engine.harbor;
      if (harbor) return harbor.status.connected;
      // No harbor configured (tests, publish:false): fall back to engine state.
      const s = this.engine.status.state;
      return s !== "offline" && s !== "error";
    };

    this.icecast.start(isIngestHealthy, (status) => {
      const counts = listenerCountsFrom(status);
      this.engine.setListeners(counts);
      this.history.record(counts);
      this.broadcast({ type: "stream.status", at: new Date().toISOString(), status });
    });
  }

  async shutdown(): Promise<void> {
    this.icecast.stop();
    for (const ws of this.sockets) {
      try {
        ws.close();
      } catch {
        /* already gone */
      }
    }
    this.sockets.clear();
    this.server?.stop(true);
    await this.engine.close();
  }
}

function tryParse(raw: unknown): Record<string, any> | null {
  try {
    const v = JSON.parse(String(raw));
    return typeof v === "object" && v !== null ? v : null;
  } catch {
    return null;
  }
}

export { IcecastPoller, listenerCountsFrom, buildStreamStatus } from "./icecast";
export { CommandDispatcher } from "./commands";