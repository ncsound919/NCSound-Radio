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

import { COMMAND_TYPES } from "@ncsound/station-core";
import type {
  Actor,
  CommandEnvelope,
  CommandResult,
  DjCommand,
  LiveEvent,
  ServerEvent,
} from "@ncsound/station-core";
import { timingSafeEqual } from "node:crypto";
import { actorSchema, djCommandSchema } from "@ncsound/station-core/schema";
import { HeadlessEngine, type HeadlessEngineOptions } from "@ncsound/dj-engine";

import { CommandDispatcher, type DispatcherDeps } from "./commands";
import { createImagingPlayer, listImaging } from "./imaging";
import { RequestStore } from "./requests";
import type { BroadcastState } from "@ncsound/station-core";
import { CrateAudio } from "./crate-audio";
import { MountWatchdog } from "./mount-watchdog";
import { LiveBridge, LiveKeyStore, type LiveBridgeOptions } from "./live";
import { rolePermits } from "./permissions";
import { SessionStore, withinSlot, type Session, type SessionRole } from "./sessions";
import { AuditLog } from "./audit";
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
  /**
   * The live bridge (plan 5.2). Defaults are used when absent; `spawn` is
   * injectable so the console-live path can be driven end to end in tests.
   */
  live?: LiveBridgeOptions & { keyTtlMs?: number };
  /** Where host/guest sessions persist across restarts (default: memory only, or INGEST_SESSIONS_FILE). */
  sessionsFile?: string;
  /** Inject a store (tests use a fake clock). Overrides `sessionsFile`. */
  sessionStore?: SessionStore;
  /** Append-only audit trail path (default: INGEST_AUDIT_FILE; off when unset). */
  auditFile?: string;
};

/** What a host/guest session may GET. Everything else is the owner's. */
const SESSION_READS: Record<SessionRole, ReadonlySet<string>> = {
  guest: new Set(["/health", "/status", "/whoami", "/imaging"]),
  host: new Set(["/health", "/status", "/whoami", "/imaging", "/requests"]),
};

/** Who is calling: the owner (master token / local) or a minted session. */
export type Principal = { kind: "master" } | { kind: "session"; session: Session };
const principalId = (p: Principal) => (p.kind === "master" ? "master" : p.session.id);

/**
 * The role policy applied when a caller supplies no `isAuthorised`.
 *
 * Previously the hook was optional at both layers, so its absence meant every
 * actor could issue every command — the policy existed only as a comment. Roles
 * are still self-declared without a token, so this is a guard against
 * misconfigured clients rather than an auth boundary; the token is the boundary.
 */
export function defaultAuthorisation(actor: Actor, command: DjCommand): boolean {
  return rolePermits(actor.role, command.type);
}

/** How long a replayed envelope id returns its original result. */
const IDempotencyTTL_MS = 5 * 60_000;
  const IdempotencyMaxEntries = 1000;

  /**
   * How long the render tap may produce nothing before recovery re-primes it.
   *
   * Generous, because a brief block gap is normal across a track boundary. Too
   * tight and this re-attaches a healthy tap every few seconds; too loose and a
   * genuinely stalled pump leaves the station silent for minutes.
   */
  const RENDER_STALL_MS = 5000;

/** Loopback names/addresses that are safe to bind without a token. */
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

/** Attached to every upgraded socket so the live path can be routed. */
type LiveSocketData = {
  /** Set on a control socket once a session token has been presented on it. */
  sessionId?: string;
  live?: boolean;
  /** Closed by `/live/kill`; the close handler must not re-report it as a socket loss. */
  killed?: boolean;
  authed?: boolean;
  /** The upgrade request carried a valid `Authorization: Bearer` (or no token is configured). */
  tokenOk?: boolean;
};

/**
 * Headers a reverse proxy or tunnel adds. Cloudflare Tunnel (cloudflared)
 * connects to ingest FROM 127.0.0.1, so by peer address every remote request
 * through the tunnel looks local. Without this check a tunnel would expose the
 * control plane with no token (the `listen()` guard only looks at the bind
 * address) and serve crate audio and listener requests to the internet.
 * Spoofing one of these headers locally only makes a caller look remote,
 * which is stricter, never looser.
 */
const PROXY_HEADERS = ["cf-connecting-ip", "cf-ray", "x-forwarded-for", "x-real-ip", "forwarded"];

export function viaProxy(req: Request): boolean {
  return PROXY_HEADERS.some((h) => req.headers.has(h));
}

/**
 * Extra browser origins allowed to drive the control plane, comma-separated
 * (e.g. a console served on the LAN: `http://192.168.1.20:3102`).
 */
const EXTRA_ALLOWED_ORIGINS = new Set(
  (process.env.INGEST_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((o) => o.trim().replace(/\/$/, ""))
    .filter(Boolean),
);

/**
 * May a request carrying this `Origin` mutate the station?
 *
 * Binding to loopback stops other machines, not other web pages: any site open
 * in the operator's browser could POST to http://127.0.0.1:8137/command or
 * open ws://127.0.0.1:8137/ws (WebSockets ignore CORS), and with no token set
 * that was enough to drive transport and the mix. Browsers always send
 * `Origin` on cross-origin POSTs and on WebSocket handshakes, so:
 *
 *  - no Origin           -> not a browser (station-web server, scripts): allowed
 *  - loopback Origin     -> the local console (also via its Vite proxy): allowed
 *  - listed Origin       -> INGEST_ALLOWED_ORIGINS: allowed
 *  - anything else       -> a foreign page: refused, token or not
 */
export function originAllowed(origin: string | null): boolean {
  if (origin === null) return true;
  if (origin === "null") return false; // sandboxed iframes, file://, data:
  if (EXTRA_ALLOWED_ORIGINS.has(origin.replace(/\/$/, ""))) return true;
  try {
    const host = new URL(origin).hostname.replace(/^\[|\]$/g, "");
    return LOOPBACK_HOSTS.has(host) || host.startsWith("127.");
  } catch {
    return false;
  }
}

/** Constant-time string compare; length mismatch fails without early exit on content. */
function tokenMatches(presented: unknown, expected: string): boolean {
  if (typeof presented !== "string") return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export class IngestService {
  readonly engine: HeadlessEngine;
  readonly dispatcher: CommandDispatcher;
  readonly icecast: IcecastPoller;
  /** Delivery-path watchdog. Absent until `attachWatchdog` is called. */
  private watchdog: MountWatchdog | null = null;

  /** Whether the engine's upload is feeding Liquidsoap, or null if unknown. */
  private lastHarborSource: { onAir: boolean | null; error: string | null } | null = null;
  /** Timer for the Liquidsoap source-state poll. */
  private harborSourceTimer: ReturnType<typeof setInterval> | null = null;
  readonly history = new ListenerHistory();
  readonly requestStore: RequestStore = new RequestStore();
  readonly crateAudio: CrateAudio;

  /** The console-live bridge (plan 5.2). */
  readonly live: LiveBridge;
  /** One-time keys minted at `/live/arm` and redeemed on the audio socket. */
  private readonly liveKeys: LiveKeyStore;
  private liveArmedExpiresAt: string | null = null;
  /** Host/guest credentials. The master token is separate (`opts.token`). */
  readonly sessions: SessionStore;
  readonly audit: AuditLog;
  /** Who the outstanding live key was issued to; only they may redeem it. */
  private liveKeyOwner: string | null = null;
  /** Who currently holds the encoder ("master" or a session id). */
  private liveOwnerId: string | null = null;
  /** The authed audio socket, so `/live/kill` can close it. */
  private liveSocket: Bun.ServerWebSocket<LiveSocketData> | null = null;
  /** `/live/arm` is refused until this wall-clock time (set by `/live/kill`). */
  private liveLockedUntilMs = 0;
  /** Polls Liquidsoap to learn when our live source actually won the mount. */
  private liveSourceTimer: ReturnType<typeof setInterval> | null = null;
  /** Drops a live session whose credential expired or was revoked. */
  private sessionTimer: ReturnType<typeof setInterval> | null = null;

  private readonly opts: IngestOptions;
  /** Set by attachImaging; listed at GET /imaging for the console's pads. */
  private imagingDir: string | null = null;
  /** Held by reference: the dispatcher reads `deps.playImaging` per call. */
  private readonly deps: DispatcherDeps;
  private readonly sockets = new Set<Bun.ServerWebSocket<LiveSocketData>>();
  /** Envelope id -> stored result, for replay protection. */
  private readonly seen = new Map<string, { at: number; result: CommandResult }>();
  /**
   * Retained so isLoopbackCall can ask who actually connected. The
   * 
equestIP member is not optional: without it the crate-audio route
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

    this.liveKeys = new LiveKeyStore({ ttlMs: opts.live?.keyTtlMs });
    this.sessions = opts.sessionStore ?? new SessionStore({ filePath: opts.sessionsFile ?? process.env.INGEST_SESSIONS_FILE });
    this.audit = new AuditLog(opts.auditFile);
    // Events are pushed to every control socket, so the console learns that the
    // mount confirmed (or dropped) a live session without polling.
    this.live = new LiveBridge({ ...opts.live, onEvent: (e: LiveEvent) => this.broadcast(e) });
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
    this.imagingDir = dir;
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
     * 0a. Is the engine actually uploading?
     *
     * The observed fault: the engine rendered fine (`renderStallMs` under 50ms,
     * master bus metering normally) and Liquidsoap sat at
     * `Not ready: need more buffering (0/529200)` — the harbor upload was dead, so
     * its startup buffer never filled and every rendered block went nowhere.
     * Re-asserting the switch and rolling a deck both "succeed" and change nothing.
     */
    const harbor = this.engine.harbor?.status;
    if (harbor && !harbor.connected) {
      // The publisher owns its own backoff and reconnect, so the honest action is
      // to report the fault rather than force a second upload over the top.
      steps.push(
        `the harbor upload is not connected (${harbor.lastError ?? "no error recorded"}); ` +
          `the publisher is retrying on its own backoff`,
      );
    }

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

    /**
     * 1. Is the engine still rendering?
     *
     * Checked first because it decides which fault this is. If the engine is
     * producing steadily and the mount is silent, nothing below can help: the
     * break is in the upload, not in playback, sequencing or the output switch.
     */
    const stall = this.engine.renderStallMs;
    const engineProducing = !Number.isFinite(stall) || stall < RENDER_STALL_MS;
    if (engineProducing) {
      const reconnected = await this.engine.reconnectHarbor();
      steps.push(
        reconnected
          ? "engine was producing but the mount was silent: re-opened the harbor upload"
          : "engine was producing but the mount was silent: the harbor upload could not be re-opened",
      );
      // Give the new upload time to fill harbor's startup buffer before the
      // verification measurement decides whether this worked.
      await new Promise((r) => setTimeout(r, 4000));
      return { ok: reconnected, detail: steps.join("; ") };
    }
    steps.push(`the render pump itself has stalled (${Math.round(stall / 1000)}s with no block)`);

    // 2. The output switch is the cheapest thing to be wrong. An emergency stop
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
    if (viaProxy(req)) return false;
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

    /**
     * A detached render tap is the one fault that stops the upload with nothing
     * reporting it, so it is checked before anything that could mask it.
     */
    const stallMs = this.engine.renderStallMs;
    const pumpStalled = Number.isFinite(stallMs) && stallMs > RENDER_STALL_MS;

    const components = {
      enginePlaying: pumpStalled ? false : decks.length > 0 ? deckRolling : engine.onAir !== null,
      outputLive: outputLive === true,
      mountConnected: stream?.onAir === true,
    };

    if (pumpStalled) {
      return {
        onAir: false,
        reason: `the render pump has produced nothing for ${Math.round(stallMs / 1000)}s`,
        components,
      };
    }
    if (outputLive === null) {
      return {
        onAir: false,
        reason: 'Liquidsoap switch not configured — cannot confirm the output is live',
        components,
      };
    }
    /**
     * The engine can render perfectly and still not reach the daemon.
     *
     * `null` blocks too, not just `false`. Liquidsoap reports the source through
     * `input.harbor`'s connect/disconnect callbacks, and until that first poll has
     * landed the answer is genuinely unknown. Treating unknown as fine is how this
     * station claimed to be on air while the mount measured -91 dBFS: every
     * component looked right, because none of them was the broken one.
     */
    const source = this.lastHarborSource;
    if (!source || source.onAir !== true) {
      return {
        onAir: false,
        reason: source?.onAir === false
          ? 'the engine is not uploading to Liquidsoap (harbor reports no source connected)'
          : 'Liquidsoap has not reported whether the engine is connected yet',
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

  /** A valid bearer on the request, or no token configured at all. */
  bearerOk(req: Request): boolean {
    if (!this.opts.token) return true;
    return tokenMatches(req.headers.get("authorization"), `Bearer ${this.opts.token}`);
  }

  /**
   * Resolve a presented token to a caller: the master token is the owner, a
   * session token is a host/guest. Identity comes from the credential, never
   * from anything the client claims about itself.
   */
  resolveToken(presented: unknown): Principal | null {
    if (typeof presented !== "string" || !presented) return null;
    if (this.opts.token && tokenMatches(presented, this.opts.token)) return { kind: "master" };
    const session = this.sessions.verify(presented);
    return session ? { kind: "session", session } : null;
  }

  /** The caller of an HTTP request. No token configured: only local callers, as owner. */
  private principal(req: Request): Principal | null {
    if (!this.opts.token) return viaProxy(req) ? null : { kind: "master" };
    const h = req.headers.get("authorization");
    return this.resolveToken(h && h.startsWith("Bearer ") ? h.slice(7) : null);
  }

  private sessionActor(s: Session): Actor {
    return { id: s.id, role: s.role, label: s.label };
  }

  /** Drop whoever holds the encoder: kill the process, close their audio socket, clear ownership. */
  private dropLive(reason: string): boolean {
    const sock = this.liveSocket;
    this.liveSocket = null;
    this.liveOwnerId = null;
    this.liveKeyOwner = null;
    const killed = this.live.kill(reason);
    if (sock) {
      if (sock.data) sock.data.killed = true;
      try {
        sock.close(4410, reason.slice(0, 100));
      } catch {
        /* already closed */
      }
    }
    return killed;
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

    // Remote (tunnelled/proxied) callers need the token for everything, reads
    // included: /requests carries listener names and /status the station's
    // internals. Local reads stay open; mutations always need the token.
    const principal = this.principal(req);
    if (viaProxy(req) && path !== "/health" && !principal) {
      return this.json(
        { error: this.opts.token ? "unauthorized" : "remote access needs INGEST_TOKEN set on ingest" },
        401,
      );
    }
    // Guests and hosts get status, not the station's internals (/requests
    // carries listener names, /crate the library, /sessions the other people).
    if (principal?.kind === "session" && req.method !== "POST" && !SESSION_READS[principal.session.role].has(path)) {
      return this.json({ error: "forbidden" }, 403);
    }

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
          /**
           * Read the switch and the harbor source state.
           *
           * One session, not two: Liquidsoap's telnet server serves a single
           * client at a time, so a second connection queues behind the first and
           * the request waits it out. Asking together keeps this to one
           * round-trip, which is what `/status` needs to stay responsive — it is
           * polled by the booth, the site and the OBS overlay.
           */
          /**
           * The operator's on-air switch.
           *
           * One telnet read, as before. A second read for the harbor source state
           * made every `/status` take 17 seconds — Liquidsoap's telnet server
           * serves one client at a time, so the extra probe waited out a full
           * timeout. `/status` is polled by the booth, the site and the OBS
           * overlay, so it has to stay cheap; the harbor signal is read on its own
           * slower cadence instead (see the stream poller).
           */
          const station = this.deps.station
            ? await this.deps.station.onAir().catch((err: unknown) => ({
                onAir: null as boolean | null,
                error: err instanceof Error ? err.message : String(err),
              }))
            : { onAir: null as boolean | null, error: "no Liquidsoap control configured" };
          this.lastStationOnAir = station.onAir;
          // harborSource is polled on its own 5s cadence, never here: Liquidsoap
          // serves one telnet client at a time.

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
              explicit: t.explicit,
            })),
station,
            harborSource: this.lastHarborSource,
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
            /** Console-live state (plan 5.4): state changes only on Liquidsoap's word. */
            live: this.live.snapshot,
          });
        }
        case "/whoami": {
          if (!principal) return this.json({ error: "unauthorized" }, 401);
          if (principal.kind === "master") {
            return this.json({ kind: "master", role: "ops", label: "owner", canLive: true, expiresAt: null, commands: [...COMMAND_TYPES], reads: null });
          }
          const s = principal.session;
          return this.json({
            kind: "session",
            role: s.role,
            label: s.label,
            canLive: s.canLive,
            expiresAt: s.expiresAt,
            commands: COMMAND_TYPES.filter((t) => rolePermits(s.role, t)),
            reads: [...SESSION_READS[s.role]],
          });
        }
        case "/sessions":
          if (principal?.kind !== "master") return this.json({ error: "forbidden" }, 403);
          return this.json({ sessions: this.sessions.list() });
        case "/stream":
          return this.json(this.icecast.status);        case "/requests":
          // The DJ's request queue. Read straight from the station database so
          // it keeps working while Next.js restarts, and reports `reason` when
          // it cannot so the console can say "unavailable" rather than
          // "no requests" — the two are very different to a DJ waiting on a
          // listener.
          return this.json(this.listenerRequests(20));
        case "/imaging":
          // The jingle/sweeper ids the console can fire with `imaging.play`.
          return this.json(await listImaging(this.imagingDir));
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
      if (!originAllowed(req.headers.get("origin"))) {
        return this.json({ error: "origin not allowed" }, 403);
      }
      if (!principal) return this.json({ error: "unauthorized" }, 401);
      // Owner-only: break-glass and credential management.
      if (path === "/live/kill" || path === "/live/unlock" || path === "/sessions" || path === "/sessions/revoke") {
        if (principal.kind !== "master") return this.json({ error: "forbidden" }, 403);
      }

      // Arm a live session: mint the one-time key the audio socket redeems, and
      // refuse while another session holds the encoder.
      if (path === "/live/arm") {
        if (principal.kind === "session" && !principal.session.canLive) {
          return this.json({ ok: false, error: "this session may not go live" }, 403);
        }
        // A slot-bound credential may only arm inside its window. The end of the
        // slot is also the credential's expiry, so the air is dropped then too.
        if (principal.kind === "session" && !withinSlot(principal.session)) {
          return this.json(
            {
              ok: false,
              error: "outside this session's scheduled slot",
              notBefore: principal.session.notBefore,
              notAfter: principal.session.notAfter,
            },
            403,
          );
        }
        // After a kill, the console's auto-rejoin would otherwise retake the air
        // within seconds. Refuse until the lock expires or /live/unlock.
        if (Date.now() < this.liveLockedUntilMs) {
          return this.json(
            { ok: false, error: "live is locked by the operator", lockedUntil: new Date(this.liveLockedUntilMs).toISOString(), live: this.live.snapshot },
            423,
          );
        }
        if (!this.live.available) {
          return this.json(
            { ok: false, error: "a live session is already in progress", live: this.live.snapshot },
            409,
          );
        }
        // The bridge is not armed until the audio socket connects, so without
        // this an earlier arm holding an unused key would be overwritten and its
        // socket later rejected 4403 for no visible reason.
        if (this.liveKeys.armed) {
          return this.json(
            { ok: false, error: "a live key was already issued; use it or wait for it to expire", live: this.live.snapshot },
            409,
          );
        }
        const { key, expiresAt } = this.liveKeys.issue();
        this.liveKeyOwner = principalId(principal);
        this.liveArmedExpiresAt = expiresAt;
        this.audit.record("live.arm", principalId(principal), principal.kind === "master" ? "owner" : principal.session.role, {
          sessionId: principal.kind === "session" ? principal.session.id : "master",
        });
        return this.json({ ok: true, key, expiresAt, live: this.live.snapshot });
      }

      // Break-glass: drop whoever is live, revoke any unused key, close the
      // audio socket, and (by default) lock out re-arming for 10 minutes so the
      // console's auto-rejoin cannot undo it. Liquidsoap's fallback then carries
      // the mount. Idempotent: nothing live is still a 200 with killed:false.
      if (path === "/live/kill") {
        let lockSec = 600;
        let reason = "killed by operator";
        try {
          const b = (await req.json()) as { lockSec?: unknown; reason?: unknown };
          if (typeof b.lockSec === "number" && Number.isFinite(b.lockSec) && b.lockSec >= 0 && b.lockSec <= 86_400) {
            lockSec = b.lockSec;
          }
          if (typeof b.reason === "string" && b.reason.trim()) reason = `killed by operator: ${b.reason.trim().slice(0, 120)}`;
        } catch {
          /* body is optional */
        }
        const keyRevoked = this.liveKeys.armed;
        this.liveKeys.invalidate();
        const killed = this.dropLive(reason);
        this.liveLockedUntilMs = lockSec > 0 ? Date.now() + lockSec * 1000 : 0;
        console.warn(`[ingest] live.kill killed=${killed} keyRevoked=${keyRevoked} lockSec=${lockSec} reason="${reason}"`);
        this.audit.record("live.kill", principalId(principal), "owner", { killed, keyRevoked, lockSec, reason });
        return this.json({
          ok: true,
          killed,
          keyRevoked,
          lockedUntil: this.liveLockedUntilMs ? new Date(this.liveLockedUntilMs).toISOString() : null,
          live: this.live.snapshot,
        });
      }

      // Mint a host/guest credential. The token is returned once and never again.
      if (path === "/sessions") {
        if (!this.opts.token) return this.json({ error: "sessions require INGEST_TOKEN to be set" }, 400);
        let b: { role?: unknown; label?: unknown; ttlMin?: unknown; canLive?: unknown; notBefore?: unknown; notAfter?: unknown };
        try {
          b = (await req.json()) as typeof b;
        } catch {
          return this.json({ error: "body must be JSON" }, 400);
        }
        if (b.role !== "host" && b.role !== "guest") return this.json({ error: "role must be host or guest" }, 400);
        const label = typeof b.label === "string" ? b.label.trim() : "";
        if (!label || label.length > 60) return this.json({ error: "label is required (1-60 chars)" }, 400);
        const ttlMin = typeof b.ttlMin === "number" && Number.isFinite(b.ttlMin) ? b.ttlMin : 240;
        if (ttlMin < 1 || ttlMin > 1440) return this.json({ error: "ttlMin must be 1-1440" }, 400);
        // Optional slot window (ISO). A malformed value is a 400, not ignored.
        const parseIso = (v: unknown, name: string): { ok: true; value?: string } | { ok: false; error: string } => {
          if (v === undefined || v === null || v === "") return { ok: true };
          if (typeof v !== "string" || !Number.isFinite(Date.parse(v))) return { ok: false, error: `${name} must be an ISO timestamp` };
          return { ok: true, value: new Date(v).toISOString() };
        };
        const nb = parseIso(b.notBefore, "notBefore");
        if (!nb.ok) return this.json({ error: nb.error }, 400);
        const na = parseIso(b.notAfter, "notAfter");
        if (!na.ok) return this.json({ error: na.error }, 400);
        const { session, token } = this.sessions.issue({
          role: b.role as SessionRole,
          label,
          ttlMs: ttlMin * 60_000,
          canLive: b.canLive === false ? false : true,
          ...(nb.value ? { notBefore: nb.value } : {}),
          ...(na.value ? { notAfter: na.value } : {}),
        });
        console.warn(`[ingest] session.issue id=${session.id} role=${session.role} label="${session.label}" canLive=${session.canLive} expires=${session.expiresAt} slot=${session.notBefore ?? "-"}..${session.notAfter ?? "-"}`);
        this.audit.record("session.issue", principalId(principal), principal.kind === "master" ? "owner" : principal.session.role, {
          id: session.id,
          role: session.role,
          label: session.label,
          canLive: session.canLive,
          notBefore: session.notBefore,
          notAfter: session.notAfter,
        });
        return this.json({ ok: true, session, token });
      }

      if (path === "/sessions/revoke") {
        let b: { id?: unknown };
        try {
          b = (await req.json()) as typeof b;
        } catch {
          return this.json({ error: "body must be JSON" }, 400);
        }
        const id = typeof b.id === "string" ? b.id : "";
        const revoked = this.sessions.revoke(id);
        let killedLive = false;
        if (revoked) {
          if (this.liveOwnerId === id) killedLive = this.dropLive("session revoked");
          for (const ws of this.sockets) {
            if (ws.data?.sessionId === id) {
              try {
                ws.close(4401, "session revoked");
              } catch {
                /* already gone */
              }
            }
          }
        }
        console.warn(`[ingest] session.revoke id=${id} revoked=${revoked} killedLive=${killedLive}`);
        if (revoked) this.audit.record("session.revoke", principalId(principal), "owner", { id, killedLive });
        return this.json({ ok: revoked, killedLive }, revoked ? 200 : 404);
      }

      if (path === "/live/unlock") {
        this.liveLockedUntilMs = 0;
        return this.json({ ok: true, lockedUntil: null, live: this.live.snapshot });
      }

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
      // A session's identity is its credential. Whatever actor the body claims
      // is ignored, so a guest cannot send {role:"ops"} and be believed.
      const effectiveActor = principal.kind === "session" ? this.sessionActor(principal.session) : actor.data;
      const result = await this.submit(body.command, effectiveActor, id);
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
  listen(port = this.opts.port ?? 8137, host = this.opts.host ?? "127.0.0.1") {
    // Fail closed: an unauthenticated control plane is only tolerable on
    // loopback. Binding 0.0.0.0 without a token would expose transport, mix
    // and library commands to the network with no check at all.
    if (!this.opts.token && !LOOPBACK_HOSTS.has(host)) {
      throw new Error(
        `refusing to bind ${host}:${port} without INGEST_TOKEN: the control plane would be reachable without authentication`,
      );
    }
    const service = this;
    // Expiry must end an in-progress broadcast, not just refuse the next
    // request: a session that lapses while live would otherwise keep the air.
    this.sessionTimer = setInterval(() => {
      const id = this.liveOwnerId;
      if (id && id !== "master" && !this.sessions.isActive(id)) this.dropLive("session expired");
    }, 1000);
    (this.sessionTimer as unknown as { unref?: () => void }).unref?.();

    const server = Bun.serve<LiveSocketData>({
      port,
      hostname: host,
      idleTimeout: 60,
      async fetch(req, srv) {
        const path = new URL(req.url).pathname;
        // `/live` is the audio socket: Opus/WebM chunks from the console. It has
        // the same origin gate as control, plus a one-time key carried in the
        // first frame (see handleLiveFrame).
        if (path === "/live") {
          if (!originAllowed(req.headers.get("origin"))) {
            return new Response("origin not allowed", { status: 403 });
          }
          if (viaProxy(req) && !service.opts.token) {
            return new Response("remote access needs INGEST_TOKEN set on ingest", { status: 401 });
          }
          const ok = srv.upgrade(req, { data: { live: true, authed: false, tokenOk: service.bearerOk(req) } });
          return ok ? undefined : new Response("expected websocket", { status: 400 });
        }
        if (path === "/ws") {
          // WebSockets bypass CORS entirely; this is the only gate against a
          // foreign page in the operator's browser opening the control socket.
          if (!originAllowed(req.headers.get("origin"))) {
            return new Response("origin not allowed", { status: 403 });
          }
          if (viaProxy(req) && !service.opts.token) {
            return new Response("remote access needs INGEST_TOKEN set on ingest", { status: 401 });
          }
          const ok = srv.upgrade(req, { data: { tokenOk: service.bearerOk(req) } });
          return ok ? undefined : new Response("expected websocket", { status: 400 });
        }
        return service.handle(req);
      },
      websocket: {
        open(ws) {
          // An audio socket is not a control client: no banner, no broadcasts.
          if (ws.data?.live) return;
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
          if (ws.data?.live) {
            service.onLiveClose(ws);
            return;
          }
          service.sockets.delete(ws);
        },
        async message(ws, raw) {
          if (ws.data?.live) return service.handleLiveFrame(ws, raw);
          const frame = tryParse(raw);
          if (service.opts.token && !ws.data?.tokenOk) {
            // A browser can't set headers on a WebSocket upgrade, so a client
            // without a proxy presents the token in each frame. The console's
            // own server proxy adds `Authorization` to the upgrade instead,
            // which is how the token stays out of the browser (tokenOk).
            if (!frame || !service.resolveToken(frame.token)) {
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
          let sessionActor: Actor | null = null;
          if (service.opts.token && !ws.data?.tokenOk && frame) {
            const p = service.resolveToken(frame.token);
            if (p?.kind === "session") {
              sessionActor = service.sessionActor(p.session);
              if (ws.data) ws.data.sessionId = p.session.id;
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
            sessionActor ?? candidate.data,
            typeof frame.id === "string" ? frame.id : undefined,
          );
          ws.send(JSON.stringify({ type: "command.result", at: new Date().toISOString(), result } satisfies ServerEvent));
        },
      },
    });

    this.server = server as unknown as { stop(force?: boolean): void };
    return server;
  }

  /**
   * One frame from the live audio socket.
   *
   * Before auth, the only accepted frame is JSON `{ token, key }`; the key is
   * the one minted at `/live/arm` and is redeemed exactly once. After auth, a
   * text frame is a control message (`live.end`) and a binary frame is encoded
   * audio written straight to the encoder.
   */
  private handleLiveFrame(ws: Bun.ServerWebSocket<LiveSocketData>, raw: string | Uint8Array): void {
    const data = ws.data ?? {};
    if (!data.authed) {
      const frame = tryParse(raw);
      const caller: Principal | null = data.tokenOk ? { kind: "master" } : this.resolveToken(frame?.token);
      if (!caller) {
        ws.close(4401, "bad or missing token");
        return;
      }
      if (caller.kind === "session" && !caller.session.canLive) {
        ws.close(4403, "this session may not go live");
        return;
      }
      // The key belongs to whoever armed. Checked before redeeming so a wrong
      // user cannot burn someone else's key.
      if (this.liveKeyOwner !== null && this.liveKeyOwner !== principalId(caller)) {
        ws.close(4403, "live key was issued to another user");
        return;
      }
      if (!this.liveKeys.redeem(String(frame?.key ?? ""))) {
        ws.close(4403, "bad or expired live key");
        return;
      }
      data.authed = true;
      this.liveSocket = ws;
      this.liveOwnerId = principalId(caller);
      this.liveKeyOwner = null;
      const sessionId = crypto.randomUUID();
      try {
        this.live.arm({
          sessionId,
          expiresAt: this.liveArmedExpiresAt ?? new Date(Date.now() + 60_000).toISOString(),
        });
      } catch (err) {
        this.liveSocket = null;
        ws.close(4409, err instanceof Error ? err.message : "could not arm the encoder");
        return;
      }
      // Direct confirmation to the arming console; the bridge also broadcasts
      // live.armed to every control socket via its onEvent hook.
      ws.send(JSON.stringify({ type: "live.armed", at: new Date().toISOString(), sessionId, expiresAt: this.liveArmedExpiresAt ?? "" } satisfies ServerEvent));
      return;
    }

    if (typeof raw !== "string") {
      const bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw as ArrayBuffer);
      this.live.write(bytes);
      return;
    }

    const frame = tryParse(raw);
    if (frame?.type === "live.end") this.live.end();
  }

  /** The audio socket closed. A session that was still live is a loss. */
  private onLiveClose(ws: Bun.ServerWebSocket<LiveSocketData>): void {
    if (!ws.data?.authed || ws.data.killed) return;
    if (this.liveSocket === ws) {
      this.liveSocket = null;
      this.liveOwnerId = null;
    }
    if (this.live.state === "armed" || this.live.state === "on_air") {
      this.live.abort("live socket closed");
    }
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

      /**
       * Poll Liquidsoap for whether the engine's upload is connected.
     *
     * Deliberately here and not in `/status`: Liquidsoap's telnet server serves
     * one client at a time, so a second read inside a request path queues behind
     * the first and waits out its timeout. Measured: two reads in one request
     * took 17 seconds. One read per poll interval is cheap, and this is the only
     * consumer.
     */
    const readHarborSource = async () => {
      if (!this.deps.station?.harborSourceConnected) return;
      this.lastHarborSource = await this.deps.station.harborSourceConnected().catch((err: unknown) => ({
        onAir: null as boolean | null,
        error: err instanceof Error ? err.message : String(err),
      }));
    };
      void readHarborSource();
      this.harborSourceTimer = setInterval(() => void readHarborSource(), 5000);
      (this.harborSourceTimer as unknown as { unref?: () => void }).unref?.();

      /**
       * Learn whether our live source actually won the mount.
       *
       * "LIVE" is turned on by Liquidsoap, never by the operator's button: for
       * the first seconds after arm, ffmpeg is feeding harbor while autopilot is
       * still on the mount. And if the source disappears while the console still
       * thinks it is live, that is a broken feed, so the session is dropped
       * rather than left claiming air.
       */
      const readLiveSource = async () => {
        if (!this.deps.station?.liveHarborConnected) return;
        const s = await this.deps.station.liveHarborConnected().catch(() => ({
          onAir: null as boolean | null,
          error: "live source read failed",
        }));
        if (!s) return;
        if (s.onAir === true && this.live.state === "armed") this.live.markOnAir();
        else if (s.onAir === false && this.live.state === "on_air") {
          this.live.abort("Liquidsoap lost the live harbor source");
        }
      };
      // A 1 s tick: read Liquidsoap every tick while a session is armed or on
      // air, so LIVE lags it by about a second (it was up to 5 s, measured),
      // and every fifth tick otherwise. Ticking every second, rather than
      // rescheduling at 5 s, means a session that arms mid-wait is checked
      // within a second. One telnet `var.get` per second is negligible.
      let tick = 0;
      void readLiveSource();
      this.liveSourceTimer = setInterval(() => {
        tick++;
        const busy = this.live.state === "armed" || this.live.state === "on_air";
        if (busy || tick % 5 === 0) void readLiveSource();
      }, 1000);
      (this.liveSourceTimer as unknown as { unref?: () => void }).unref?.();
  }

  async shutdown(): Promise<void> {
    this.icecast.stop();
    if (this.harborSourceTimer) clearInterval(this.harborSourceTimer);
    if (this.liveSourceTimer) clearInterval(this.liveSourceTimer);
    if (this.sessionTimer) clearInterval(this.sessionTimer);
    this.live.dispose();
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