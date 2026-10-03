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
};

export type HeadlessEngineStatus = EngineStatus;

export class HeadlessEngine {
  readonly mixer: Mixer;
  readonly harbor: HarborPublisher | null;

  private readonly ringer: MasterRinger;
  private readonly sampleRate: number;
  private state: EngineState = "offline";
  private startedAt: number | null = null;
  private lastError: string | null = null;
  private peak = 0;
  private rms = 0;
  private title: string;

  constructor(opts: HeadlessEngineOptions = {}) {
    this.sampleRate = opts.sampleRate ?? 48000;
    // The ringer creates the context, and the mixer must run on that same one,
    // otherwise the tap and the graph would be in different clocks.
    this.ringer = new MasterRinger({
      sampleRate: this.sampleRate,
      onFrames: ({ peak, rms }) => {
        this.peak = peak;
        this.rms = rms;
      },
      // Every rendered block is published straight into Liquidsoap.
      onChunk: ({ channels, frames }) => {
        if (!this.harbor) return;
        this.harbor.write(channels, frames, interleaveToInt16);
      },
    });
    this.mixer = new Mixer(this.ringer.context);
    this.harbor = opts.publish === false ? null : new HarborPublisher(opts.harbor);
    this.title = "NCSound Radio";
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

  /** Load the built-in studio crate into deck A and start playing it. */
  async start(): Promise<void> {
    this.state = "loading";
    try {
      const ctx = this.audioContext;
      const spec = BUILTIN_TRACK_SPECS[0];
      const buffer = synthesizeStudioTrack(ctx, spec as never);
      this.mixer.loadBuffer(0, buffer);
      this.setTitle(`${spec.artist ?? "NCSound Radio"} - ${spec.title ?? "Studio Feed"}`);
      this.mixer.play();

      if (this.harbor) {
        await this.harbor.connect(undefined, this.title);
      }
      await this.ringer.start(this.mixer.getMasterOutputNode());

      this.startedAt = Date.now();
      this.state = this.mixer.playing ? "playing" : "idle";
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      this.state = "error";
      throw err;
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
