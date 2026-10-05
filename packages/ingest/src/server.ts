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

import type {
  Actor,
  CommandEnvelope,
  CommandResult,
  DjCommand,
  ServerEvent,
} from "@ncsound/station-core";
import { actorSchema, djCommandSchema } from "@ncsound/station-core/schema";
import { HeadlessEngine, type HeadlessEngineOptions } from "@ncsound/dj-engine";

import { CommandDispatcher, type DispatcherDeps } from "./commands";
import { createImagingPlayer } from "./imaging";
import { RequestStore } from "./requests";
import type { BroadcastState } from "@ncsound/station-core";
import { CrateAudio } from "./crate-audio";
import { MountWatchdog } from "./mount-watchdog";
import { materialize, type DecodedTrack } from "@ncsound/dj-engine";
import { IcecastPoller, ListenerHistory, listenerCountsFrom, type IcecastOptions } from "./icecast";

export type IngestOptions = {
  port?: number;
  host?: string;
  engine?: HeadlessEngineOptions;
  icecast?: IcecastOptions;
  /**
   * Bearer token required on mutating routes.
   *
   * Unset means open, which is only safe on loopback — `listen()` refuses to
   * bind a non-loopback host without a token rather than silently exposing the
   * control plane to the network.
   */
  token?: string;
  /**
   * Overrides the default role policy. Supplied by callers that need finer
   * rules; when absent, `defaultAuthorisation` applies instead of "allow all".
   */
  isAuthorised?: DispatcherDeps["isAuthorised"];
  resolveCueRequest?: DispatcherDeps["resolveCueRequest"];
  playImaging?: DispatcherDeps["playImaging"];
  /**
   * Liquidsoap on-air switch.
   *
   * Icecast reports the mount as connected even while the output is switched
   * to `blank()`, so `stream.onAir` alone cannot answer "is the station
   * broadcasting?". This can.
   */
  station?: DispatcherDeps["station"];
};

/**
 * The role policy applied when a caller supplies no `isAuthorised`.
 *
 * Previously the hook was optional at both layers, so its absence meant every
 * actor could issue every command — the policy existed only as a comment. Roles
 * are still self-declared without a token, so this is a guard against
 * misconfigured clients rather than an auth boundary; the token is the boundary.
 */
export function defaultAuthorisation(actor: Actor, command: DjCommand): boolean {
  if (command.type.startsWith("query.")) return true;
  return actor.role === "ops" || actor.role === "console";
}

/** How long a replayed envelope id returns its original result. */
const IDempotencyTTL_MS = 5 * 60_000;
const IdempotencyMaxEntries = 1000;

/** Loopback names/addresses that are safe to bind without a token. */
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

export class IngestService {
  readonly engine: HeadlessEngine;
  readonly dispatcher: CommandDispatcher;
  readonly icecast: IcecastPoller;
  /** Delivery-path watchdog. Absent until `attachWatchdog` is called. */
  private watchdog: MountWatchdog | null = null;
  readonly history = new ListenerHistory();
  readonly requestStore: RequestStore = new RequestStore();
  readonly crateAudio: CrateAudio;

  private readonly opts: IngestOptions;
  /** Held by reference: the dispatcher reads `deps.playImaging` per call. */
  private readonly deps: DispatcherDeps;
  private readonly sockets = new Set<Bun.ServerWebSocket<undefined>>();
  /** Envelope id -> stored result, for replay protection. */
  private readonly seen = new Map<string, { at: number; result: CommandResult }>();
  /**
   * Retained so isLoopbackCall can ask who actually connected. The
   * equestIP member is not optional: without it the crate-audio route
   * cannot distinguish local from remote and has to refuse everything.
   */
  private server: {
    stop(force?: boolean): void;
    requestIP?: (req: Request) => { address: string; port: number } | null;
  } | null = null;

  constructor(opts: IngestOptions = {}) {
    this.opts = opts;
    this.engine = new HeadlessEngine(opts.engine ?? {});
    this.deps = {
      engine: this.engine,
      // Never leave this undefined: an absent hook read as "authorise
      // everything", which is how an unauthenticated POST could act as ops.
      isAuthorised: opts.isAuthorised ?? defaultAuthorisation,
      resolveCueRequest: opts.resolveCueRequest ?? this.defaultCueRequest,
      playImaging: opts.playImaging,
      station: opts.station,
    };
    this.dispatcher = new CommandDispatcher(
      this.deps,
      // Cueing decodes on demand, so it must use the same settings and the same
      // analysis cache as the crate scan.
      {
        sampleRate: opts.engine?.sampleRate ?? 48000,
        cacheDir: opts.engine?.analysisCacheDir,
      },
    );
    this.icecast = new IcecastPoller(opts.icecast ?? {});
    // Same decode settings as the crate scan, or the on-demand cache is wasted.
    this.crateAudio = new CrateAudio({
      // A getter, not the array: `engine.start()` replaces `engine.library`
      // with the scanned crate, so capturing it here would hold the empty
      // array the engine booted with.
      library: () => this.engine.library,
      decode: {
        sampleRate: opts.engine?.sampleRate ?? 48000,
        cacheDir: opts.engine?.analysisCacheDir,
      },
      context: this.engine.audioContext,
      logger: (m) => console.warn(`[ingest] ${m}`),
    });
  }

  /**
   * Resolve a listener's request to a crate track.
   *
   * The dispatcher required this hook and the service never supplied one, so
   * `cue.request` always answered `NO_SUCH_REQUEST`. Reads the station database
   * directly; returns null — never a guess — when the request is unknown, the
   * station database is absent, or the requested track is not in the crate.
   */
  private readonly defaultCueRequest = (requestId: string): string | null => {
    return this.requestStore.resolveToCrateId(
      requestId,
      this.engine.library.map((t) => ({ id: t.id, title: t.title, artist: t.artist })),
    );
  };

  /** Newest listener requests, newest first. Empty when unavailable. */
  listenerRequests(limit = 20): { requests: ReturnType<RequestStore["recent"]>; reason: string | null } {
    return {
      requests: this.requestStore.recent(limit),
      reason: this.requestStore.unavailableReason,
    };
  }

  /**
   * Attach the station imaging library.
   *
   * Post-construction because the player needs the engine this service just
   * built, and the engine cannot be referenced from the constructor's own
   * argument list. Until this is called, `imaging.play` reports the absence of
   * an imaging library rather than pretending to succeed.
   */
  attachImaging(dir: string): void {
    this.deps.playImaging = createImagingPlayer({
      engine: this.engine,
      dir,
      decode: {
        sampleRate: this.opts.engine?.sampleRate ?? 48000,
        cacheDir: this.opts.engine?.analysisCacheDir,
      },
    });
  }

  get streamStatus() {
    return this.icecast.status;
  }

  /**
   * Attempt to restore the broadcast after the watchdog measured silence.
   *
   * Ordered from cheapest and most likely to the most invasive, and it stops at
   * the first step that succeeds. Each step is the same code path an operator
   * would use by hand, so recovery cannot produce a state the console could not
   * have produced deliberately.
   */
  private async recoverBroadcast(reason: string): Promise<{ ok: boolean; detail: string }> {
    const steps: string[] = [];

    /**
     * 0. Is the engine producing audio at all?
     *
     * Checked first because it is the only fault that no other step can fix. A
     * stalled render tap was observed live: the deck read "playing", the master
     * bus metered around -11 dBFS, `state` said "playing" — and the mount carried
     * -91 dBFS for as long as it was left alone. Re-asserting the switch and
     * rolling a deck both report success and change nothing, because the thing
     * that publishes to harbor is the part that is broken.
     */
    const stallMs = this.engine.renderStallMs;
    if (Number.isFinite(stallMs) && stallMs > RENDER_STALL_MS) {
      const reprimed = this.engine.reprimeRenderTap();
      steps.push(
        reprimed
          ? `render pump had produced nothing for ${Math.round(stallMs / 1000)}s; re-attached the tap to the master bus`
          : `render pump stalled for ${Math.round(stallMs / 1000)}s and could not be re-primed`,
      );
    }

    // 1. The output switch is the cheapest thing to be wrong. An emergency stop
    //    or a crash can leave it off while the engine is perfectly willing.
    const station = this.deps.station;
    const live = station ? await station.onAir().catch(() => null) : null;
    if (live && !live.onAir) {
      await station?.setOnAir(true).catch((err: unknown) => {
        steps.push(`re-asserting the output switch failed: ${String(err)}`);
      });
      steps.push("re-asserted the Liquidsoap output switch");
    }

    // 2. Nothing cued. This is the state the five-hour outage ended in: the
    //    mixer was willing, but no deck had analysed audio, so `mixer.play()`
    //    refused and the command reported success anyway.
    //
    //    The sequencer is restored too, not just one deck. `autopilot.stop()`
    //    clears both its `enabled` flag and its now-playing record, so rolling a
    //    deck alone plays exactly one track and then the station is silent again
    //    — which is how this recurred more than once.
    const mixer = this.engine.mixer;
    const rolling = mixer.decks.some((d) => d.playing);
    if (!rolling) {
      if (!this.engine.autopilot.enabled) {
        const sequenced = await this.engine.autopilot.start();
        steps.push(
          sequenced
            ? "restarted the sequencer, which had been switched off"
            : "the sequencer is off and the crate is empty, so it could not restart",
        );
      } else {
        const cued = mixer.decks.find((d) => d.buffer && d.analysis);
        if (cued) {
          const started = mixer.play();
          steps.push(started ? "rolled the cued deck" : "the cued deck refused to play");
        } else {
          const track = this.engine.library[0];
          if (!track) {
            steps.push("the crate is empty, so there is nothing to roll");
          } else {
            const loaded = await this.loadCrateTrack(track, this.audibleSlot());
            const started = loaded.ok ? mixer.play() : false;
            steps.push(
              started
                ? `loaded and rolled "${track.title}" (${loaded.detail})`
                : `could not roll "${track.title}": ${loaded.detail}`,
            );
          }
        }
      }
    }

    // 3. The engine is rendering but the mount is still silent, so the fault is
    //    downstream of the engine: harbor, Liquidsoap or Icecast. Restarting the
    //    engine is not a safe move from inside the engine's own process, so say
    //    so plainly rather than pretending the ladder reached the end.
    const stillSilent = mixer.decks.every((d) => !d.playing);
    if (stillSilent) {
      steps.push("no deck is rolling after recovery — the fault is downstream of the engine");
    }

    return {
      ok: !stillSilent,
      detail: `${steps.join("; ")} (reason: ${reason})`,
    };
  }

  /** Load a crate track into a deck and decode it, mirroring `library.load`. */
  private async loadCrateTrack(
    track: DecodedTrack,
    slot: 0 | 1,
  ): Promise<{ ok: boolean; detail: string }> {
    try {
      const mixer = this.engine.mixer;
      if (!track.buffer) {
        await materialize(track, mixer.ctx, {
          sampleRate: this.opts.engine?.sampleRate ?? 48000,
          cacheDir: this.opts.engine?.analysisCacheDir,
        });
      }
      if (!track.buffer) return { ok: false, detail: "decode produced no audio" };
      const analysis = mixer.loadBuffer(slot, track.buffer, track.analysis ?? undefined);
      return { ok: true, detail: `${analysis.bpm.toFixed(1)} bpm` };
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
  }

  private audibleSlot(): 0 | 1 {
    return this.engine.mixer.info()?.deck === 1 ? 0 : 1;
  }

  /**
   * Measure the mount and recover if the station is meant to be audible and is
   * not. Enabled by default; `NCSOUND_WATCHDOG=0` turns it off.
   */
  attachWatchdog(opts: { mountUrl: string }): void {
    const enabled = process.env.NCSOUND_WATCHDOG !== "0";
    this.watchdog = new MountWatchdog({
      mountUrl: opts.mountUrl,
      enabled,
      intervalSec: Number(process.env.NCSOUND_WATCHDOG_INTERVAL ?? 30),
      silentSamplesBeforeRecovery: Number(process.env.NCSOUND_WATCHDOG_STREAK ?? 3),
      recover: (reason) => this.recoverBroadcast(reason),
      // Deliberate silence must stay silent. Reading the operator's stated
      // intent is what separates "the station broke" from "the DJ stopped it".
      operatorIntent: () => (this.deps.station ? (this.deps.station.desiredOnAir ?? null) : null),
      log: (message) => console.warn(`[watchdog] ${message}`),
    });
    this.watchdog.start();
  }

  get watchdogStatus() {
    return this.watchdog?.status ?? null;
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

  /**
   * Dispatch a command, honouring a client-supplied envelope id.
   *
   * Replaying the same id returns the stored result instead of running the
   * command twice — that is the correlation/replay behaviour the contract
   * promises. Without this, every id was minted server-side and a retried
   * request was indistinguishable from a new one.
   */
  private async submit(command: unknown, actor: Actor, id?: string): Promise<CommandResult> {
    const envelopeId = id && id.length > 0 && id.length <= 128 ? id : crypto.randomUUID();

    const replay = this.seen.get(envelopeId);
    if (replay) return replay.result;

    const envelope: CommandEnvelope = {
      id: envelopeId,
      issuedAt: new Date().toISOString(),
      actor,
      command: command as never,
    };
    const result = await this.dispatcher.dispatch(envelope);
    this.remember(envelopeId, result);
    this.broadcast({ type: "command.result", at: new Date().toISOString(), result });
    return result;
  }

  /** Store a completed envelope, pruning anything older than the TTL. */
  private remember(id: string, result: CommandResult): void {
    const now = Date.now();
    for (const [key, entry] of this.seen) {
      if (now - entry.at > IDempotencyTTL_MS) this.seen.delete(key);
    }
    // Bound the map independently of the TTL so a flood of unique ids cannot
    // grow it without limit.
    if (this.seen.size >= IdempotencyMaxEntries) {
      const oldest = this.seen.keys().next().value;
      if (oldest !== undefined) this.seen.delete(oldest);
    }
    this.seen.set(id, { at: now, result });
  }

  /**
   * True when the request arrived over loopback.
   *
   * `::ffff:127.0.0.1` is how IPv4 shows up on a dual-stack socket, so it has
   * to be recognised too — otherwise every crate-audio request from a browser
   * on this machine reads as remote and is refused.
   */
  private isLoopbackCall(req: Request): boolean {
    const ip = this.server?.requestIP?.(req)?.address;
    if (!ip) {
      // No address available (in-process handler, or a runtime that does not
      // report it). Fail closed: this route hands out audio files.
      return false;
    }
    return LOOPBACK_HOSTS.has(ip) || ip === "::ffff:127.0.0.1" || ip.startsWith("127.");
  }

  /**
   * Last known Liquidsoap switch position.
   *
   * Read on the `/status` poll and reused by `/health`, so the health check
   * never blocks on a telnet round trip.
   */
  private lastStationOnAir: boolean | null = null;

  /**
   * The single on-air answer, for every surface.
   *
   * Three inputs, all of which must hold: the engine is rendering audio, the
   * operator has not switched Liquidsoap to silence, and Icecast has a source
   * connected. Two of the three surfaces used to compute this themselves from
   * different subsets and disagreed exactly when it mattered — the listener
   * site kept reporting "live" after the station was taken off air, because
   * `transport.stop` does not change the engine's state string.
   *
   * `reason` matters as much as the boolean: "off air" and "the engine is
   * stopped" are different faults with different fixes, and an operator who
   * cannot tell them apart will debug the wrong thing.
   */
  private broadcastState(): BroadcastState {
    const engine = this.engine.status;
    const stream = this.icecast.status;
    const outputLive = this.deps.station ? this.lastStationOnAir : null;

    /**
     * "Is the engine producing audio", observed rather than remembered.
     *
     * `engine.onAir` is built from the autopilot's now-playing record, which a
     * manual `transport.play` never sets: the deck rolls, audio reaches the
     * mount, and the verdict still said "engine has no audio armed" while the
     * station was transmitting at -13 dBFS. Trusting that field produced a false
     * OFF AIR during live verification.
     *
     * The per-deck `playing` flags are the observation. `onAir` is kept as a
     * fallback because it is what the engine reports when telemetry is absent.
     */
    const decks = engine.telemetry?.decks ?? [];
    const deckRolling = decks.length > 0 && decks.some((d) => d.playing === true);

    const components = {
      enginePlaying: decks.length > 0 ? deckRolling : engine.onAir !== null,
      outputLive: outputLive === true,
      mountConnected: stream?.onAir === true,
    };

    if (outputLive === null) {
      return {
        onAir: false,
        reason: 'Liquidsoap switch not configured — cannot confirm the output is live',
        components,
      };
    }
    if (!components.enginePlaying) {
      return { onAir: false, reason: 'engine has no audio armed', components };
    }
    if (!components.outputLive) {
      return { onAir: false, reason: 'output switched off air by the operator', components };
    }
    if (!components.mountConnected) {
      return { onAir: false, reason: 'Icecast has no connected source on the mount', components };
    }
    return { onAir: true, reason: '', components };
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
            onAir: this.broadcastState().onAir,
            /** Same answer as /status, so health and status cannot disagree. */
            broadcastReason: this.broadcastState().reason,
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
        case "/status": {
          /**
           * Read the Liquidsoap switch first and cache it, so `broadcastState`
           * reports THIS reading rather than the previous poll's. Getting that
           * ordering wrong would make `/status` self-inconsistent for one
           * request after any change.
           *
           * Read on demand rather than from the poller: a human can flip it
           * over telnet, and it outlives a restart via the persisted switch.
           */
          const station = this.deps.station
            ? await this.deps.station.onAir().catch((err: unknown) => ({
                onAir: null as boolean | null,
                error: err instanceof Error ? err.message : String(err),
              }))
            : { onAir: null as boolean | null, error: "no Liquidsoap control configured" };
          this.lastStationOnAir = station.onAir;

          return this.json({
            engine: this.engine.status,
            stream: this.icecast.status,
            /**
             * What the engine has cued after the current track.
             *
             * The OBS overlay needs this to show a real UP NEXT, and it has to
             * come from the engine: the booth's queue is a rehearsal list and
             * routinely differs from what will actually air.
             */
            queue: this.engine.upNext.map((t) => ({
              id: t.id,
              title: t.title,
              artist: t.artist,
              durationSec: t.durationSec,
              bpm: t.bpm,
              playlist: t.playlist,
              rightsId: t.rightsId,
              explicit: t.explicit,
            })),
station,
            /**
             * What the delivery path is actually carrying.
             *
             * `broadcast` says whether the station is *meant* to be audible.
             * This says whether it *is*. They disagree exactly when something
             * between the engine and the listener is broken, which is the case
             * no other field could see.
             */
            watchdog: this.watchdogStatus,
            /**
             * THE on-air answer. Every surface reads this rather than deriving
             * its own, because two of them used to and they disagreed.
             */
            broadcast: this.broadcastState(),
          });
        }
        case "/stream":
          return this.json(this.icecast.status);        case "/requests":
          // The DJ's request queue. Read straight from the station database so
          // it keeps working while Next.js restarts, and reports `reason` when
          // it cannot so the console can say "unavailable" rather than
          // "no requests" — the two are very different to a DJ waiting on a
          // listener.
          return this.json(this.listenerRequests(20));
        case "/listeners/history":
          return this.json(this.history.all());
        case "/crate":
          // durationSec and album are included because the station site's
          // `Track` model requires them, and a library sync that had to invent
          // a duration would be writing fiction into the one table whose whole
          // purpose is to be factual about what can be broadcast.
          return this.json(
            this.engine.library.map((t) => ({
              id: t.id,
              title: t.title,
              artist: t.artist,
              album: t.album ?? null,
              durationSec: Math.round(t.durationSec ?? 0),
              bpm: t.analysis?.bpm ?? null,
              key: t.analysis?.key ?? null,
              path: t.path,
            })),
          );
        default:
          break;
      }

      // /crate/audio/<id>.wav — the booth's only route to station audio.
      // Outside the JSON switch above because it returns bytes, and it is the
      // one read path that decodes on demand.
      const audio = /^\/crate\/audio\/([^/]+)\.wav$/.exec(path);
      if (audio) {
        // Loopback only, enforced per request rather than by bind address.
        //
        // The engine refuses to bind a non-loopback host without a token, so
        // in principle the bind is the boundary. But this route hands out
        // audio files and ingest can legitimately be bound wider (a DJ on the
        // LAN), and a bearer token is not an option here — the caller is a
        // browser, and the console is built so no control-plane secret is ever
        // shipped to the client. So the check is made where it can be enforced.
        if (!this.isLoopbackCall(req)) {
          return this.json(
            { error: "crate audio is served to loopback callers only" },
            403,
          );
        }
        const id = decodeURIComponent(audio[1]!);
        const result = await this.crateAudio.wav(id);
        if (!result) {
          // 404 covers both "not in the crate" and "could not decode". The
          // distinction is in the body, because the console says different
          // things for each and an operator needs to know which happened.
          const known = this.engine.library.some((t) => t.id === id);
          return new Response(
            JSON.stringify({
              error: known
                ? `could not decode "${id}" — the file may be unreadable or an unsupported format`
                : `"${id}" is not in the engine crate`,
            }),
            { status: 404, headers: { "content-type": "application/json" } },
          );
        }
        return new Response(result.wav as unknown as BodyInit, {
          headers: {
            "content-type": result.mime,
            "content-length": String(result.wav.byteLength),
            "cache-control": "private, max-age=300",
          },
        });
      }
    }

    if (req.method === "POST") {
      if (!this.authorised(req)) return this.json({ error: "unauthorized" }, 401);
      let body: { id?: unknown; actor?: unknown; command?: unknown };
      try {
        body = (await req.json()) as typeof body;
      } catch {
        return this.json({ error: "body must be JSON" }, 400);
      }
      if (!body.command) return this.json({ error: "missing command" }, 400);
      if (!djCommandSchema.safeParse(body.command).success) {
        return this.json({ error: "command failed validation" }, 400);
      }
      // The actor is required and schema-checked. It used to fall back to
      // `{role:"ops"}`, so an unauthenticated POST silently claimed the
      // highest-privilege role.
      const actor = actorSchema.safeParse(body.actor);
      if (!actor.success) {
        return this.json(
          { error: "actor is required and must match {id, role, label}" },
          400,
        );
      }
      const id = typeof body.id === "string" ? body.id : undefined;
      const result = await this.submit(body.command, actor.data, id);
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
    // Fail closed: an unauthenticated control plane is only tolerable on
    // loopback. Binding 0.0.0.0 without a token would expose transport, mix
    // and library commands to the network with no check at all.
    if (!this.opts.token && !LOOPBACK_HOSTS.has(host)) {
      throw new Error(
        `refusing to bind ${host}:${port} without INGEST_TOKEN: the control plane would be reachable without authentication`,
      );
    }
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
          // A WebSocket connection is the console, whatever the frame claims.
          // id/label are still schema-checked so a long string cannot slip
          // through the actor contract.
          const candidate = actorSchema.safeParse({
            id: String(frame.actor?.id ?? "console"),
            role: "console",
            label: String(frame.actor?.label ?? "dj console"),
          });
          if (!candidate.success) {
            ws.send(
              JSON.stringify({
                type: "command.result",
                at: new Date().toISOString(),
                result: {
                  id: typeof frame.id === "string" ? frame.id : "ws",
                  ok: false,
                  appliedAt: new Date().toISOString(),
                  code: "INVALID_PARAMS",
                  error: "actor failed validation",
                },
              } satisfies ServerEvent),
            );
            return;
          }
          const result = await service.submit(
            frame.command,
            candidate.data,
            typeof frame.id === "string" ? frame.id : undefined,
          );
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
    // Windows holds a lock on the SQLite file while a handle is open, which
    // blocks the station app from migrating or vacuuming it.
    this.requestStore.close();
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