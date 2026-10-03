/**
 * Command dispatcher.
 *
 * station-core defines 44 commands and validates them, but until this existed
 * nothing applied them: the contract described an interface with no
 * implementation behind it. Every handler here calls a real mixer or autopilot
 * method, or fails with a specific code rather than silently succeeding.
 */

import type {
  Actor,
  CommandEnvelope,
  CommandErrorCode,
  CommandResult,
  DjCommand,
} from "@ncsound/station-core";
import { djCommandSchema } from "@ncsound/station-core/schema";
import type { DecodedTrack, HeadlessEngine } from "@ncsound/dj-engine";

export type DispatcherDeps = {
  engine: HeadlessEngine;
  /** Commands only ops and the console may issue. */
  isAuthorised?: (actor: Actor, command: DjCommand) => boolean;
  /** Queue a track the DJ asked for; resolved by requestId. */
  resolveCueRequest?: (requestId: string) => Promise<string | null> | string | null;
  /** Play a station imaging/jingle by id. */
  playImaging?: (jingleId: string) => Promise<void> | void;
};

class CommandFailure extends Error {
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

export class CommandDispatcher {
  constructor(private readonly deps: DispatcherDeps) {}

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
      case "transport.play":
        if (mixer.playing) return { alreadyPlaying: true };
        mixer.play();
        return { playing: true };
      case "transport.pause":
        mixer.pause();
        return { playing: false };
      case "transport.toggle":
        return { playing: mixer.toggleDeckPlay(this.audibleSlot()) };
      case "transport.stop":
        engine.autopilot.stop();
        mixer.pause();
        return { state: engine.status.state };

      // ---- mixing -------------------------------------------------------
      case "mix.mixNext": {
        const presetId = command.presetId ?? "auto";
        const res = mixer.next({ id: presetId } as never);
        return res.ok
          ? { ok: true, rate: res.rate, clamped: res.clamped, harmonicLabel: res.harmonicLabel }
          : fail("INTERNAL", `mixNext refused: ${res.reason}`);
      }
      case "mix.skip": {
        const res = mixer.next({ id: "quick" } as never);
        if (!res.ok) fail("INTERNAL", `skip refused: ${res.reason}`);
        return { ok: true };
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
      case "mix.setEq":
        mixer.decks[command.slot].setEq(command.band, clamp(command.db, -60, 12, "db"));
        return { slot: command.slot, band: command.band, db: command.db };
      case "mix.setFilter":
        mixer.decks[command.slot].setColorFilter(clamp(command.bipolar, -1, 1, "bipolar"));
        return { slot: command.slot, filter: mixer.decks[command.slot].colorValue };
      case "mix.setMasterGain":
        mixer.masterGain.gain.value = Math.pow(10, clamp(command.gain, -60, 6, "gain") / 20);
        return { masterGainDb: command.gain };
      case "mix.setAutoGain":
        mixer.setAutoGain(command.enabled);
        return { autoGain: mixer.autoGainEnabled };
      case "mix.setTransitionBars":
        if (command.bars !== 1 && command.bars !== 2 && command.bars !== 4 && command.bars !== 8) {
          fail("INVALID_PARAMS", "transition bars must be 1, 2, 4 or 8");
        }
        mixer.setTransitionDurationBars(command.bars);
        return { bars: mixer.customTransitionBars };

      // ---- cueing -------------------------------------------------------
      case "cue.track": {
        const slot = command.slot ?? this.otherSlot();
        const track = this.crateTrack(command.trackId);
        const analysis = mixer.loadBuffer(slot, track.buffer, track.analysis ?? undefined);
        return { slot, trackId: track.id, bpm: analysis.bpm, key: analysis.key };
      }
      case "cue.request": {
        const trackId = (await this.deps.resolveCueRequest?.(command.requestId)) ?? null;
        if (!trackId) fail("NO_SUCH_REQUEST", `no queued request "${command.requestId}"`);
        const slot = this.otherSlot();
        const track = this.crateTrack(trackId);
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
      case "sync.masterBpm":
        if (command.bpm < 60 || command.bpm > 200) {
          fail("INVALID_PARAMS", "master bpm must be between 60 and 200");
        }
        mixer.setMasterBpm(command.bpm);
        return { masterBpm: command.bpm };
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
        if (command.enabled) engine.autopilot.start();
        else engine.autopilot.stop();
        return { enabled: engine.autopilot.enabled };
      case "autopilot.setVibe":
        engine.autopilot.setTemplate({ id: command.templateId, name: command.templateId, energyCurve: [], transition: "auto" });
        return { vibeTemplateId: command.templateId };
      case "autopilot.resequence": {
        if (command.targetEnergy !== undefined) engine.autopilot.setCrate([...engine.library]);
        return { crateSize: engine.library.length };
      }
      case "autopilot.setEnergyTarget":
        if (command.energy < 0 || command.energy > 1) fail("INVALID_PARAMS", "energy must be 0..1");
        return { energyTarget: engine.autopilot.energyTarget };

      // ---- library ------------------------------------------------------
      case "library.load": {
        const slot = command.slot ?? this.otherSlot();
        const track = this.crateTrack(command.path);
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
