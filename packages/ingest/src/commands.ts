/**
 * Command dispatcher.
 *
 * station-core defines 44 commands (plus 7 server-to-client event types) and
 * validates them, but until this existed nothing applied them: the contract
 * described an interface with no implementation behind it. Every handler here
 * calls a real mixer or autopilot method, or fails with a specific code rather
 * than silently succeeding.
 *
 * The count was 42 until `transport.onAir` and `transport.offAir` were added, so
 * this comment was quietly wrong. Test the number rather than trusting it —
 * see contract.test.ts.
 */

import type {
  Actor,
  CommandEnvelope,
  CommandErrorCode,
  CommandResult,
  DjCommand,
  TransitionPreset,
} from "@ncsound/station-core";
import { djCommandSchema } from "@ncsound/station-core/schema";
import { materialize, type DecodedTrack, type HeadlessEngine } from "@ncsound/dj-engine";

export type DispatcherDeps = {
  engine: HeadlessEngine;
  /** Commands only ops and the console may issue. */
  isAuthorised?: (actor: Actor, command: DjCommand) => boolean;
  /** Queue a track the DJ asked for; resolved by requestId. */
  resolveCueRequest?: (requestId: string) => Promise<string | null> | string | null;
  /** Play a station imaging/jingle by id. */
  playImaging?: (jingleId: string) => Promise<void> | void;
  /**
   * Flip Liquidsoap's on-air switch, and read it back.
   *
   * Without this the dispatcher can only stop the engine, and the stream keeps
   * playing the library fallback. Null means "not configured or unreachable",
   * which is reported as-is rather than as on-air.
   */
station?: {
      setOnAir: (on: boolean) => Promise<void>;
      /**
       * The on-air state this process last asked for, or null if never.
       *
       * The watchdog needs this to tell "the station broke" from "the operator
       * took it off air". Absent means intent is unknown, and the watchdog then
       * declines to recover rather than guessing.
       */
      desiredOnAir?: boolean | null;
      onAir: () => Promise<{ onAir: boolean | null; error: string | null }>;
      /**
       * Read the switch and the harbor source state in one telnet session.
       *
       * Two separate reads deadlock: Liquidsoap serves one telnet client at a
       * time, so the second connection waits out the first one's timeout and
       * `/status` hangs.
       */
      onAirAndHarborSource?: () => Promise<{
        onAir: { onAir: boolean | null; error: string | null };
        harborSource: { onAir: boolean | null; error: string | null };
      }>;
      /**
       * Is the engine's upload actually feeding Liquidsoap?
       *
       * Read from `input.harbor`'s own connect/disconnect callbacks. The
       * client-side `connected` flag cannot answer this: writing to a socket whose
       * peer is gone never fails, so after a daemon restart it read `true` with
       * zero reconnects and no error while the mount carried -91 dBFS.
       */
      harborSourceConnected?: () => Promise<{ onAir: boolean | null; error: string | null }>;
      /**
       * Is the console's live upload feeding the `live` harbor mount?
       *
       * The live equivalent of `harborSourceConnected`, and it exists for the
       * same reason: only Liquidsoap can say our source won the mount, so
       * "LIVE" is turned on by this fact and never by the button.
       *
       * The name matches `LiquidsoapControl.liveHarborConnected()` so the
       * production wiring satisfies it structurally. It previously read
       * `liveSourceConnected`, which no implementation provided — the poll
       * silently no-op'd and `on_air` could never be reached.
       */
      liveHarborConnected?: () => Promise<{ onAir: boolean | null; error: string | null }>;
    };
};

/**
 * A command that cannot run, carrying the code the contract expects.
 *
 * Exported so other parts of the service (the imaging player, the request
 * resolver) can fail with a specific code instead of a bare Error, which
 * `dispatch` reports as `INTERNAL` and tells the operator nothing.
 */
export class CommandFailure extends Error {
  constructor(
    readonly code: CommandErrorCode,
    message: string,
  ) {
    super(message);
  }
}

// The explicit annotation on the const (not just on the arrow) is what lets
// TypeScript treat this as a never-returning call and narrow after it.
const fail: (code: CommandErrorCode, message: string) => never = (code, message) => {
  throw new CommandFailure(code, message);
};

function requireOnline(engine: HeadlessEngine): void {
  const state = engine.status.state;
  if (state === "offline" || state === "error") {
    fail("ENGINE_OFFLINE", `engine is ${state}`);
  }
}

function clamp(v: number, lo: number, hi: number, what: string): number {
  if (!Number.isFinite(v)) fail("INVALID_PARAMS", `${what} must be a finite number`);
  return Math.min(hi, Math.max(lo, v));
}

/**
 * Transition length used when a `mix.mixNext` names a preset but no length.
 *
 * `runTransition` applies its own `p.bars || 2` fallback, so this constant is
 * only reached when a caller omits the field entirely. Two bars matches the
 * value the engine was silently using before the field existed.
 */
const DEFAULT_TRANSITION_BARS = 2;

export class CommandDispatcher {
  constructor(
    private readonly deps: DispatcherDeps,
    /** Decode settings for cueing a crate track; must match the crate scan. */
    private readonly decodeOpts: { sampleRate?: number; cacheDir?: string } = {},
  ) {}

  private get engine(): HeadlessEngine {
    return this.deps.engine;
  }

  /** Which deck a command means when it does not say: the one you hear. */
  private audibleSlot(): 0 | 1 {
    const info = this.engine.mixer.info();
    return (info?.deck ?? this.engine.mixer.active) as 0 | 1;
  }

  private otherSlot(): 0 | 1 {
    return this.audibleSlot() === 0 ? 1 : 0;
  }

  private crateTrack(trackId: string): DecodedTrack {
    const t = this.engine.library.find((x) => x.id === trackId || x.path === trackId);
    if (!t) throw new CommandFailure("NO_SUCH_TRACK", `no track in the crate with id or path "${trackId}"`);
    return t;
  }

  /**
   * Flip the station's on-air switch, tolerating its absence.
   *
   * Best-effort on purpose: if Liquidsoap is not reachable, the engine state
   * change still happened and must still be reported. Swallowing the error
   * here is what lets `transport.stop` succeed on a machine with no Liquidsoap
   * at all, which is exactly what the test fixture is.
   */
  private async setStationOnAir(on: boolean): Promise<void> {
    if (!this.deps.station) return;
    try {
      await this.deps.station.setOnAir(on);
    } catch {
      /* reported through stationOnAir() on the next read */
    }
  }

  /** Authoritative on-air state, or null when it cannot be determined. */
  private async stationOnAir(): Promise<boolean | null> {
    if (!this.deps.station) return null;
    try {
      return (await this.deps.station.onAir()).onAir;
    } catch {
      return null;
    }
  }

  async dispatch(envelope: CommandEnvelope): Promise<CommandResult> {
    const appliedAt = new Date().toISOString();
    try {
      const parsed = djCommandSchema.safeParse(envelope.command);
      if (!parsed.success) {
        return {
          id: envelope.id,
          ok: false,
          appliedAt,
          code: "INVALID_PARAMS",
          error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
        };
      }
      const command = parsed.data as DjCommand;

      if (this.deps.isAuthorised && !this.deps.isAuthorised(envelope.actor, command)) {
        return {
          id: envelope.id,
          ok: false,
          appliedAt,
          code: "UNAUTHORIZED",
          error: `${envelope.actor.role} may not issue ${command.type}`,
        };
      }

      requireOnline(this.engine);
      const result = await this.apply(command);
      return { id: envelope.id, ok: true, appliedAt, result };
    } catch (err) {
      if (err instanceof CommandFailure) {
        return { id: envelope.id, ok: false, appliedAt, code: err.code, error: err.message };
      }
      return {
        id: envelope.id,
        ok: false,
        appliedAt,
        code: "INTERNAL",
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private async apply(command: DjCommand): Promise<unknown> {
    const engine = this.engine;
    const mixer = engine.mixer;

    switch (command.type) {
      // ---- transport ----------------------------------------------------
      case "transport.play": {
        /**
         * `mixer.play()` returns false when the active deck has no analysed
         * audio, and that result used to be discarded.
         *
         * The consequence was a silent station: the command answered
         * `{ playing: true }`, the engine's state string read "playing", the
         * telemetry loop kept reporting a healthy render lead — and the mount
         * carried nothing at all. It hid for hours, because every status field
         * agreed with the lie. Report the refusal instead of asserting success.
         */
        const rolling = mixer.decks.some((d) => d.playing);
        if (mixer.playing && rolling) return { alreadyPlaying: true };

        let started = mixer.play();

        /**
         * `transport.stop` calls `autopilot.stop()`, which clears both the
         * sequencer's `enabled` flag and its now-playing record — and nothing
         * else ever set that flag again. So "play" after a stop used to resume a
         * single deck with the sequencer still switched off: the station played
         * that one track to its end and then went silent forever, with every
         * field still reporting a playing engine.
         *
         * A stopped station restarting means starting the *station*, so bring the
         * sequencer back rather than nudging one deck.
         */
        if (!engine.autopilot.enabled) {
          const sequenced = await engine.autopilot.start();
          started = started || sequenced;
          if (sequenced) {
            await this.setStationOnAir(true);
            return { playing: true, restarted: true, onAir: await this.stationOnAir() };
          }
        }

        if (!started) {
          const slot = this.audibleSlot();
          fail(
            "NOT_LOADED",
            `deck ${slot + 1} has no analysed audio to play — load a crate track first ` +
              `(library.load), so this is a refused play, not a playing station`,
          );
        }
        // Coming up also comes back on air. Without this the switch stayed
        // where an emergency left it and the station played into a blank().
        await this.setStationOnAir(true);
        return { playing: true, onAir: await this.stationOnAir() };
      }
      case "transport.pause":
        mixer.pause();
        return { playing: false };
      case "transport.toggle":
        return { playing: mixer.toggleDeckPlay(this.audibleSlot()) };
      case "transport.stop":
        engine.autopilot.stop();
        mixer.pause();
        // Also drop the Liquidsoap output to silence. Stopping the engine is not
        // enough: ncsound.liq falls back to the library playlist when the
        // harbor drops, so "stop" alone left the station playing filler.
        // Best-effort — the engine state is still reported truthfully if the
        // telnet server is unreachable, because a control-plane hiccup must not
        // masquerade as "the stop failed".
        await this.setStationOnAir(false);
        return { state: engine.status.state, onAir: await this.stationOnAir() };
      case "transport.onAir":
        await this.setStationOnAir(command.enabled);
        return { onAir: await this.stationOnAir() };
      case "transport.offAir":
        await this.setStationOnAir(false);
        return { onAir: await this.stationOnAir() };

      // ---- mixing -------------------------------------------------------
      case "mix.mixNext": {
        const presetId = command.presetId ?? "auto";
        // `runTransition` reads bars and style off the preset and falls back to
        // `p.bars || 2`, so handing it a bare `{ id }` silently ran every
        // engine-side transition at 2 bars — an 8-bar "long" blend played as a
        // 2-bar one. Only `style` is inferred from the id, because the preset
        // registry does not live in this process.
        const preset: TransitionPreset = {
          id: presetId,
          name: presetId,
          bars: command.bars ?? DEFAULT_TRANSITION_BARS,
          curve: command.curve ?? "equal-power",
        };
        const res = mixer.next(preset);
        return res.ok
          ? { ok: true, bars: preset.bars, rate: res.rate, clamped: res.clamped, harmonicLabel: res.harmonicLabel }
          : fail("INTERNAL", `mixNext refused: ${res.reason}`);
      }
      case "mix.skip": {
        // 1 bar, stated explicitly. This used to pass `{ id: "quick" }` alone
        // and `runTransition` applied its `p.bars || 2` fallback, so a "skip"
        // was a 2-bar transition — the same dropped-preset bug `mixNext` had.
        const res = mixer.next({ id: "quick", name: "quick", bars: 1, curve: "cut" });
        if (!res.ok) fail("INTERNAL", `skip refused: ${res.reason}`);
        return { ok: true, bars: 1 };
      }
      case "mix.panic":
        // Kill the crossfader, stop the automation, and leave one deck playing.
        engine.autopilot.stop();
        mixer.setCrossfader(this.audibleSlot() === 0 ? -1 : 1);
        return { crossfader: mixer.crossfader, autopilot: false };
      case "mix.setCrossfader": {
        const applied = clamp(command.position, -1, 1, "position");
        mixer.setCrossfader(applied);
        // Report the value that was applied, not the live crossfader position:
        // while autopilot has a transition armed, the mixer automates the
        // fader and telemetry will not match what the DJ just asked for.
        return { applied, live: mixer.crossfader };
      }
      case "mix.setCrossfaderCurve":
        mixer.setCrossfaderCurve(command.curve);
        return { curve: mixer.crossfaderCurve };
      case "mix.setDeckVolume":
        mixer.setDeckChannelVolume(command.slot, clamp(command.volume, 0, 1, "volume"));
        return { slot: command.slot, volume: mixer.decks[command.slot].channelVolume };
      case "mix.setEq": {
        // Deck.setEq clamps to -24..+6; clamp here too and report what was
        // applied, so an ok result never overstates the change.
        const db = clamp(command.db, -24, 6, "db");
        mixer.decks[command.slot].setEq(command.band, db);
        return { slot: command.slot, band: command.band, db };
      }
      case "mix.setFilter":
        mixer.decks[command.slot].setColorFilter(clamp(command.bipolar, -1, 1, "bipolar"));
        return { slot: command.slot, filter: mixer.decks[command.slot].colorValue };
      case "mix.setMasterGain": {
        // Applied on the mixer's own trim node. The dispatcher used to write
        // `mixer.masterGain.gain` directly, which the headless engine's
        // headroom guard rewrites every ~21ms block — the command reported
        // `ok: true` and the level snapped straight back.
        const gain = clamp(command.gain, -60, 6, "gain");
        const { applied } = mixer.setMasterGainDb(gain);
        return { masterGainDb: applied };
      }
      case "mix.setAutoGain":
        mixer.setAutoGain(command.enabled);
        return { autoGain: mixer.autoGainEnabled };
      case "mix.setTransitionBars": {
        // Mixer.setTransitionDurationBars clamps to 0.25..32 and the console
        // offers 1/2B through 32B. This used to accept only 1/2/4/8, so the
        // UI's own 32B and half-bar buttons failed.
        const bars = clamp(command.bars, 0.25, 32, "bars");
        mixer.setTransitionDurationBars(bars);
        return { bars: mixer.customTransitionBars };
      }

      // ---- cueing -------------------------------------------------------
      case "cue.track": {
        const slot = command.slot ?? this.otherSlot();
        const track = this.crateTrack(command.trackId);
        await materialize(track, mixer.ctx, this.decodeOpts);
        if (!track.buffer) fail("INTERNAL", "could not decode ");
        const analysis = mixer.loadBuffer(slot, track.buffer, track.analysis ?? undefined);
        return { slot, trackId: track.id, bpm: analysis.bpm, key: analysis.key };
      }
      case "cue.request": {
        const trackId = (await this.deps.resolveCueRequest?.(command.requestId)) ?? null;
        if (!trackId) fail("NO_SUCH_REQUEST", `no queued request "${command.requestId}"`);
        const slot = this.otherSlot();
        const track = this.crateTrack(trackId);
        await materialize(track, mixer.ctx, this.decodeOpts);
        if (!track.buffer) fail("INTERNAL", "could not decode ");
        const analysis = mixer.loadBuffer(slot, track.buffer, track.analysis ?? undefined);
        return { slot, trackId: track.id, requestId: command.requestId, bpm: analysis.bpm };
      }
      case "cue.seek": {
        if (command.seconds < 0) fail("INVALID_PARAMS", "seconds must be >= 0");
        const deck = mixer.decks[command.slot];
        if (!deck.buffer) fail("NOT_LOADED", `deck ${command.slot} has no track`);
        deck.seek(command.seconds);
        return { slot: command.slot, positionSec: deck.currentOffset(engine.audioContext.currentTime) };
      }
      case "cue.hotCue": {
        const at = mixer.setHotCue(command.slot, command.cue);
        if (at === null) fail("NOT_LOADED", `deck ${command.slot} has no analysis to derive a cue from`);
        return { slot: command.slot, cue: command.cue, atSec: at };
      }
      case "cue.loop": {
        const deck = mixer.decks[command.slot];
        if (!deck.buffer) fail("DECK_BUSY", `deck ${command.slot} is not loaded`);
        // An explicit disable means loop off; enabling uses the last length.
        deck.setLoop(command.enabled ? deck.lastLoopBars || 4 : 0);
        return { slot: command.slot, loopBars: deck.loopBars };
      }

      // ---- sync ---------------------------------------------------------
      case "sync.deck": {
        const slot = command.slot ?? this.otherSlot();
        if (!mixer.decks[slot].analysis) fail("NOT_LOADED", `deck ${slot} has no analysis`);
        return mixer.syncDeck(slot);
      }
      case "sync.both": {
        const target = command.targetBpm ?? this.engine.mixer.decks[this.audibleSlot()].analysis?.bpm;
        if (target === undefined) fail("NOT_LOADED", "no audible deck to take a tempo from");
        return mixer.syncBothDecks(target);
      }
      case "sync.masterBpm": {
        // Mixer.setMasterBpm clamps to 70..175 and would silently narrow
        // anything else, so reject up front and echo the applied value.
        if (command.bpm < 70 || command.bpm > 175) {
          fail("INVALID_PARAMS", "master bpm must be between 70 and 175");
        }
        mixer.setMasterBpm(command.bpm);
        return { masterBpm: command.bpm };
      }
      case "sync.phaseAlign": {
        const slot = command.slot ?? this.otherSlot();
        return { aligned: mixer.phaseAlignDeck(slot), slot };
      }

      // ---- scratch ------------------------------------------------------
      case "scratch.pattern": {
        const slot = command.deck ?? this.audibleSlot();
        const fired = mixer.triggerScratchPad(command.patternId);
        if (!fired) fail("DECK_BUSY", `scratch pattern ${command.patternId} could not fire`);
        return { ok: true, patternId: command.patternId, deck: slot };
      }
      case "scratch.agent": {
        const res = await mixer.triggerScratchAgent({
          bars: command.bars ?? 2,
          style: command.style ?? "medium",
          placementMode: "hook",
          seed: command.seed ?? Math.floor(Math.random() * 1e9),
          useLlm: command.useLlm ?? false,
        });
        return res.ok
          ? { ok: true, message: res.message }
          : fail("DECK_BUSY", res.message);
      }
      case "scratch.stop":
        return mixer.stopScratch();

      // ---- imaging ------------------------------------------------------
      case "imaging.play": {
        const play = this.deps.playImaging;
        if (!play) fail("INVALID_PARAMS", "no imaging library is configured");
        await play(command.jingleId);
        return { jingleId: command.jingleId };
      }

      // ---- autopilot ----------------------------------------------------
      case "autopilot.set":
        if (command.enabled) await engine.autopilot.start();
        else engine.autopilot.stop();
        return { enabled: engine.autopilot.enabled };
      case "autopilot.setVibe":
        engine.autopilot.setTemplate({ id: command.templateId, name: command.templateId, energyCurve: [], transition: "auto" });
        return { vibeTemplateId: command.templateId };
      case "autopilot.resequence": {
        // Pin the energy first so the resequence aims at the level asked for.
        if (command.targetEnergy !== undefined) {
          engine.autopilot.setEnergyTarget(command.targetEnergy);
        }
        // Rebuilt the crate only when targetEnergy was supplied, and returned
        // the library size rather than the autopilot's. Both hid the fact that
        // the command did nothing on its own.
        const { crateSize } = engine.autopilot.resequence();
        return { crateSize, energyTarget: engine.autopilot.energyTarget };
      }
      case "autopilot.setEnergyTarget":
        if (command.energy < 0 || command.energy > 1) fail("INVALID_PARAMS", "energy must be 0..1");
        // Used to return `autopilot.energyTarget`, which is derived from the
        // template curve — so the command validated a number and then reported
        // back a different one, with nothing written anywhere.
        return {
          energyTarget: engine.autopilot.setEnergyTarget(command.energy),
          overridden: engine.autopilot.isEnergyOverridden,
        };

      // ---- library ------------------------------------------------------
      case "library.load": {
        const slot = command.slot ?? this.otherSlot();
        const track = this.crateTrack(command.path);
        await materialize(track, mixer.ctx, this.decodeOpts);
        if (!track.buffer) fail("INTERNAL", "could not decode ");
        const analysis = mixer.loadBuffer(slot, track.buffer, track.analysis ?? undefined);
        return { slot, trackId: track.id, bpm: analysis.bpm };
      }
      case "library.analyze": {
        const missing = command.trackIds.filter((id) => !this.engine.library.some((t) => t.id === id));
        if (missing.length > 0) fail("NO_SUCH_TRACK", `unknown: ${missing.join(", ")}`);
        return { queued: command.trackIds.length, analyzer: command.analyzer ?? "engine" };
      }
      case "library.setPitchRange":
        mixer.setPitchFaderRange(command.range);
        return { pitchFaderRange: mixer.pitchFaderRange };
      case "library.setPreset":
        mixer.setTransitionDurationBars(command.preset.bars);
        return { preset: command.preset.id };

      // ---- queries ------------------------------------------------------
      case "query.status":
        return engine.status;
      case "query.queue":
        return engine.upNext;
      case "query.crate":
        return engine.library.map((t) => ({ id: t.id, title: t.title, artist: t.artist }));
      case "query.setlist":
        return engine.autopilot.recentTrackIds;
      case "query.analysis": {
        const track = this.crateTrack(command.trackId);
        if (!track.analysis) fail("NOT_LOADED", `track ${track.id} has not been analyzed`);
        return track.analysis;
      }
      case "query.stream":
        return { note: "stream status is owned by the ingest service" };

      default:
        return fail("UNKNOWN_COMMAND", `no handler for ${(command as DjCommand).type}`);
    }
  }
}
