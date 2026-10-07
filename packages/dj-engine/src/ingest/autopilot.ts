/**
 * Autopilot: keeps the station playing without a human.
 *
 * The musical decisions are already implemented and unit-tested in
 * engine/marathon.ts (energy-curve scoring, harmonic matching, smart
 * transition and scratch-profile selection). This module supplies the runtime:
 * a crate, an energy target that follows the party template, and a scheduler
 * that cues the next track onto the idle deck before the current one ends,
 * then runs the transition.
 */

import {
  interpolateEnergyCurve,
  pickNextMarathonTrack,
  pickSmartScratchProfile,
  pickSmartTransitionPreset,
} from "../engine/marathon";
import type { MarathonCandidate } from "../engine/marathon";
import type { Mixer } from "../engine/mixer";
import { materialize, type DecodedTrack, type DecodeOptions } from "./decode";
import type {
  PartyTemplate,
  TrackAnalysis,
  TrackDTO,
  TransitionPreset,
} from "@ncsound/station-core";

export type AutopilotOptions = {
  /** Minutes the marathon runs; the energy curve is stretched across it. */
  durationMin?: number;
  /** Fallback energy when no template is set, 0..1. */
  defaultEnergy?: number;
  /** Cue the next track this many seconds before the current one ends. */
  cueAheadSec?: number;
  /** Do not replay a track until the crate has been fully rotated. */
  respectRotation?: boolean;
  /**
   * Decode settings used when a track has to be materialised for a deck.
   * Should match what the crate was scanned with so the analysis cache hits.
   */
  decode?: DecodeOptions;
  /** Called when a track change lands, so the station can update metadata. */
  onTrackChange?: (track: DecodedTrack, plan: TransitionPlan) => void;
};

export type TransitionPlan = {
  preset: TransitionPreset;
  reason: string;
  harmonicLabel: string;
  scratch: { archetype: string; bars: 2 | 4; style: string; placementMode: string } | null;
};

export type NowPlaying = {
  track: DecodedTrack;
  startedAtMs: number;
  /** Set once the incoming track is armed on the idle deck. */
  next: DecodedTrack | null;
  plan: TransitionPlan | null;
};

/**
 * How long an arm may stay outstanding before it is presumed wedged.
 *
 * A normal arm decodes one MP3 and assigns `next`, which takes a couple of
 * seconds. Fifteen is generous enough not to interfere with a slow decode and
 * short enough that a hung one costs a fraction of a track rather than the rest of
 * the shift.
 */
const ARM_TIMEOUT_MS = 15_000;

const TRANSITIONS: TransitionPreset[] = [
  { id: "auto", name: "Auto", bars: 4, curve: "equal-power" },
  { id: "quick", name: "Quick cut", bars: 1, curve: "cut" },
  { id: "bass-swap", name: "Bass swap", bars: 4, curve: "equal-power", bassSwap: true, style: "bass-swap" },
  { id: "filter", name: "Filter riser", bars: 4, curve: "equal-power", filterSweep: true, style: "filter-riser" },
  { id: "vinyl-brake", name: "Vinyl brake", bars: 2, curve: "linear", style: "vinyl-brake" },
  { id: "backspin", name: "Backspin", bars: 2, curve: "linear", style: "backspin" },
  { id: "echo-out", name: "Echo out", bars: 2, curve: "linear", style: "echo-out" },
  { id: "smooth", name: "Smooth", bars: 4, curve: "equal-power", style: "blend" },
  { id: "long", name: "Long blend", bars: 8, curve: "equal-power", style: "blend" },
];

export function presetById(id: string | null | undefined): TransitionPreset {
  return TRANSITIONS.find((t) => t.id === id) ?? TRANSITIONS[0];
}

/** Adapt a decoded track to the shape marathon's scorer expects. */
function candidate(t: DecodedTrack): MarathonCandidate {
  return {
    id: t.id,
    name: `${t.artist} - ${t.title}`,
    analysis: t.analysis ?? { bpm: 120, firstBeat: 0 },
  };
}

/** The scorer only reads bpm/key/energy off the analysis. */
function anchorOf(a: TrackAnalysis | null | undefined): { bpm: number; key?: string; energy?: number } {
  if (!a) return { bpm: 120 };
  return { bpm: a.bpm, key: a.key, energy: a.energy };
}

export class Autopilot {
  private readonly mixer: Mixer;
  private readonly opts: Required<Omit<AutopilotOptions, "onTrackChange">> & { decode: DecodeOptions };
  private readonly onTrackChange: AutopilotOptions["onTrackChange"];

  crate: DecodedTrack[] = [];
  template: PartyTemplate | null = null;
  /** Operator-pinned energy, or null to follow the template curve. */
  private energyOverride: number | null = null;
  enabled = true;

  private playing: NowPlaying | null = null;
  private history: string[] = [];
  private recentPresets: string[] = [];
  private startedAtMs = Date.now();
  private timer: ReturnType<typeof setInterval> | null = null;
  /** True while a track is being decoded for the next deck. */
  private arming = false;
  /** When the current arm started, for the stuck-arm deadline. */
  private armingSince = 0;
  /** Last handover refusal, so it is logged once rather than every tick. */
  private lastRefusal: string | null = null;
  /** Guards the stop-recovery path against re-entering itself. */
  private recovering = false;
  /**
   * Consecutive ticks spent at the end of a track with a successor armed but no
   * handover completed. Only used to throttle the stall diagnostic.
   */
  private stallTicks = 0;

  constructor(mixer: Mixer, opts: AutopilotOptions = {}) {
    this.mixer = mixer;
    this.opts = {
      durationMin: opts.durationMin ?? 240,
      defaultEnergy: opts.defaultEnergy ?? 0.55,
      cueAheadSec: opts.cueAheadSec ?? 8,
respectRotation: opts.respectRotation ?? true,
        // Passed through to decode/materialize so autopilot decodes with the same
        // ffmpeg settings and analysis cache the crate was scanned with.
        decode: opts.decode ?? {},
      };
    this.onTrackChange = opts.onTrackChange;
  }

  get nowPlaying(): NowPlaying | null {
    return this.playing;
  }

  get recentTrackIds(): string[] {
    return [...this.history];
  }

  get energyTarget(): number {
    // An operator pin wins over the template's curve. Without this the
    // `autopilot.setEnergyTarget` command had nothing to write to: energy was a
    // pure function of the curve and the elapsed time, so the command validated
    // its input, reported `ok`, and changed nothing.
    if (this.energyOverride !== null) return this.energyOverride;
    if (!this.template?.energyCurve?.length) return this.opts.defaultEnergy;
    const elapsedMin = (Date.now() - this.startedAtMs) / 60000;
    const progress = Math.min(1, elapsedMin / this.opts.durationMin);
    return interpolateEnergyCurve(this.template.energyCurve, progress);
  }

  /** Pin the energy target, or pass null to hand control back to the curve. */
  setEnergyTarget(energy: number | null): number {
    this.energyOverride = energy === null ? null : Math.max(0, Math.min(1, energy));
    return this.energyTarget;
  }

  get isEnergyOverridden(): boolean {
    return this.energyOverride !== null;
  }

  setTemplate(template: PartyTemplate | null): void {
    this.template = template;
    this.startedAtMs = Date.now();
    // A new arc supersedes a manual pin. These are two dials for one thing, and
    // leaving a stale override in place meant picking a vibe template appeared
    // to do nothing until the pin was cleared by hand.
    this.energyOverride = null;
  }

  /**
   * Make the whole crate eligible again.
   *
   * Autopilot does not walk the crate in order — it scores every candidate
   * against the current energy target on each transition (`pickNextMarathonTrack`)
   * and only `history` prevents repeats. So "resequence" is really "stop
   * excluding what has already played", which is what actually changes the next
   * few tracks. Reordering the array would have been a no-op that looked like
   * it worked.
   */
  resequence(): { crateSize: number } {
    this.history = [];
    return { crateSize: this.crate.length };
  }

  setCrate(tracks: DecodedTrack[]): void {
    this.crate = tracks;
    this.history = [];
  }

  /** Decode settings used when a deck needs a track's PCM. */
  setDecodeOptions(decode: DecodeOptions): void {
    this.opts.decode = decode;
  }

  /**
   * Begin on `track` (or the first crate entry) when the engine is idle.
   *
   * Async because a crate entry carries no PCM until it is materialised, so the
   * first deck load has to decode before it can hand a buffer to the mixer.
   */
async start(track?: DecodedTrack): Promise<boolean> {
    const first = track ?? this.crate[0];
    if (!first) return false;
    if (this.mixer.playing && this.playing) return false;

    /**
     * Re-enable before anything else. stop() clears this flag and nothing else
     * ever set it again, so a restarted autopilot scheduled its timer, called
     * tick() every second, and returned immediately on `!this.enabled` - a
     * station that looked started and never sequenced again, with no log.
     */
    this.enabled = true;

    await materialize(first, this.mixer.ctx, this.opts.decode);
    this.mixer.loadBuffer(0, first.buffer as AudioBuffer, first.analysis ?? undefined);
    this.mixer.play();
    this.playing = { track: first, startedAtMs: Date.now(), next: null, plan: null };
    this.schedule();
    return true;
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.enabled = false;
    this.mixer.pause();
    this.playing = null;
  }

  /** Periodic check, exposed so tests can drive it without a timer. */
tick(): void {
    if (!this.enabled || !this.playing) return;

    const info = this.mixer.info();
    if (!info) {
      /**
       * The mixer has no audible deck. info() returns null whenever
       * mixer.playing is false, and this used to be a bare `return`, so the
       * moment playback stopped - normally the outgoing track reaching its end -
       * autopilot stopped doing anything at all. Nothing was armed, no
       * transition was attempted, and no warning was printed: the station simply
       * broadcast silence while reporting itself as playing.
       *
       * Recover instead. If a deck still holds a track, restart it; otherwise
       * treat this as the end of the current track and arm a successor.
       */
      this.recoverFromStoppedMixer();
      return;
    }
    const rawRemaining = info.remaining;
    /**
     * A non-finite remaining used to disable sequencing silently: every
     * comparison below is `remaining <= cueAheadSec`, and NaN is false for all of
     * them, so a deck with a bad rate or a NaN bpm left autopilot doing nothing
     * for the rest of the process with no log at all. Treat it as the end of the
     * track so it takes the arm-and-handover path and gets reported.
     */
    const remaining = Number.isFinite(rawRemaining) ? rawRemaining : 0;
    if (!Number.isFinite(rawRemaining)) {
      console.warn(
        `[autopilot] info().remaining was ${String(rawRemaining)} (speed=${String(info.speed)}, ` +
          `effBpm=${String(info.effBpm)}, elapsed=${String(info.elapsed)}); ` +
          `treating the track as ended`,
      );
    }

if (!this.playing.next) {
      this.stallTicks = 0;
      if (remaining <= this.opts.cueAheadSec) void this.armNext();
      /**
       * The cue window has passed with nothing armed. On a healthy station that
       * never lasts longer than one decode, so a track sitting at its end while
       * the engine outputs silence means arming is failing. This used to return
       * quietly, which is exactly how the station ended up broadcasting nothing
       * with no indication anywhere that it had stopped sequencing.
       */
      if (remaining <= 0) {
        console.warn(
          `[autopilot] "${this.playing.track.title}" has ended with no successor armed ` +
            `(arming=${this.arming}); the station is silent until this resolves`,
        );
      }
      return;
    }

    if (remaining <= this.opts.cueAheadSec) {
      const plan = this.playing.plan;
      const incoming = this.playing.next;
      if (plan && incoming) {
        const res = this.mixer.next(plan.preset);
        if (res.ok) {
          this.lastRefusal = null;
          this.stallTicks = 0;
          this.recentPresets.push(plan.preset.id);
          this.recentPresets = this.recentPresets.slice(-6);
          this.history.push(this.playing.track.id);
          this.playing = {
            track: incoming,
            startedAtMs: Date.now(),
            next: null,
            plan: null,
          };
          this.onTrackChange?.(incoming, plan);
        } else {
          /**
           * The handover was refused, or threw inside the mixer. Previously
           * ignored, so tick() called next() every second, got the same refusal,
           * and said nothing - the outgoing track ran to its end and the station
           * went quiet with a full log. Report it once, not every tick, or it
           * floods.
           */
          if (this.lastRefusal !== res.reason) {
            this.lastRefusal = res.reason;
            console.warn(
              `[autopilot] transition into "${incoming.title}" refused: ${res.reason} ` +
                `(preset=${plan.preset.id}, remaining=${remaining.toFixed(1)}s)`,
            );
          }
          this.reportStall(remaining, res.reason);
        }
      } else {
        /**
         * Armed but unplanned. Previously this branch did not exist, so a track
         * with `next` set and `plan` null sat at its end with tick() taking no
         * action at all and no log: the same silence as a refusal, with none of
         * the refusal reporting.
         */
        this.stallTicks += 1;
        if (this.stallTicks % 5 === 1) {
          console.warn(
            `[autopilot] "${incoming?.title ?? "a track"}" is armed but has no transition plan ` +
              `(remaining=${remaining.toFixed(1)}s); the handover will never be attempted`,
          );
        }
      }
    }
  }

  /**
   * Periodic, single-line account of a handover that is not happening.
   *
   * This is the diagnostic that distinguishes the cases which all look identical
   * from outside the engine: next() refused, next() threw half-way through, and
   * the deck that is nominally active has run off the end of its buffer while
   * `mixer.playing` still says the station is going.
   */
  private reportStall(remaining: number, reason: string | null): void {
    this.stallTicks += 1;
    if (this.stallTicks % 5 !== 1) return;

    const s = this.mixer.traceDecks();
    const last = this.mixer.handover[this.mixer.handover.length - 1];
    const deck = (i: 0 | 1) =>
      `d${i}{bpm=${s.decks[i].bpm ?? "-"} dur=${s.decks[i].duration ?? "-"} ` +
      `off=${s.decks[i].offset} rolling=${s.decks[i].rolling} ` +
      `endedAt=${s.decks[i].srcEndedAt} lvl=${s.decks[i].level} gain=${s.decks[i].outGain}}`;

    console.warn(
      `[autopilot] handover stalled ${this.stallTicks}s ` +
        `(remaining=${remaining.toFixed(1)}s, reason=${reason ?? "n/a"}, ` +
        `armed="${this.playing?.next?.title ?? "-"}")\n` +
        `            ctx=${this.mixer.ctx.currentTime.toFixed(3)} active=${s.active} idle=${s.idle} ` +
        `busy=${s.busy} busyUntil=${s.busyUntil} fadeStart=${s.fadeStart} anchor=${s.anchor} effBpm=${s.effBpm}\n` +
        `            ${deck(s.active)}\n` +
        `            ${deck(s.idle)}\n` +
        `            last handover: ` +
        (last
          ? `#${last.seq} ${last.outcome}${last.reason ? ` (${last.reason})` : ""}` +
            ` scheduled=${last.scheduling ? "yes" : "no"} toStarted=${last.scheduling?.toStarted ?? "-"}`
          : "none attempted"),
    );
  }

  /**
   * Get the station audible again after the mixer stopped.
   *
   * Restarting the loaded track is deliberately the first move: it needs no
   * decode, it makes info() meaningful again so the normal arm-and-transition
   * path resumes on the next tick, and a track repeating once is a far smaller
   * problem than a station that has gone quiet with no way back.
   */
  private recoverFromStoppedMixer(): void {
    if (this.recovering) return;
    this.recovering = true;
    try {
      const current = this.playing?.track ?? null;

      /**
       * Which deck to restart is decided by which deck holds *this* track, not by
       * "deck 0 has a buffer".
       *
       * The old loop scanned deck 0 first and restarted whatever it found. After
       * a handover deck 0 is the *outgoing* deck - it still holds the previous
       * track, already finished, while the track autopilot believes is playing
       * sits on the other one. So the loop rewound the stale deck and then called
       * mixer.play(), which starts whatever deck the mixer considers current:
       * two different tracks, and the one the station was reporting was not the
       * one that came back.
       */
      const activeSlot = this.mixer.active as 0 | 1;
      let slot: 0 | 1 | null = null;
      if (current?.buffer) {
        for (const i of [activeSlot, this.mixer.idle] as const) {
          if (this.mixer.decks[i].buffer === current.buffer) {
            slot = i;
            break;
          }
        }
      }

      if (slot === null) {
        // The track we are meant to be playing is not on either deck any more.
        const first = current?.buffer ? current : this.crate[0];
        if (!first?.buffer) return;
        console.warn(
          `[autopilot] the mixer stopped and deck ${activeSlot} did not hold ` +
            `"${first.title}"; reloading it`,
        );
        this.mixer.loadBuffer(activeSlot, first.buffer, first.analysis ?? undefined);
        slot = activeSlot;
        if (!this.playing) {
          this.playing = { track: first, startedAtMs: Date.now(), next: null, plan: null };
        }
      } else if (slot !== activeSlot) {
        // mixer.play() only ever starts the deck it considers current, so the
        // deck we rewound has to become the current one or play() ignores it.
        this.mixer.active = slot;
      }

      const deck = this.mixer.decks[slot];
      const finished = !!deck.buffer && deck.rawOffset() >= deck.buffer.duration - 0.25;
      deck.seek(0);
      if (!this.mixer.playing) this.mixer.play();

      console.warn(
        `[autopilot] the mixer had stopped; ` +
          (finished
            ? `"${current?.title ?? "a finished track"}" had run to its end on deck ${slot}, restarted it`
            : `restarted deck ${slot}`) +
          ` so sequencing can resume`,
      );

      // If it had run out, clear any stale cue so the next tick arms afresh.
      if (finished && this.playing) {
        this.playing.next = null;
        this.playing.plan = null;
      }
    } finally {
      this.recovering = false;
    }
  }

  private async armNext(): Promise<void> {
    const current = this.playing;
    if (!current || current.next) return;
    if (this.crate.length === 0) return;

    /**
     * One arm at a time. Materialising a track decodes a whole MP3, which takes
     * longer than the tick interval, and `current.next` is only assigned after
     * that decode. Without this guard every tick started another arm: they all
     * passed the `current.next` check, raced to load the same idle deck, and the
     * handover the station was trying to perform turned into a pile-up. Worse,
     * the pile-up could load the deck that was already playing once the current
     * track reached its end, which left the engine silent with nothing logged.
     */
    if (this.arming) {
      /**
       * Break a stuck arm.
       *
       * `arming` is cleared in a `finally`, so a *throw* cannot wedge it — but a
       * promise that never settles can. Materialising a track shells out to ffmpeg,
       * and if that decode hangs the guard stays true forever: every later tick
       * returns here, nothing is ever armed, and the station plays one track and
       * then broadcasts silence indefinitely. Observed live as a repeating
       * `"has ended with no successor armed (arming=true)"` with no recovery.
       *
       * So the guard has its own deadline. A slow-but-progressing arm finishes
       * well inside this; one still outstanding after it is presumed wedged, and
       * the next tick is allowed to try again. Being wrong in this direction costs
       * one redundant decode; being wrong the other way costs the broadcast.
       */
      if (Date.now() - this.armingSince < ARM_TIMEOUT_MS) return;
      console.warn(
        `[autopilot] an arm has been outstanding for more than ${Math.round(ARM_TIMEOUT_MS / 1000)}s; ` +
          `abandoning it and retrying (the previous decode never settled)`,
      );
    }
    this.arming = true;
    this.armingSince = Date.now();

    try {
      // Rotate the crate before repeating anything.
      if (this.opts.respectRotation && this.history.length >= this.crate.length - 1) {
        this.history = [];
      }
      const exclude = new Set<string>([current.track.id, ...this.history]);

      const chosen = pickNextMarathonTrack(
        anchorOf(current.track.analysis),
        this.crate.map(candidate),
        exclude,
        this.energyTarget,
        Date.now(),
      );
      if (!chosen) {
        // Every candidate is excluded, or the crate is too small to rotate.
        // Say so: this used to return silently and the station played to the
        // end of the track and stopped, with no indication why.
        console.warn(
          `[autopilot] no candidate for "${current.track.title}" (crate=${this.crate.length}, excluded=${exclude.size})`,
        );
        return;
      }

      const track = this.crate.find((t) => t.id === chosen.track.id);
      if (!track) {
        console.warn(`[autopilot] scorer chose ${chosen.track.id}, which is not in the crate`);
        return;
      }

/**
       * Never load onto the deck that is currently audible.
       *
       * This reads `mixer.active`, not `info().deck`. During a transition
       * info() reports the *outgoing* deck until the fade begins, so arming from
       * it would load onto the deck that is about to become active and overwrite
       * the incoming track mid-handover. Only reachable with tracks short enough
       * that the cue window overlaps the fade, but the correct source of truth is
       * free here.
       */
      const idleSlot = (this.mixer.active === 0 ? 1 : 0) as 0 | 1;

      // Cue the next track by decoding it now, so the mix-in happens on the bar
      // line rather than after an ffmpeg round trip.
      await materialize(track, this.mixer.ctx, this.opts.decode);
      if (!track.buffer) {
        console.warn(`[autopilot] could not materialise "${track.title}"`);
        return;
      }
      // The track may have finished while we were decoding.
      if (this.playing !== current) return;
      this.mixer.loadBuffer(idleSlot, track.buffer, track.analysis ?? undefined);

      const preset = pickSmartTransitionPreset(
        anchorOf(current.track.analysis),
        anchorOf(track.analysis),
        this.recentPresets,
      );
      const scratch = pickSmartScratchProfile({
        bpm: track.analysis?.bpm ?? 120,
        energy: track.analysis?.energy,
      });

      current.next = track;
      current.plan = {
        preset: presetById(preset.presetId),
        reason: preset.reason,
        harmonicLabel: chosen.score.harmonicLabel,
        scratch,
      };
    } catch (err) {
      // Previously an async throw here became an unhandled rejection that left
      // the station silently stuck at the end of a track.
      console.error(
        `[autopilot] arming the next track failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      this.arming = false;
    }
  }

  private schedule(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => this.tick(), 1000);
    this.timer.unref?.();
  }
}

/** Project a decoded track onto the TrackDTO the station API reports. */
export function toTrackDTO(track: DecodedTrack, playlist: string): TrackDTO {
  return {
    id: track.id,
    title: track.title,
    artist: track.artist,
    album: null,
    durationSec: Math.round(track.durationSec),
    explicit: false,
    playlist,
    bpm: track.analysis ? Math.round(track.analysis.bpm * 10) / 10 : null,
  };
}

export type { PartyTemplate, TrackAnalysis, TransitionPreset };
