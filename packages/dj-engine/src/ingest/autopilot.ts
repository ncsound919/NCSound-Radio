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
import type { DecodedTrack } from "./decode";
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
  private readonly opts: Required<Omit<AutopilotOptions, "onTrackChange">>;
  private readonly onTrackChange: AutopilotOptions["onTrackChange"];

  crate: DecodedTrack[] = [];
  template: PartyTemplate | null = null;
  enabled = true;

  private playing: NowPlaying | null = null;
  private history: string[] = [];
  private recentPresets: string[] = [];
  private startedAtMs = Date.now();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(mixer: Mixer, opts: AutopilotOptions = {}) {
    this.mixer = mixer;
    this.opts = {
      durationMin: opts.durationMin ?? 240,
      defaultEnergy: opts.defaultEnergy ?? 0.55,
      cueAheadSec: opts.cueAheadSec ?? 8,
      respectRotation: opts.respectRotation ?? true,
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
    if (!this.template?.energyCurve?.length) return this.opts.defaultEnergy;
    const elapsedMin = (Date.now() - this.startedAtMs) / 60000;
    const progress = Math.min(1, elapsedMin / this.opts.durationMin);
    return interpolateEnergyCurve(this.template.energyCurve, progress);
  }

  setTemplate(template: PartyTemplate | null): void {
    this.template = template;
    this.startedAtMs = Date.now();
  }

  setCrate(tracks: DecodedTrack[]): void {
    this.crate = tracks;
    this.history = [];
  }

  /** Begin on `track` (or the first crate entry) when the engine is idle. */
  start(track?: DecodedTrack): boolean {
    const first = track ?? this.crate[0];
    if (!first) return false;
    if (this.mixer.playing && this.playing) return false;

    this.mixer.loadBuffer(0, first.buffer, first.analysis ?? undefined);
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
    if (!info) return;
    const remaining = info.remaining;

    if (!this.playing.next) {
      if (remaining <= this.opts.cueAheadSec) this.armNext();
      return;
    }

    if (remaining <= this.opts.cueAheadSec) {
      const plan = this.playing.plan;
      const incoming = this.playing.next;
      if (plan && incoming) {
        const res = this.mixer.next(plan.preset);
        if (res.ok) {
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
        }
      }
    }
  }

  private armNext(): void {
    const current = this.playing;
    if (!current || current.next) return;
    if (this.crate.length === 0) return;

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
    if (!chosen) return;

    const track = this.crate.find((t) => t.id === chosen.track.id);
    if (!track) return;

    const info = this.mixer.info();
    const idleSlot = (info?.deck === 0 ? 1 : 0) as 0 | 1;
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
    rightsId: track.id.toUpperCase(),
    explicit: false,
    playlist,
    bpm: track.analysis ? Math.round(track.analysis.bpm * 10) / 10 : null,
  };
}

export type { PartyTemplate, TrackAnalysis, TransitionPreset };
