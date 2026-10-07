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
  /**
   * Where the decoded-analysis cache lives. Omit to re-analyse the library on
   * every start, which costs about a second per track.
   */
  analysisCacheDir?: string;
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
  /** Wall clock at ctx.currentTime 0, sampled at start, for ctx -> Date conversion. */
  private ctxEpochMs = Date.now();

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

  /**
   * Re-attach the render tap to the master bus.
   *
   * The repair for a starved pump. When `onaudioprocess` stops firing the engine
   * keeps reporting itself healthy while harbor receives nothing, so this is the
   * only action that can actually fix that — restarting the mixer or re-asserting
   * on air cannot, because neither is the broken part.
   */
  reprimeRenderTap(): boolean {
    if (!this.ringer.isRunning) return false;
    this.ringer.reattach(this.mixer.getMasterOutputNode());
    return true;
  }

  /**
   * Tear down and re-open the harbor upload.
   *
   * `HarborPublisher` cannot detect a dead peer on its own in this topology.
   * Liquidsoap's harbor accepts the connection and never acknowledges the body, so
   * `write()` keeps succeeding and `connected` stays true; observed live across a
   * full Liquidsoap restart: `connected=true`, `reconnects=0`, `lastError=null`,
   * the engine rendering steadily, and the mount at -91 dBFS with no `close` or
   * `error` event ever firing. The publisher's own backlog detector never trips
   * because the socket's write queue does not fill — nothing is reading, but the
   * OS keeps accepting.
   *
   * So the re-establish has to be driven from outside, by something that can see
   * the mount is silent while the engine is demonstrably still producing.
   */
  async reconnectHarbor(): Promise<boolean> {
    if (!this.harbor) return false;
    this.harbor.disconnect();
    try {
      await this.harbor.connect(undefined, this.title);
      return this.harbor.status.connected;
    } catch (err) {
      this.lastError = `harbor reconnect failed: ${err instanceof Error ? err.message : String(err)}`;
      return false;
    }
  }

  /**
   * Milliseconds since the render tap last produced a block.
   *
   * A direct observation, unlike `renderedAheadSec` which is a derived estimate
   * that saturates at both ends. This is what distinguishes a live-but-silent
   * station from a working one.
   */
  get renderStallMs(): number {
    return this.ringer.lastBlockAgeMs;
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
    const level = deck.getLevel();

    return {
      slot,
      trackId: deck.buffer ? this.trackIdForDeck(slot) : null,
      playing: deck.playing,
      bpm: deck.analysis?.bpm ?? null,
      key: deck.analysis ? deck.getEffectiveKey() || null : null,
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
   * Transition state read from the times the mixer actually scheduled.
   *
   * This used to be derived from `autopilot.nowPlaying.plan`, on the assumption
   * that autopilot keeps the plan on the track that became audible. It does the
   * opposite: a successful handover builds a fresh NowPlaying with `plan: null`,
   * so the plan was only ever set during the cue window - the eight seconds
   * *before* the track change, when nothing is mixing yet. The panel therefore
   * showed a transition in progress while the successor sat silently cued, and
   * showed nothing during the transition itself.
   *
   * The mixer knows the real answer: fadeStart and busyUntil are the committed
   * times, and prev.deck is the deck that faded out. Context time is converted
   * to wall clock with an offset captured at start, which drifts by well under a
   * second over a session - far less than the window this reports.
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

    const win = this.mixer.transitionWindow();
    if (!win) return idle;

    const ctxToWallMs = (ctxSec: number): string =>
      new Date(this.ctxEpochMs + ctxSec * 1000).toISOString();

    return {
      active: true,
      // The plan of the track that is now audible is not available (see above),
      // so the preset is read off the deck the handover landed on. Its identity is
      // not the preset, so this is reported as null rather than guessed at.
      preset: null,
      fromTrackId: this.trackIdForDeck(win.fromDeck),
      toTrackId: this.trackIdForDeck(win.toDeck) ?? np.track.id,
      startedAt: ctxToWallMs(win.fadeStart),
      endsAt: ctxToWallMs(win.endsAt),
      progress: win.progress,
      harmonicMatch: null,
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
    // A manual `transport.play` rolls a deck without arming the autopilot, and
    // that is still a broadcast. Returning null here made the listener-facing
    // now-playing empty and the verdict say "engine has no audio armed" while the
    // station was transmitting at -13 dBFS.
    if (!np) return this.rollingDeckSnapshot();

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

  /**
   * On-air state derived from whichever deck is audibly rolling.
   *
   * Used when the autopilot has no now-playing record but a deck is playing —
   * the manual-play case. The deck carries no artist/title (the mixer only holds
   * PCM and analysis), so the crate is searched for the library entry whose
   * duration matches the loaded buffer, and failing that the track is reported by
   * its duration alone rather than being given an invented title.
   */
  private rollingDeckSnapshot(): OnAirSnapshot | null {
    const now = this.audioContext.currentTime;
    const slot = this.mixer.decks.findIndex((d) => d.playing && d.buffer);
    if (slot < 0) return null;
    const deck = this.mixer.decks[slot];
    const buffer = deck.buffer;
    if (!buffer) return null;

    const elapsed = deck.currentOffset(now);
    const duration = buffer.duration;

    /**
     * Match the loaded audio back to the crate.
     *
     * Duration is the only handle available: the mixer stores no track id. It
     * can collide between two files of the same length, so a collision is
     * reported as unknown rather than guessed at — a wrong title on air is worse
     * than an honest "unknown track".
     */
    const candidates = this.crate.filter(
      (t) => Math.abs((t.durationSec ?? 0) - duration) < 0.75,
    );
    const matched = candidates.length === 1 ? candidates[0] : null;

    const track: TrackDTO = matched
      ? toTrackDTO(matched, this.autopilot.template?.name ?? "Core Rotation")
      : {
          id: `deck-${slot}`,
          title: "Unknown track",
          artist: "",
          album: null,
          durationSec: duration,
          // No invented playlist: that is station data this path does not have.
          explicit: false,
          playlist: "Unfiled",
          bpm: deck.analysis?.bpm ?? null,
        };

    return {
      current: {
        track,
        // There is no autopilot record, so there is no honest start time. The
        // elapsed position is real, and saying so beats inventing one.
        startedAt: new Date((now - elapsed) * 1000).toISOString(),
        elapsed: Math.max(0, elapsed),
        duration,
        remaining: Math.max(0, duration - elapsed),
        progress: duration > 0 ? Math.min(1, Math.max(0, elapsed / duration)) : 0,
      },
      element: { kind: "MUSIC" },
      daypart: { clean: true, label: "Music only, no ad slots" },
      liveShow: null,
      next: [],
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
        crossfader: this.mixer.info()?.crossfader ?? this.mixer.crossfader,
        crossfaderCurve: this.mixer.crossfaderCurve,
        decks: [this.deckSnapshot(0), this.deckSnapshot(1)],
        scratch: this.mixer.idle ? null : this.mixer.scratchTelemetry(),
        master: this.mixer.getMasterTelemetry(),
renderedAheadSec: this.renderedAheadSec,
      /**
       * How long the render tap has produced nothing.
       *
       * `renderedAheadSec` pins to -1 when the pump stalls, which is easy to
       * misread as "slightly behind". This is unambiguous: a value climbing into
       * the thousands means the engine has stopped producing audio entirely while
       * still reporting itself healthy.
       */
      renderStallMs: Number.isFinite(this.renderStallMs) ? Math.round(this.renderStallMs) : -1,
      cpuMsPerBlock: this.cpuMsPerBlock,
        sampleRate: this.sampleRate,
      },
      autopilot: this.autopilotState(),
      listeners: this.listenerCounts,
      /**
       * The upload into Liquidsoap's harbor.
       *
       * This was the one link in the chain that nothing reported. The engine
       * rendered audio, the deck read "playing", the master bus metered normally,
       * the mount was connected and holding a listener — and the engine was
       * uploading to nothing, so listeners heard -91 dBFS. Liquidsoap said
       * `Not ready: need more buffering (0/529200)` the whole time, and the only
       * way to see that was to read the daemon's log by hand.
       *
       * `backlogBytes` is the honest liveness signal: `connected` stays true when
       * nothing is reading, because writing to a socket never fails.
       */
      harbor: this.harbor
        ? {
            connected: this.harbor.status.connected,
            bytesSent: this.harbor.status.bytesSent,
            framesSent: this.harbor.status.framesSent,
            backlogBytes: this.harbor.status.backlogBytes,
            reconnects: this.harbor.status.reconnects,
            lastError: this.harbor.status.lastError,
          }
        : null,
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
    this.ctxEpochMs = Date.now() - this.audioContext.currentTime * 1000;
    try {
      const ctx = this.audioContext;

      let crate: DecodedTrack[] = [];
      if (this.opts.libraryDir) {
        const loaded = await loadCrate(ctx, this.opts.libraryDir, {
          sampleRate: this.sampleRate,
          cacheDir: this.opts.analysisCacheDir,
          rootDir: this.opts.libraryDir,
        });
        crate = loaded.tracks;
        this.decodeFailures = loaded.failed;
        // An unreadable library must not take the station off air. Record why
        // so ops sees it, and let the built-in crate carry the broadcast until
        // the path is fixed.
        if (loaded.libraryError) {
          this.lastError = loaded.libraryError;
          console.error(`[engine] ${loaded.libraryError}`);
        }
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
            album: null,
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
      // Autopilot decodes on demand; it needs the same cache the scan used.
      this.autopilot.setDecodeOptions({
        sampleRate: this.sampleRate,
        cacheDir: this.opts.analysisCacheDir,
        rootDir: this.opts.libraryDir,
      });
      const started = await this.autopilot.start(crate[0]);
      if (!started) throw new Error("autopilot refused to start");
      this.syncTitle();

      if (this.harbor) {
        /**
         * A missing or refusing Liquidsoap must not stop the station coming up.
         * The publisher reconnects on a backoff, so the engine starts, renders,
         * and starts publishing the moment the harbor appears. Throwing here
         * meant a cold boot with Liquidsoap still booting produced no station at
         * all, which is the worst possible failure for a 24/7 broadcaster.
         */
        try {
          await this.harbor.connect(undefined, this.title);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          this.lastError = `liquidsoap not reachable at start (${msg}); retrying`;
          console.error(`[engine] ${this.lastError}`);
        }
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
    /**
     * Stop the autopilot, not just the mixer.
     *
     * Pausing the mixer alone left autopilot's tick running: it reads
     * `info()`, gets null because `mixer.playing` is false, and calls its
     * recovery path, which restarts playback - while `state` is being set to
     * "offline" and the harbour connection is being dropped. The engine reported
     * a stopped station that was still rendering, and a later start() then hit
     * "autopilot refused to start" because the mixer was already playing again.
     */
    this.autopilot.stop();
    this.state = "offline";
  }

  async close(): Promise<void> {
    await this.stop();
    await this.ringer.close();
  }
}
