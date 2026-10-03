/**
 * HeadlessEngine — the station's broadcast controller.
 *
 * Owns the audio graph, captures the master bus, and publishes it into
 * Liquidsoap's harbor endpoint. Liquidsoap does the encoding and Icecast
 * ingest; everything musical (track choice, beat matching, key locks,
 * transitions) belongs to the Mixer this wraps.
 *
 *   engine (node)  --PCM-->  liquidsoap harbor :8008  -->  Icecast :8000
 */

import type { EngineState, EngineStatus, StreamEncoder } from "@ncsound/station-core";

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
        if (!this.harbor) return;
        this.harbor.write(channels, frames, interleaveToInt16);
      },
    });
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

  get status(): HeadlessEngineStatus {
    return {
      state: this.state,
      onAir: null,
      transition: {
        active: false,
        preset: null,
        fromTrackId: null,
        toTrackId: null,
        startedAt: null,
        endsAt: null,
        progress: 0,
        harmonicMatch: null,
      },
      telemetry: {
        masterPeakDb: this.peak > 0 ? 20 * Math.log10(this.peak) : -Infinity,
        masterRmsDb: this.rms > 0 ? 20 * Math.log10(this.rms) : -Infinity,
        limiterReductionDb: this.mixer.getMasterTelemetry().limiterReductionDb,
        spectrum: [],
        crossfader: this.mixer.crossfader,
        crossfaderCurve: this.mixer.crossfaderCurve,
        decks: [0, 1].map((i) => {
          const info = this.mixer.info();
          return {
            slot: i as 0 | 1,
            trackId: null,
            playing: info != null && info.deck === i,
            bpm: info != null && info.deck === i ? info.effBpm : null,
            key: null,
            positionSec: info != null && info.deck === i ? info.elapsed : 0,
            durationSec: info != null && info.deck === i ? info.duration : 0,
            speed: info != null && info.deck === i ? info.speed : 1,
            gainDb: 0,
            lowDb: 0,
            midDb: 0,
            highDb: 0,
            levelDb: 0,
          };
        }),
        scratch: null,
        master: this.mixer.getMasterTelemetry(),
        renderedAheadSec: 0,
        cpuMsPerBlock: 0,
        sampleRate: this.sampleRate,
      },
      autopilot: {
        enabled: this.mixer.playing,
        vibeTemplateId: null,
        energyTarget: 0,
        queueDepth: 0,
        crateSize: BUILTIN_TRACK_SPECS.length,
      },
      listeners: { current: 0, peak24h: 0, source: "icecast" },
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
      this.state = this.mixer.playing ? "playing" : "idle";
    } catch (err) {
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
