/**
 * The console's single door to the engine.
 *
 * `controlLink` is the transport; this is the policy layer the UI talks to:
 * what to do about continuous controls that would otherwise flood the socket,
 * what to tell the operator when the engine says no, and — most importantly —
 * which mode the console is actually in.
 *
 * Before this existed the console had exactly two states: a local boolean
 * called ON AIR, and everything else. A control that only changed the browser
 * graph and a control that reached the engine were indistinguishable from the
 * operator's side, which is the failure this module exists to prevent.
 */

import { ControlLink, type ControlState } from "./controlLink";
import type { CommandResult, DjCommand } from "@ncsound/station-core/contract";
import type { BroadcastStatus } from "./broadcastLink";

export type ConsoleMode = {
  kind: "on-air" | "engine" | "rehearsal";
  /** Short label for the badge. */
  label: string;
  /** One line explaining what the controls are connected to right now. */
  detail: string;
  /** True when a control press reaches the engine, not just the booth graph. */
  drivesEngine: boolean;
};

const MODE_ON_AIR: ConsoleMode = {
  kind: "on-air",
  label: "ON AIR (engine)",
  detail: "Controls reach the engine that is feeding the stream.",
  drivesEngine: true,
};

const MODE_ENGINE: ConsoleMode = {
  kind: "engine",
  label: "ENGINE (not on air)",
  detail: "Connected to the engine; the stream itself is off air.",
  drivesEngine: true,
};

const MODE_REHEARSAL: ConsoleMode = {
  kind: "rehearsal",
  label: "REHEARSAL (local)",
  detail: "Engine unreachable — controls move the booth graph only and never reach the stream.",
  drivesEngine: false,
};

/**
 * Coalescing key: one slot per control, not one per command type.
 *
 * Per-slot commands must be keyed per slot. Keying `cue.seek` on its type alone
 * meant deck A's jog and deck B's jog shared one slot, so the second was
 * silently discarded and only one deck ever moved.
 */
function keyFor(command: DjCommand): string {
  switch (command.type) {
    case "mix.setEq":
      return `${command.type}:${command.slot}:${command.band}`;
    case "mix.setDeckVolume":
    case "mix.setFilter":
      return `${command.type}:${command.slot}`;
    case "cue.seek":
    case "cue.hotCue":
    case "cue.loop":
    case "sync.deck":
      return `${command.type}:${command.slot ?? "auto"}`;
    default:
      return command.type;
  }
}

export type RefusalHandler = (message: string, command: DjCommand, result: CommandResult) => void;

export class ControlBus {
  readonly link: ControlLink;

  /** Set by the UI to surface a refusal. */
  onRefusal: RefusalHandler | null = null;

  /** Freshness from `GET /status`, which works even when the socket does not. */
  private stationReachable = false;
  /**
   * Whether a full status reading has arrived at all.
   *
   * Without this the mode could never leave REHEARSAL before the first poll,
   * and — more importantly — a completed handshake would outvote a *fresh*
   * report that the engine is gone. The socket proves the engine answered once;
   * the poll says whether it answers now. The newer, more complete observation
   * wins, so the badge follows the poll once it has spoken.
   */
  private stationSeen = false;
  private stationOnAir: boolean | null = null;
  /** Streams the latest `stream.status` push, or null before the first one. */
  private engineStream: ControlState["stream"] = null;

  /** Latest value per control awaiting an idle transport. */
  private pending = new Map<string, DjCommand>();
  /** Controls with a send in flight, so they are not re-sent concurrently. */
  private inflight = new Set<string>();
  private modeListeners = new Set<(m: ConsoleMode) => void>();
  private currentMode: ConsoleMode = MODE_REHEARSAL;
  /** Refusals reported in the last second, so a broken command cannot spam. */
  private lastRefusalAt = 0;

  constructor(options: ConstructorParameters<typeof ControlLink>[0] = {}) {
    this.link = new ControlLink(options);
  }

  start(): void {
    this.link.subscribe((s) => {
      this.engineStream = s.stream;
      this.emitMode();
    });
    this.link.start();
  }

  stop(): void {
    this.link.stop();
  }

  /**
   * Fold in what the HTTP poll knows.
   *
   * The control link only proves reachability when a command is sent, so a
   * console that has just opened would otherwise read REHEARSAL during a
   * perfectly healthy session.
   */
  observeStation(status: { reachable: boolean; onAir: boolean | null }): void {
    this.stationReachable = status.reachable;
    this.stationSeen = true;
    this.stationOnAir = status.onAir;
    this.emitMode();
  }

  mode(): ConsoleMode {
    return this.currentMode;
  }

  onModeChange(fn: (m: ConsoleMode) => void): () => void {
    this.modeListeners.add(fn);
    return () => this.modeListeners.delete(fn);
  }

  /**
   * Send one command now.
   *
   * A refusal is reported through `onRefusal` rather than thrown: the engine
   * saying "no" is normal operation and the operator needs to see the reason
   * where they clicked.
   */
  async send(command: DjCommand): Promise<CommandResult> {
    const result = await this.link.send(command);
    this.report(command, result);
    return result;
  }

  /**
   * Send the newest value for a continuously-driven control.
   *
   * A crossfader drag produces an event per pointer move. Sending each one
   * would bury the socket, and dropping them would leave the engine on an
   * old value. Instead: send immediately when the control is idle, and while
   * a send is in flight keep only the newest value and send it on completion.
   * The last value always lands.
   */
  sendCoalesced(command: DjCommand): void {
    const key = keyFor(command);
    this.pending.set(key, command);
    if (this.inflight.has(key)) return;
    void this.pump(key);
  }

  private async pump(key: string): Promise<void> {
    while (this.pending.has(key)) {
      const command = this.pending.get(key)!;
      this.pending.delete(key);
      this.inflight.add(key);
      try {
        // Short budget: a fader must not sit behind an 8s command timeout.
        const result = await this.link.send(command, 1500);
        this.report(command, result, true);
      } catch (err) {
        // `send` is not supposed to throw; if it ever does, stop this loop so
        // it cannot spin. The next value for this control restarts it.
        this.onRefusal?.(`Could not send ${command.type}: ${String(err)}`, command, {
          id: key,
          ok: false,
          appliedAt: new Date().toISOString(),
          code: "INTERNAL",
          error: String(err),
        });
        return;
      } finally {
        this.inflight.delete(key);
      }
    }
  }

  private report(command: DjCommand, result: CommandResult, quiet = false): void {
    if (result.ok) return;
    const offline = result.code === "ENGINE_OFFLINE";

    if (quiet && offline) {
      // A coalesced control that cannot reach the engine: the mode badge
      // already reads REHEARSAL and stays there. Toasting on top of it would
      // fire once a second for the whole length of a fader drag, saying the
      // same thing every time.
      return;
    }
    if (quiet) {
      // A coalesced control reporting a refusal every frame would be
      // unreadable. Discrete commands always report.
      const now = Date.now();
      if (now - this.lastRefusalAt < 1000) return;
      this.lastRefusalAt = now;
    }

    const message = offline
      ? `Engine unreachable — ${command.type} moved the booth graph only`
      : `${command.type} refused: ${result.error}`;
    this.onRefusal?.(message, command, result);
  }

  private emitMode(): void {
    const next = this.computeMode();
    // `detail` is part of the identity. It carries the engine's reason — "engine
    // has no audio armed" versus "output switched off air by the operator" —
    // and those are different faults with different fixes. Comparing only kind
    // and label meant a changed reason was silently swallowed and the operator
    // kept reading the previous fault.
    if (
      next.kind === this.currentMode.kind &&
      next.label === this.currentMode.label &&
      next.detail === this.currentMode.detail
    ) {
      return;
    }
    this.currentMode = next;
    for (const fn of this.modeListeners) fn(next);
  }

  private computeMode(): ConsoleMode {
    const reachable = this.stationSeen ? this.stationReachable : this.link.status.reachable;
    if (!reachable) return MODE_REHEARSAL;

    // The engine's own answer, not a local derivation. This console used to
    // decide on-air from `stationOnAir` alone while the station site decided
    // from `stream.onAir && engine.onAir`, so the two surfaces gave opposite
    // answers the moment the operator took the station off air. One predicate,
    // computed once in ingest, read by everyone.
    const broadcast = this.broadcastState;
    if (broadcast?.onAir === true) return MODE_ON_AIR;
    return {
      kind: "engine",
      label: "OFF AIR",
      // The engine says which of the three failed, which is the difference
      // between "switched off" and "the engine stopped" for whoever is on shift.
      detail: broadcast?.reason || 'the station is not broadcasting',
      drivesEngine: true,
    };
  }

  /**
   * The engine's broadcast block, pushed on every status poll.
   *
   * A socket `stream.status` push arrives on its own cadence and is *only* the
   * Icecast mount — which stays connected while the output is silenced. It is
   * not the on-air answer, so it is recorded but not used for the mode.
   */
  private broadcastState: BroadcastStatus["broadcast"] | null = null;

  /** Fold the engine's broadcast verdict into the mode. */
  observeBroadcast(state: BroadcastStatus["broadcast"]): void {
    this.broadcastState = state;
    this.emitMode();
  }
}

/** Shared instance: every control in the console sends through one socket. */
export const controlBus = new ControlBus();
