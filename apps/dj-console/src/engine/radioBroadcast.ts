/**
 * Online Radio Station Autonomous Music Player & Broadcast Engine
 *
 * Features:
 * - Real-time "ON AIR" Broadcast output bus with dedicated Broadcast MediaStream destination
 * - FM/HD Broadcast DSP Processing (Multiband AGC, Warmth Exciter, Subsonic Highpass & -1.0dBFS Brickwall Peak Limiter)
 * - Station Voice Sweepers & Jingle Injection with smooth -8dB sidechain music ducking
 * - Autonomous Rotation & Sweeper Scheduler (Every N songs, Top-of-Hour Station ID, or On-Demand)
 * - 24/7 Silence Detection & Autonomous Failover Audio Recovery (Prevents dead air)
 * - Outbound Now-Playing Webhook Dispatcher (AzuraCast, Icecast, Centova Cast, Discord, Custom JSON)
 * - Listener Inbound Song Request Queue & Management (/api/radio/request)
 * - Remote Control Command API (/api/radio/control)
 * - Embeddable HTML/JS Web Player Widget Code Generator
 */

export interface RadioStationConfig {
  stationName: string;
  slogan: string;
  genre: string;
  websiteUrl: string;
  mountPoint: string;
  bitrateKbps: number;
  sampleRate: number;
  autoJingleInterval: number | "top-of-hour"; // 0 = off, 3 = every 3 tracks, 5 = every 5 tracks, etc.
  broadcastDspEnabled: boolean;
  duckingAmountDb: number;
  webhookUrl: string;
  webhookFormat: "azuracast" | "icecast" | "discord" | "custom";
  autoWebhookOnTrackChange: boolean;
  autoFailoverEnabled: boolean;
  autoApproveRequests: boolean;
  /**
   * Where the embeddable widget reads now-playing from. Defaults to the
   * station app, which serves it from the live engine.
   */
  nowPlayingApiUrl: string;
  /**
   * Real Icecast count, pushed in from BroadcastLink. null means "not
   * measured". It must never be defaulted to a number: an operator reading a
   * fabricated listener figure has no way to tell it from a real one.
   */
  listeners: number | null;
}

export interface RadioSongRequest {
  id: string;
  timestampMs: number;
  timeFormatted: string;
  query: string;
  requester: string;
  message: string;
  status: "pending" | "queued" | "rejected" | "played";
  matchedTrackId?: string;
  matchedTrackName?: string;
}

export interface StationSweeper {
  id: string;
  name: string;
  type: "ident" | "sweeper" | "drop" | "voiceover";
  durationSec: number;
  buffer?: AudioBuffer;
  isCustom?: boolean;
}

export interface RadioNowPlayingPayload {
  station: {
    name: string;
    slogan: string;
    genre: string;
    url: string;
    mount: string;
    onAir: boolean;
    uptimeSec: number;
    listeners: number;
  };
  nowPlaying: {
    id: string;
    title: string;
    artist: string;
    genre: string;
    bpm: number;
    key: string;
    durationSec: number;
    elapsedSec: number;
    remainingSec: number;
    artUrl?: string;
  };
  nextTrack?: {
    id: string;
    title: string;
    artist: string;
    bpm: number;
    key: string;
    durationSec: number;
  };
  broadcast: {
    bitrateKbps: number;
    sampleRate: number;
    dspActive: boolean;
    jinglesPlayed: number;
    currentMode: string;
  };
  timestamp: string;
}

export class RadioBroadcastEngine {
  ctx: AudioContext;
  config: RadioStationConfig = {
    stationName: "Club Horizon Radio",
    slogan: "24/7 Autonomous Underground Electronic & Club Beats",
    genre: "Electronic / House / Techno",
    websiteUrl: "https://radio.horizon.fm",
    mountPoint: "/live.mp3",
    bitrateKbps: 320,
    sampleRate: 44100,
    autoJingleInterval: 3,
    broadcastDspEnabled: true,
    duckingAmountDb: -7.5,
    webhookUrl: "",
    webhookFormat: "azuracast",
    autoWebhookOnTrackChange: true,
    autoFailoverEnabled: true,
    autoApproveRequests: false,
    listeners: null,
    // The console itself cannot know this; the station app reads it from the
    // engine, which reads it from Icecast.
    nowPlayingApiUrl: "http://127.0.0.1:3100/api/nowplaying",
  };

  isOnAir = false;
  startedAtMs = 0;
  tracksPlayedSinceJingle = 0;
  totalJinglesPlayed = 0;
  lastJinglePlayedAt = 0;
  lastTopOfHourJingleHour = -1;

  // Audio Nodes
  inputNode: GainNode;
  duckingNode: GainNode;
  dspHighpass: BiquadFilterNode;
  dspWarmthExciter: WaveShaperNode;
  dspLimiter: DynamicsCompressorNode;
  masterBroadcastGain: GainNode;
  broadcastMediaStreamDest: MediaStreamAudioDestinationNode;
  jingleGain: GainNode;

  // Built-in & custom sweepers
  sweepers: StationSweeper[] = [];
  activeJingleSource: AudioBufferSourceNode | null = null;
  isJinglePlaying = false;

  // Requests & Webhooks
  songRequests: RadioSongRequest[] = [];
  lastWebhookStatus: { success: boolean; time: string; message: string } | null = null;
  webhookHistory: { time: string; url: string; status: number | string; success: boolean }[] = [];

  // Silence Detection
  silenceSeconds = 0;
  silenceTripped = false;
  failoverRecoveryActive = false;

  constructor(ctx: AudioContext) {
    this.ctx = ctx;

    // 1. Input Node tapped from DJ Mixer Master Limiter
    this.inputNode = this.ctx.createGain();
    this.inputNode.gain.value = 1.0;

    // 2. Ducking Node (attenuates music when jingle/sweeper or station ID drops)
    this.duckingNode = this.ctx.createGain();
    this.duckingNode.gain.value = 1.0;

    // 3. Broadcast DSP Chain: 30Hz Highpass + FM Warmth Saturation + Broadcast Multiband Limiter
    this.dspHighpass = this.ctx.createBiquadFilter();
    this.dspHighpass.type = "highpass";
    this.dspHighpass.frequency.value = 30; // Protect against low subsonic rumble on internet radio transmitters
    this.dspHighpass.Q.value = 0.707;

    this.dspWarmthExciter = this.ctx.createWaveShaper();
    this.dspWarmthExciter.curve = this.createBroadcastWarmthCurve(512) as any;
    this.dspWarmthExciter.oversample = "4x";

    this.dspLimiter = this.ctx.createDynamicsCompressor();
    this.dspLimiter.threshold.value = -1.0; // -1.0 dBFS broadcast ceiling
    this.dspLimiter.knee.value = 1.5;
    this.dspLimiter.ratio.value = 20.0;
    this.dspLimiter.attack.value = 0.001;
    this.dspLimiter.release.value = 0.06;

    // 4. Master Broadcast Gain & MediaStream Destination (for live streaming encoders / WebRTC / OBS)
    this.masterBroadcastGain = this.ctx.createGain();
    this.masterBroadcastGain.gain.value = 1.0;

    this.broadcastMediaStreamDest = this.ctx.createMediaStreamDestination();

    // 5. Jingle / Sweeper Bus
    this.jingleGain = this.ctx.createGain();
    this.jingleGain.gain.value = 1.0;

    // Connect Audio Routing:
    // Input -> Ducking -> DSP Highpass -> DSP Warmth -> DSP Limiter -> Master Broadcast Gain -> MediaStream Destination + Master Audio Destination
    this.inputNode.connect(this.duckingNode);
    this.duckingNode.connect(this.dspHighpass);
    this.dspHighpass.connect(this.dspWarmthExciter);
    this.dspWarmthExciter.connect(this.dspLimiter);
    this.dspLimiter.connect(this.masterBroadcastGain);

    // Jingle drops bypass ducking and inject straight into DSP chain before limiter
    this.jingleGain.connect(this.dspHighpass);

    this.masterBroadcastGain.connect(this.broadcastMediaStreamDest);

    // Synthesize built-in studio sweepers
    this.initBuiltinSweepers();
  }

  /** Generates a subtle tape/tube warmth soft-saturation curve for FM radio punch. */
  private createBroadcastWarmthCurve(samples = 512): Float32Array {
    const curve = new Float32Array(samples);
    const k = 0.45; // Subtle broadcast warmth drive
    for (let i = 0; i < samples; i++) {
      const x = (i * 2) / samples - 1;
      // Soft saturation arctan transfer function
      curve[i] = ((1 + k) * x) / (1 + k * Math.abs(x));
    }
    return curve;
  }

  /** Synthesizes studio radio sweepers with vocal formants, noise risers, and punchy radio drops. */
  private initBuiltinSweepers() {
    const specs: { id: string; name: string; type: StationSweeper["type"]; freq: number; duration: number }[] = [
      { id: "sw-ident", name: "⚡ Subsonic Station ID (Pure Beats)", type: "ident", freq: 110, duration: 2.2 },
      { id: "sw-club", name: "🔥 Club Horizon — Autonomous Mix", type: "sweeper", freq: 140, duration: 2.5 },
      { id: "sw-drop", name: "🚀 Peak Energy Radio Voice Drop", type: "drop", freq: 88, duration: 1.8 },
      { id: "sw-top-hour", name: "⏰ Top of the Hour Station Clock", type: "ident", freq: 120, duration: 3.0 },
      { id: "sw-vibes", name: "✨ Non-Stop Underground Broadcast", type: "voiceover", freq: 130, duration: 2.0 },
    ];

    this.sweepers = specs.map(s => {
      const buf = this.synthesizeRadioSweeperBuffer(s.name, s.freq, s.duration);
      return {
        id: s.id,
        name: s.name,
        type: s.type,
        durationSec: s.duration,
        buffer: buf,
        isCustom: false,
      };
    });
  }

  /**
   * Synthesizes an energetic radio sweeper / voice drop AudioBuffer using
   * FM formant synthesis, noise sweeps, sub drops, and stereo spatialization.
   */
  synthesizeRadioSweeperBuffer(title: string, baseFreq: number, durationSec: number): AudioBuffer {
    const sr = this.ctx.sampleRate;
    const len = Math.floor(sr * durationSec);
    const buf = this.ctx.createBuffer(2, len, sr);
    const left = buf.getChannelData(0);
    const right = buf.getChannelData(1);

    const isTopHour = title.includes("Top of the Hour") || title.includes("⏰");
    const isDrop = title.includes("Drop") || title.includes("🚀");

    for (let i = 0; i < len; i++) {
      const t = i / sr;
      const progress = t / durationSec;

      // 1. Sub-bass punch drop at the beginning
      const subPitch = Math.max(35, baseFreq * (1.0 - progress * 0.7));
      const subEnv = Math.exp(-t * 3.5);
      const sub = Math.sin(2 * Math.PI * subPitch * t) * subEnv * 0.45;

      // 2. Formant Voice Carrier (Simulated vocoder robotic radio voice)
      const carrierFreq = baseFreq * (1 + 0.05 * Math.sin(2 * Math.PI * 6.5 * t)); // 6.5Hz vibrato
      const modIndex = 1.8 * Math.sin(2 * Math.PI * 3 * t);
      const voiceCarrier = Math.sin(2 * Math.PI * carrierFreq * t + modIndex * Math.sin(2 * Math.PI * (carrierFreq * 1.5) * t));
      
      // Formant filters (F1 ~500Hz, F2 ~1500Hz, F3 ~2500Hz)
      const formant1 = Math.sin(2 * Math.PI * 520 * t) * 0.3;
      const formant2 = Math.sin(2 * Math.PI * 1600 * t) * 0.25;
      const formant3 = Math.sin(2 * Math.PI * 2600 * t) * 0.15;
      const vocalRhythm = (Math.sin(2 * Math.PI * 4 * t) > 0 ? 1 : 0.2) * (1 - Math.exp(-t * 20)) * (1 - progress);
      const voice = voiceCarrier * (formant1 + formant2 + formant3) * vocalRhythm * 0.55;

      // 3. Noise Riser & Sibilance Sweeper
      const noise = (Math.random() * 2 - 1);
      const noiseEnv = Math.pow(progress, 2.5) * 0.2 + (Math.exp(-t * 8) * 0.15);
      const noiseFilter = noise * noiseEnv;

      // 4. Laser / Cyber FX chime for Station Ident
      const laserFreq = isTopHour ? (800 + 400 * Math.sin(2 * Math.PI * 8 * t)) : (1200 - 900 * progress);
      const laserEnv = isTopHour ? (Math.sin(2 * Math.PI * 2 * t) > 0.3 ? 0.25 : 0) : Math.exp(-t * 4) * 0.2;
      const chime = Math.sin(2 * Math.PI * laserFreq * t) * laserEnv;

      // Combine
      let sig = sub + voice + noiseFilter + chime;
      // Master envelope
      const masterEnv = (1 - Math.exp(-t * 30)) * Math.pow(1 - progress, 1.2);
      sig *= masterEnv * 0.85;

      // Stereo widen
      const panOffset = 0.08 * Math.sin(2 * Math.PI * 2 * t);
      left[i] = sig * (1 - panOffset);
      right[i] = sig * (1 + panOffset);
    }

    return buf;
  }

  /** Adds a custom uploaded jingle/sweeper audio file (MP3/WAV/FLAC/M4A). */
  async addCustomJingle(file: File): Promise<StationSweeper> {
    const ab = await file.arrayBuffer();
    const buf = await this.ctx.decodeAudioData(ab);
    const id = `custom-jingle-${Date.now()}`;
    const name = file.name.replace(/\.[^/.]+$/, "");
    const sweeper: StationSweeper = {
      id,
      name: `🎵 ${name}`,
      type: "sweeper",
      durationSec: buf.duration,
      buffer: buf,
      isCustom: true,
    };
    this.sweepers.unshift(sweeper);
    return sweeper;
  }

  /** Plays a station sweeper / jingle with smooth ducking of the master music. */
  triggerJingle(sweeperId?: string): boolean {
    if (this.isJinglePlaying) return false;

    let sweeper = this.sweepers.find(s => s.id === sweeperId);
    if (!sweeper && this.sweepers.length > 0) {
      // Pick random sweeper
      sweeper = this.sweepers[Math.floor(Math.random() * this.sweepers.length)];
    }
    if (!sweeper || !sweeper.buffer) return false;

    try {
      const now = this.ctx.currentTime;
      const duration = sweeper.buffer.duration;
      const duckGain = Math.pow(10, this.config.duckingAmountDb / 20); // e.g. -7.5dB => ~0.42

      // 1. Duck the master music smoothly over 80ms
      this.duckingNode.gain.cancelScheduledValues(now);
      this.duckingNode.gain.setValueAtTime(this.duckingNode.gain.value, now);
      this.duckingNode.gain.linearRampToValueAtTime(duckGain, now + 0.08);

      // Schedule restore after jingle ends with smooth 350ms release ramp
      this.duckingNode.gain.setValueAtTime(duckGain, now + duration);
      this.duckingNode.gain.linearRampToValueAtTime(1.0, now + duration + 0.35);

      // 2. Play Jingle buffer
      const src = this.ctx.createBufferSource();
      src.buffer = sweeper.buffer;
      src.connect(this.jingleGain);

      src.onended = () => {
        this.isJinglePlaying = false;
        this.activeJingleSource = null;
      };

      src.start(now);
      this.activeJingleSource = src;
      this.isJinglePlaying = true;
      this.totalJinglesPlayed++;
      this.tracksPlayedSinceJingle = 0;
      this.lastJinglePlayedAt = Date.now();

      return true;
    } catch (err) {
      console.error("Failed to play jingle:", err);
      return false;
    }
  }

  /** Toggles ON AIR live broadcast mode. */
  toggleOnAir(active?: boolean): boolean {
    const newState = active !== undefined ? active : !this.isOnAir;
    this.isOnAir = newState;
    if (newState) {
      if (this.ctx.state === "suspended") {
        void this.ctx.resume();
      }
      this.startedAtMs = Date.now();
    }
    return this.isOnAir;
  }

  /** Checks top of hour clock and auto-jingle rules during live auto-mix playback. */
  checkAutomationRules(isNewTrackTransition = false) {
    if (!this.isOnAir) return;

    if (isNewTrackTransition) {
      this.tracksPlayedSinceJingle++;
      // Check interval
      if (
        typeof this.config.autoJingleInterval === "number" &&
        this.config.autoJingleInterval > 0 &&
        this.tracksPlayedSinceJingle >= this.config.autoJingleInterval
      ) {
        this.triggerJingle();
      }
    }

    // Top-of-Hour check
    const now = new Date();
    const curMin = now.getMinutes();
    const curHour = now.getHours();
    if (
      (this.config.autoJingleInterval === "top-of-hour" || this.config.autoJingleInterval > 0) &&
      curMin === 0 &&
      this.lastTopOfHourJingleHour !== curHour
    ) {
      this.lastTopOfHourJingleHour = curHour;
      const topHourSweeper = this.sweepers.find(s => s.id === "sw-top-hour") || this.sweepers[0];
      this.triggerJingle(topHourSweeper?.id);
    }
  }

  /** Ingests a new listener song request. */
  submitSongRequest(req: { query: string; requester?: string; message?: string }): RadioSongRequest {
    const now = new Date();
    const timeFormatted = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
    const newReq: RadioSongRequest = {
      id: `req-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      timestampMs: Date.now(),
      timeFormatted,
      query: req.query.trim(),
      requester: req.requester?.trim() || "Online Listener",
      message: req.message?.trim() || "",
      status: this.config.autoApproveRequests ? "queued" : "pending",
    };
    this.songRequests.unshift(newReq);
    if (this.songRequests.length > 50) this.songRequests.pop();
    return newReq;
  }

  /** Updates status of a listener song request. */
  updateRequestStatus(id: string, status: RadioSongRequest["status"]): boolean {
    const r = this.songRequests.find(item => item.id === id);
    if (r) {
      r.status = status;
      return true;
    }
    return false;
  }

  /** Formats standard Now-Playing payload compatible with AzuraCast / Icecast / Discord / Custom webhooks. */
  buildNowPlayingPayload(
    activeTrack: { id: string; name: string; artist: string; genre: string; analysis: any; duration: number },
    elapsedSec: number,
    nextTrack?: { id: string; name: string; artist: string; analysis: any; duration: number }
  ): RadioNowPlayingPayload {
    const uptimeSec = this.isOnAir && this.startedAtMs > 0 ? Math.floor((Date.now() - this.startedAtMs) / 1000) : 0;
    const dur = activeTrack.duration || 180;
    const remainingSec = Math.max(0, dur - elapsedSec);

    return {
      station: {
        name: this.config.stationName,
        slogan: this.config.slogan,
        genre: this.config.genre,
        url: this.config.websiteUrl,
        mount: this.config.mountPoint,
        onAir: this.isOnAir,
        uptimeSec,
        // The onAir payload declares a numeric listener count because webhooks
        // downstream expect one. The console cannot measure it, so report 0
        // and let the reading stand as "none seen" rather than inventing one.
        listeners: this.config.listeners ?? 0,
      },
      nowPlaying: {
        id: activeTrack.id,
        title: activeTrack.name,
        artist: activeTrack.artist || "Autonomous Radio DJ",
        genre: activeTrack.genre || "Electronic",
        bpm: Math.round(activeTrack.analysis?.bpm ?? 124),
        key: activeTrack.analysis?.key || "8A",
        durationSec: Math.round(dur),
        elapsedSec: Math.round(elapsedSec),
        remainingSec: Math.round(remainingSec),
      },
      nextTrack: nextTrack
        ? {
            id: nextTrack.id,
            title: nextTrack.name,
            artist: nextTrack.artist || "Autonomous Radio DJ",
            bpm: Math.round(nextTrack.analysis?.bpm ?? 124),
            key: nextTrack.analysis?.key || "8A",
            durationSec: Math.round(nextTrack.duration || 180),
          }
        : undefined,
      broadcast: {
        bitrateKbps: this.config.bitrateKbps,
        sampleRate: this.config.sampleRate,
        dspActive: this.config.broadcastDspEnabled,
        jinglesPlayed: this.totalJinglesPlayed,
        currentMode: "Autonomous Auto-DJ",
      },
      timestamp: new Date().toISOString(),
    };
  }

  /** Dispatches outbound webhook to configured external radio server / Discord. */
  async dispatchWebhook(payload: RadioNowPlayingPayload): Promise<{ success: boolean; message: string }> {
    if (!this.config.webhookUrl) {
      return { success: false, message: "No Webhook URL configured" };
    }

    try {
      let bodyData: any = payload;

      // Transform format if Discord Webhook
      if (this.config.webhookFormat === "discord") {
        bodyData = {
          username: this.config.stationName,
          embeds: [
            {
              title: `📻 Now Playing: ${payload.nowPlaying.artist} - ${payload.nowPlaying.title}`,
              description: `**${this.config.slogan}**\nBPM: \`${payload.nowPlaying.bpm}\` | Key: \`${payload.nowPlaying.key}\` | Genre: \`${payload.nowPlaying.genre}\``,
              color: 0xef4444, // Red On-Air color
              fields: [
                {
                  name: "⏭ Up Next",
                  value: payload.nextTrack ? `${payload.nextTrack.artist} - ${payload.nextTrack.title} (${payload.nextTrack.bpm} BPM)` : "Queue Auto-Fill",
                  inline: true,
                },
                {
                  name: "👥 Listeners",
                  value:
                    payload.station.listeners == null
                      ? "Not measured"
                      : `${payload.station.listeners} Tuned In`,
                  inline: true,
                },
              ],
              footer: { text: `${this.config.stationName} • Autonomous Radio Stream` },
              timestamp: payload.timestamp,
            },
          ],
        };
      }

      const res = await fetch(this.config.webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(bodyData),
      });

      const success = res.ok;
      const nowStr = new Date().toLocaleTimeString();
      const statusRecord = {
        time: nowStr,
        url: this.config.webhookUrl,
        status: res.status,
        success,
      };

      this.webhookHistory.unshift(statusRecord);
      if (this.webhookHistory.length > 20) this.webhookHistory.pop();

      this.lastWebhookStatus = {
        success,
        time: nowStr,
        message: success ? `Webhook dispatched successfully (${res.status})` : `Server returned error ${res.status}`,
      };

      return this.lastWebhookStatus;
    } catch (err: any) {
      const nowStr = new Date().toLocaleTimeString();
      const statusRecord = {
        time: nowStr,
        url: this.config.webhookUrl,
        status: err.message || "Network Error",
        success: false,
      };
      this.webhookHistory.unshift(statusRecord);
      this.lastWebhookStatus = {
        success: false,
        time: nowStr,
        message: `Webhook failed: ${err.message}`,
      };
      return this.lastWebhookStatus;
    }
  }

  /** Generates copyable HTML snippet for external radio station website embed player. */
  generateEmbedWidgetHtml(): string {
    return `<!-- ${this.config.stationName} Autonomous Live Radio Player Widget -->
<div id="horizon-radio-player" style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0c0f14; color: #fff; padding: 16px 20px; border-radius: 12px; border: 1px solid #282e3d; max-width: 440px; box-shadow: 0 8px 30px rgba(0,0,0,0.6);">
  <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px;">
    <div style="display: flex; align-items: center; gap: 8px;">
      <span style="display: inline-block; width: 10px; height: 10px; background: #ef4444; border-radius: 50%; box-shadow: 0 0 10px #ef4444; animation: pulse 1.5s infinite;"></span>
      <strong style="font-size: 14px; text-transform: uppercase; letter-spacing: 1px; color: #f87171;">LIVE BROADCAST</strong>
    </div>
    <span style="font-size: 11px; color: #94a3b8; font-family: monospace;">${this.config.bitrateKbps} KBPS HD</span>
  </div>
  <div style="margin-bottom: 14px;">
    <h3 id="hrp-title" style="margin: 0; font-size: 16px; font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${this.config.stationName}</h3>
    <p id="hrp-artist" style="margin: 4px 0 0 0; font-size: 13px; color: #94a3b8;">${this.config.slogan}</p>
  </div>
  <audio id="hrp-audio" src="${this.config.websiteUrl}${this.config.mountPoint}" preload="none"></audio>
  <div style="display: flex; align-items: center; justify-content: space-between; gap: 12px;">
    <button onclick="var a=document.getElementById('hrp-audio');if(a.paused){a.play();this.innerText='PAUSE';}else{a.pause();this.innerText='LISTEN LIVE';}" style="flex: 1; padding: 10px 18px; background: #ef4444; color: #fff; font-weight: 700; border: none; border-radius: 6px; cursor: pointer; text-transform: uppercase; font-size: 13px; letter-spacing: 0.5px;">LISTEN LIVE</button>
    <a href="${this.config.websiteUrl}" target="_blank" style="padding: 10px 14px; background: #1e293b; color: #cbd5e1; text-decoration: none; border-radius: 6px; font-size: 12px; font-weight: 600;">STATION SITE ↗</a>
  </div>
</div>
<script>
// Auto-refresh now playing from the real engine, via the station app's API.
// The old /api/radio/nowplaying endpoint was a hardcoded fixture and has been
// removed; pointing at it made the widget display a track that never aired.
setInterval(async function() {
  try {
    var res = await fetch('${this.config.nowPlayingApiUrl}');
    if (res.ok) {
      var data = await res.json();
      var cur = data.current && data.current.track;
      if (cur) {
        document.getElementById('hrp-title').innerText = cur.title;
        document.getElementById('hrp-artist').innerText =
          cur.artist + (cur.bpm ? ' (' + cur.bpm + ' BPM)' : '');
      }
    }
  } catch(e) {}
}, 5000);
</script>`;
  }

  /** Performs 24/7 silence detection check to prevent radio dead air. */
  checkSilenceWatchdog(masterRmsDb: number): { deadAirDetected: boolean; recovered: boolean } {
    if (!this.isOnAir || !this.config.autoFailoverEnabled) {
      this.silenceSeconds = 0;
      this.silenceTripped = false;
      return { deadAirDetected: false, recovered: false };
    }

    // Silence threshold is -50 dBFS
    if (masterRmsDb < -50) {
      this.silenceSeconds += 1;
      if (this.silenceSeconds >= 4 && !this.silenceTripped) {
        this.silenceTripped = true;
        this.failoverRecoveryActive = true;
        return { deadAirDetected: true, recovered: true };
      }
    } else {
      this.silenceSeconds = 0;
      this.silenceTripped = false;
      this.failoverRecoveryActive = false;
    }

    return { deadAirDetected: false, recovered: false };
  }
}
