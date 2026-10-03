/**
 * HeadlessEngine — the station's broadcast controller.
 *
 * Owns the audio graph, captures the master bus, and publishes it into
 * Liquidsoap's harbor endpoint. Liquidsoap does the encoding and Icecast
 * ingest; everything musical (track choice, beat matching, key locks,
 * transitions) belongs to the Mixer this wraps.
 *
 *   engine (node)  --PCM-->  liquidsoap harbor :8008  -->  Icecast :8010
 */

import type {
  AutopilotState,
  DeckSnapshot,
  EngineState,
  EngineStatus,
  ListenerCounts,
  OnAirSnapshot,
  StreamEncoder,
  TransitionState,
} from "@ncsound/station-core";

import { MasterRinger, interleaveToInt16 } from "./audio/index";
import { Mixer } from "./engine/mixer";
import { BUILTIN_TRACK_SPECS, synthesizeStudioTrack } from "./engine/synthTracks";
import { HarborPublisher } from "./ingest/harbor";
import { Autopilot, toTrackDTO } from "./ingest/autopilot";
import { idForPath, loadCrate, type DecodedTrack } from "./ingest/decode";
import type { PartyTemplate, TrackDTO } from "@ncsound/station-core";

/** Master bus ceiling, dBFS. Broadcast practice leaves a little headroom. */
const HEADROOM_CEILING_DB = -1.5;
/** How long a peak is held before the guard trims again. */
const HEADROOM_HOLD_MS = 1500;
/** Never pull the master down further than this. */
const TRIM_MIN_DB = -12;
/** Spectrum points reported to clients, folded from the analyser's FFT. */
const SPECTRUM_BUCKETS = 32;

export type HeadlessEngineOptions = {
  sampleRate?: number;
  /** Push rendered audio to Liquidsoap. Off for tests. */
  publish?: boolean;
  harbor?: {
    host?: string;
    port?: number;
    mount?: string;
    user?: string;
    password?: string;
  };
  /** Directory of audio files to broadcast. Falls back to synthesised tracks. */
  libraryDir?: string;
  /** Energy curve driving autopilot sequencing. */
  template?: PartyTemplate | null;
};

export type HeadlessEngineStatus = EngineStatus;

export class HeadlessEngine {
  readonly mixer: Mixer;
  readonly harbor: HarborPublisher | null;
  readonly autopilot: Autopilot;

  private readonly opts: HeadlessEngineOptions;
  private readonly ringer: MasterRinger;
  private readonly sampleRate: number;
  private state: EngineState = "offline";
  private startedAt: number | null = null;
  private lastError: string | null = null;
  private peak = 0;
  private rms = 0;
  private title: string;
  private crate: DecodedTrack[] = [];
  private decodeFailures: Array<{ path: string; error: string }> = [];
  private trimDb = 0;
  private peakHoldUntil = 0;
  private listenerCounts: ListenerCounts = { current: 0, peak24h: 0, source: "icecast" };
  /** Rolling cost of the per-block work: guard plus harbor write. */
  private cpuMsPerBlock = 0;
  /** Wall-clock seconds of audio rendered beyond what has been published. */
  private renderedAheadSec = 0;
  private lastBlockAtMs = 0;

  constructor(opts: HeadlessEngineOptions = {}) {
    this.opts = opts;
    this.sampleRate = opts.sampleRate ?? 48000;
    // The ringer creates the context, and the mixer must run on that same one,
    // otherwise the tap and the graph would be in different clocks.
    this.ringer = new MasterRinger({
      sampleRate: this.sampleRate,
      onFrames: ({ peak, rms }) => {
        this.peak = peak;
        this.rms = rms;
        this.runHeadroomGuard();
      },
      // Every rendered block is published straight into Liquidsoap.
      onChunk: ({ channels, frames }) => {
        const t0 = performance.now();
        if (this.harbor) {
          this.harbor.write(channels, frames, interleaveToInt16);
        }
        // Smoothed, because a single block can be dominated by a GC pause.
        this.cpuMsPerBlock = this.cpuMsPerBlock * 0.9 + (performance.now() - t0) * 0.1;

        // Render-ahead: audio the graph has produced minus what the wall clock
        // has consumed. Nudge it from block arrival rate, and decay it when
        // blocks stop coming so a stalled pump cannot report a healthy lead.
        const now = performance.now();
        if (this.lastBlockAtMs > 0) {
          const gapSec = (now - this.lastBlockAtMs) / 1000;
          if (gapSec > 0 && gapSec < 5) {
            const produced = frames / this.sampleRate;
            this.renderedAheadSec += produced - gapSec;
            this.renderedAheadSec = Math.max(-1, Math.min(10, this.renderedAheadSec));
          } else {
            this.renderedAheadSec = 0;
          }
        }
        this.lastBlockAtMs = now;
      },    });
    this.mixer = new Mixer(this.ringer.context);
    this.harbor = opts.publish === false ? null : new HarborPublisher(opts.harbor);
    this.autopilot = new Autopilot(this.mixer, {
      onTrackChange: (track) => this.syncTitle(track),
    });
    if (opts.template) this.autopilot.setTemplate(opts.template);
    this.title = "NCSound Radio";
  }

  private syncTitle(track?: DecodedTrack): void {
    const t = track ?? this.autopilot.nowPlaying?.track ?? this.crate[0];
    this.title = t ? `${t.artist} - ${t.title}` : "NCSound Radio";
    this.harbor?.setTitle?.(this.title);
  }

  /** Tracks that failed to decode, so ops can see a broken library. */
  get libraryFailures(): Array<{ path: string; error: string }> {
    return [...this.decodeFailures];
  }

  get library(): DecodedTrack[] {
    return this.crate;
  }

  /** Master trim currently applied by the headroom guard, in dB. */
  get masterTrimDb(): number {
    return this.trimDb;
  }

  /** The track the station API should report as playing. */
  get currentTrack(): TrackDTO | null {
    const t = this.autopilot.nowPlaying?.track;
    return t ? toTrackDTO(t, "Core Rotation") : null;
  }

  get upNext(): TrackDTO[] {
    const np = this.autopilot.nowPlaying;
    if (!np?.next) return [];
    return [toTrackDTO(np.next, "Core Rotation")];
  }

  get audioContext(): AudioContext {
    return this.mixer.ctx;
  }

  /**
   * Listener counts, pushed in from Icecast by whichever service polls it.
   *
   * The engine has no way to know how many people are listening; it only knows
   * what it is sending. Reporting zero here rather than leaving the field unset
   * keeps the contract honest: Icecast is the authority, and until a poller
   * runs the numbers mean "not measured".
   */
  setListeners(counts: ListenerCounts): void {
    this.listenerCounts = counts;
  }

  /** Real per-deck state, read off the decks rather than assumed. */
  private deckSnapshot(slot: 0 | 1): DeckSnapshot {
    const deck = this.mixer.decks[slot];
    const info = this.mixer.info();
    const isAudible = info != null && info.deck === slot;
    const level = deck.getLevel();

    return {
      slot,
      trackId: deck.buffer ? this.trackIdForDeck(slot) : null,
      playing: deck.playing,
      bpm: isAudible ? deck.analysis?.bpm ?? null : deck.analysis?.bpm ?? null,
      key: deck.analysis ? deck.getEffectiveKey() : null,
      positionSec: deck.buffer ? deck.currentOffset(this.audioContext.currentTime) : 0,
      durationSec: deck.buffer?.duration ?? 0,
      speed: deck.rate,
      gainDb: deck.autoGainDb + deck.manualTrimDb,
      lowDb: deck.lowKill ? -Infinity : deck.lowDb,
      midDb: deck.midKill ? -Infinity : deck.midDb,
      highDb: deck.highKill ? -Infinity : deck.highDb,
      levelDb: level > 0 ? 20 * Math.log10(level) : -Infinity,
    };
  }

  /** Crate track id currently loaded into a deck, if we can name it. */
  private trackIdForDeck(slot: 0 | 1): string | null {
    const deck = this.mixer.decks[slot];
    // DecodedTrack ids are derived from the path; the deck keeps the buffer, so
    // match on buffer identity against the crate.
    for (const t of this.crate) {
      if (t.buffer === deck.buffer) return t.id;
    }
    return null;
  }

  /** Master spectrum straight off the analyser. */
  private spectrum(): number[] {
    const analyser = this.mixer.masterAnalyser;
    const bins = new Uint8Array(analyser.fftSize);
    analyser.getByteFrequencyData(bins);
    // Fold into 32 log-spaced-ish buckets; the UI wants a shape, not raw FFT.
    const out: number[] = new Array(SPECTRUM_BUCKETS).fill(0);
    const per = bins.length / SPECTRUM_BUCKETS;
    for (let b = 0; b < SPECTRUM_BUCKETS; b++) {
      let sum = 0;
      const from = Math.floor(b * per);
      const to = Math.max(from + 1, Math.floor((b + 1) * per));
      for (let i = from; i < to && i < bins.length; i++) sum += bins[i];
      out[b] = Math.round(sum / (to - from));
    }
    return out;
  }

  /**
   * Transition state derived from when the mixer actually started and expects
   * to finish a fade, not a hardcoded "not transitioning".
   */
  private transitionState(): TransitionState {
    const np = this.autopilot.nowPlaying;
    const idle: TransitionState = {
      active: false,
      preset: null,
      fromTrackId: null,
      toTrackId: np?.track.id ?? null,
      startedAt: null,
      endsAt: null,
      progress: 0,
      harmonicMatch: null,
    };
    if (!np) return idle;

    // Autopilot records the plan on the track that is now audible, so the
    // transition is the bar-aligned window that led up to it. The plan has no
    // duration of its own: it is `bars` bars at the tempo being mixed.
    const plan = np.plan;
    if (!plan) return idle;

    const bpm = this.mixer.decks[this.mixer.active].analysis?.bpm ?? 120;
    const secPerBar = (60 / bpm) * 4;
    const total = Math.max(0.5, plan.preset.bars * secPerBar);

    const elapsed = (Date.now() - np.startedAtMs) / 1000;
    const active = elapsed < total;
    return {
      active,
      preset: plan.preset,
      fromTrackId: null,
      toTrackId: np.track.id,
      startedAt: new Date(np.startedAtMs - total * 1000).toISOString(),
      endsAt: new Date(np.startedAtMs).toISOString(),
      progress: active ? Math.min(1, elapsed / total) : 1,
      harmonicMatch: plan.harmonicLabel,
    };
  }

  /** Autopilot state read off the autopilot, including the real crate size. */
  private autopilotState(): AutopilotState {
    const np = this.autopilot.nowPlaying;
    return {
      enabled: this.autopilot.enabled,
      vibeTemplateId: this.autopilot.template?.id ?? null,
      energyTarget: this.autopilot.energyTarget,
      queueDepth: np?.next ? 1 : 0,
      crateSize: this.crate.length,
    };
  }

  /**
   * On-air snapshot built from the track actually playing.
   *
   * There is no ad inventory and no live show in this station, so `daypart` and
   * `liveShow` say exactly that instead of inventing a schedule.
   */
  private onAirSnapshot(): OnAirSnapshot | null {
    const np = this.autopilot.nowPlaying;
    if (!np) return null;

    const track = toTrackDTO(np.track, this.autopilot.template?.name ?? "Core Rotation");
    const deck = this.mixer.decks[this.mixer.info()?.deck ?? this.mixer.active];
    const elapsed = deck.buffer ? deck.currentOffset(this.audioContext.currentTime) : 0;
    const duration = np.track.durationSec;

    return {
      current: {
        track,
        startedAt: new Date(np.startedAtMs).toISOString(),
        elapsed: Math.max(0, elapsed),
        duration,
        remaining: Math.max(0, duration - elapsed),
        progress: duration > 0 ? Math.min(1, Math.max(0, elapsed / duration)) : 0,
      },
      element: { kind: "MUSIC" },
      daypart: { clean: true, label: "Music only, no ad slots" },
      liveShow: null,
      next: np.next ? [{ ...toTrackDTO(np.next, "Core Rotation"), elementKind: "MUSIC" }] : [],
      wheel: [{ kind: "MUSIC", durSec: Math.round(duration) }],
      cycleIndex: 0,
      cycleSec: this.startedAt ? (Date.now() - this.startedAt) / 1000 : 0,
      serverTime: new Date().toISOString(),
    };
  }

  get status(): HeadlessEngineStatus {
    return {
      state: this.state,
      onAir: this.onAirSnapshot(),
      transition: this.transitionState(),
      telemetry: {
        masterPeakDb: this.peak > 0 ? 20 * Math.log10(this.peak) : -Infinity,
        masterRmsDb: this.rms > 0 ? 20 * Math.log10(this.rms) : -Infinity,
        limiterReductionDb: this.mixer.getMasterTelemetry().limiterReductionDb,
        spectrum: this.spectrum(),
        crossfader: this.mixer.crossfader,
        crossfaderCurve: this.mixer.crossfaderCurve,
        decks: [this.deckSnapshot(0), this.deckSnapshot(1)],
        scratch: this.mixer.idle ? null : this.mixer.scratchTelemetry(),
        master: this.mixer.getMasterTelemetry(),
        renderedAheadSec: this.renderedAheadSec,
        cpuMsPerBlock: this.cpuMsPerBlock,
        sampleRate: this.sampleRate,
      },
      autopilot: this.autopilotState(),
      listeners: this.listenerCounts,
      uptimeSec: this.startedAt ? (Date.now() - this.startedAt) / 1000 : 0,
      serverTime: new Date().toISOString(),
      lastError: this.lastError,
    };
  }

  get encoder(): StreamEncoder {
    return "mp3";
  }

  /**
   * Load the crate and go on air.
   *
   * Prefers a real music library so the station plays a set rather than one
   * loop; falls back to the built-in synthesised studio crate when the library
   * directory is empty or unreadable, so a fresh checkout still broadcasts.
   */
  async start(): Promise<void> {
    this.state = "loading";
    try {
      const ctx = this.audioContext;

      let crate: DecodedTrack[] = [];
      if (this.opts.libraryDir) {
        const loaded = await loadCrate(ctx, this.opts.libraryDir, {
          sampleRate: this.sampleRate,
        });
        crate = loaded.tracks;
        this.decodeFailures = loaded.failed;
      }

      if (crate.length === 0) {
        const spec = BUILTIN_TRACK_SPECS[0];
        const buffer = synthesizeStudioTrack(ctx, spec as never);
        crate = [
          {
            path: "builtin://" + (spec.title ?? "studio"),
            id: idForPath("builtin://" + (spec.title ?? "studio")),
            title: spec.title ?? "Studio Feed",
            artist: spec.artist ?? "NCSound Radio",
            durationSec: buffer.duration,
            sampleRate: buffer.sampleRate,
            channels: buffer.numberOfChannels,
            buffer,
            analysis: null,
          },
        ];
      }

      this.crate = crate;
      this.autopilot.setCrate(crate);
      if (this.opts.template) this.autopilot.setTemplate(this.opts.template);

      const started = this.autopilot.start(crate[0]);
      if (!started) throw new Error("autopilot refused to start");
      this.syncTitle();

      if (this.harbor) {
        await this.harbor.connect(undefined, this.title);
      }
      await this.ringer.start(this.mixer.getMasterOutputNode());
      this.applyHeadroomGuard();

      this.startedAt = Date.now();
      this.state = this.mixer.playing ? "playing" : "idle";    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      this.state = "error";
      throw err;
    }
  }

  /**
   * Keep peaks off full scale.
   *
   * The mixer's limiter is a fast brickwall for transients, but summing two
   * decks through it still peaked at 1.000 and clipped on the encode. This
   * trims the master when sustained peaks are seen and slowly releases, which
   * is what a broadcast chain expects.
   */
  private applyHeadroomGuard(): void {
    this.trimDb = 0;
    this.peakHoldUntil = 0;
  }

  private runHeadroomGuard(): void {
    const peakDb = this.peak > 0 ? 20 * Math.log10(this.peak) : -Infinity;
    const now = Date.now();
    if (peakDb > HEADROOM_CEILING_DB && now > this.peakHoldUntil) {
      // Back off in small steps so the transition is inaudible.
      const wanted = HEADROOM_CEILING_DB - peakDb;
      this.trimDb = Math.max(TRIM_MIN_DB, Math.min(0, this.trimDb + wanted * 0.5));
      this.peakHoldUntil = now + HEADROOM_HOLD_MS;
    } else if (now > this.peakHoldUntil) {
      // Release slowly back toward unity.
      this.trimDb = Math.min(0, this.trimDb + 0.15);
    }
    const gain = Math.pow(10, this.trimDb / 20);
    const g = this.mixer.masterGain.gain;
    if (Math.abs(g.value - gain) > 0.001) {
      g.setTargetAtTime(gain, this.audioContext.currentTime, 0.08);
    }
  }

  /**
   * Local now-playing label. The ICY title travels as a request header, so it
   * only reaches listeners on the next connect.
   */
  setTitle(title: string): void {
    this.title = title;
  }

  get nowPlayingTitle(): string {
    return this.title;
  }

  async stop(): Promise<void> {
    this.ringer.stop();
    this.harbor?.disconnect();
    this.mixer.pause();
    this.state = "offline";
  }

  async close(): Promise<void> {
    await this.stop();
    await this.ringer.close();
  }
}
