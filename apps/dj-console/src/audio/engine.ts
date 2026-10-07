/**
 * The new console's audio adapter: one Mixer, manual mixing on, plus the few
 * behaviours the engine doesn't have (a CUE button, loading only into a stopped
 * deck, the 3-band waveform, saving a recording).
 *
 * Views read live state straight from `mixer` every frame; this file only
 * performs actions.
 */
import { Mixer } from "@ncsound/dj-engine/mixer";
import { Sampler } from "@ncsound/dj-engine/sampler";
import type { CuePoints, TrackAnalysis } from "@ncsound/dj-engine/engine/types";
import { computeWaveform, type DeckWaveform } from "./waveform";
import { HeadphoneCue } from "./outputs";

export type Slot = 0 | 1;
export type HotCueKey = keyof CuePoints;
export const HOT_CUES: Array<{ key: HotCueKey; label: string }> = [
  { key: "intro", label: "Intro" },
  { key: "drop", label: "Drop" },
  { key: "breakdown", label: "Break" },
  { key: "outro", label: "Outro" },
];

export type LoadedTrack = {
  title: string;
  artist: string;
  fileName: string;
  waveform: DeckWaveform;
  seq: number;
  durationSec: number;
  /** Set when the track came from the library, so play history can reference it. */
  libraryId?: string;
};

/** Metadata and a cached analysis, passed when loading from the library (plan 4.1). */
export type LoadOptions = {
  title?: string;
  artist?: string;
  fileName?: string;
  libraryId?: string;
  /** Complete analysis from the cache, so `loadBuffer` skips the main-thread pass. */
  overrideAnalysis?: Partial<TrackAnalysis>;
  /** Pre-computed scrolling waveform from the cache. */
  waveform?: DeckWaveform;
};

export const deckName = (s: Slot) => (s === 0 ? "A" : "B");

/** "Artist - Title.mp3" -> { artist, title }; no ID3 parsing yet. */
export function parseTrackName(fileName: string): { artist: string; title: string } {
  const base = fileName.replace(/\.[a-z0-9]{2,5}$/i, "").replace(/_/g, " ").trim();
  const i = base.indexOf(" - ");
  return i > 0 ? { artist: base.slice(0, i).trim(), title: base.slice(i + 3).trim() } : { artist: "", title: base };
}

let seq = 0;

export class ConsoleAudio {
  readonly mixer: Mixer;
  /** Headphone cue on a second output device (plan 3A). */
  readonly headphone: HeadphoneCue;
  /** One-shot sampler, routed pre-limiter into the master bus (plan 3C). */
  readonly sampler: Sampler;
  readonly tracks: [LoadedTrack | null, LoadedTrack | null] = [null, null];
  /** CUE point per deck (track seconds). */
  readonly cuePoint: [number | null, number | null] = [null, null];
  readonly loading: [boolean, boolean] = [false, false];

  constructor(mixer = new Mixer()) {
    this.mixer = mixer;
    this.mixer.manualMix = true;
    this.headphone = new HeadphoneCue(this.mixer);
    this.sampler = new Sampler(this.mixer.ctx, this.mixer.masterGain, (division, now) => this.mixer.nextGridTime(division, now));
  }

  /** Route a deck to the headphone cue bus (plan 3A.3). */
  setDeckCue(slot: Slot, on: boolean): void {
    this.mixer.setDeckCue(slot, on);
  }

  triggerPad(bank: number, pad: number, velocity = 1): number | null {
    return this.sampler.trigger(bank, pad, { velocity });
  }

  deck(slot: Slot) {
    return this.mixer.decks[slot];
  }

  /** Browsers start the context suspended until a user gesture. */
  async resume(): Promise<void> {
    if (this.mixer.ctx.state !== "running") await this.mixer.ctx.resume();
  }

  async load(slot: Slot, file: Blob, opts: LoadOptions = {}): Promise<void> {
    const fileName = opts.fileName ?? (typeof (file as File).name === "string" ? (file as File).name : "track");
    this.beginLoad(slot, fileName, opts.libraryId);
    try {
      const buf = await this.decode(fileName, await file.arrayBuffer());
      this.install(slot, buf, opts, fileName);
    } finally {
      this.loading[slot] = false;
    }
  }

  /**
   * Load an already-decoded buffer. The library decodes once, analyses in a
   * Worker, then hands the same buffer here so playback never re-decodes.
   */
  async loadDecoded(slot: Slot, buf: AudioBuffer, opts: LoadOptions = {}): Promise<void> {
    const fileName = opts.fileName ?? "track";
    this.beginLoad(slot, fileName, opts.libraryId);
    try {
      this.install(slot, buf, opts, fileName);
    } finally {
      this.loading[slot] = false;
    }
  }

  private beginLoad(slot: Slot, fileName: string, libraryId?: string): void {
    const d = this.deck(slot);
    if (d.playing) throw new Error(`Deck ${deckName(slot)} is playing. Pause it before loading.`);
    if (this.loading[slot]) throw new Error(`Deck ${deckName(slot)} is still loading.`);
    void fileName;
    void libraryId;
    this.loading[slot] = true;
  }

  private async decode(fileName: string, bytes: ArrayBuffer): Promise<AudioBuffer> {
    try {
      return await this.mixer.ctx.decodeAudioData(bytes);
    } catch {
      throw new Error(`Couldn't decode ${fileName}. Use MP3, WAV, AAC, OGG or FLAC.`);
    }
  }

  private install(slot: Slot, buf: AudioBuffer, opts: LoadOptions, fileName: string): void {
    // A cached override means `loadBuffer` skips `analyze()` entirely; that is
    // what makes loading an indexed track not freeze the screen (plan 4.1).
    const analysis = this.mixer.loadBuffer(slot, buf, opts.overrideAnalysis);
    const fallback = parseTrackName(fileName);
    const title = opts.title?.trim() || fallback.title;
    const artist = opts.artist?.trim() || fallback.artist;
    this.tracks[slot] = {
      title,
      artist,
      fileName,
      waveform: opts.waveform ?? computeWaveform(buf),
      seq: ++seq,
      durationSec: buf.duration,
      libraryId: opts.libraryId,
    };
    this.cuePoint[slot] = analysis.firstBeat;
  }

  async togglePlay(slot: Slot): Promise<boolean> {
    await this.resume();
    if (!this.deck(slot).buffer) return false;
    return this.mixer.toggleDeckPlay(slot);
  }

  /**
   * CUE, CDJ style: while playing, stop and return to the cue point; while
   * stopped, set the cue point at the (beat-snapped) playhead.
   */
  cue(slot: Slot): void {
    const d = this.deck(slot);
    if (!d.buffer || !d.analysis) return;
    if (d.playing) {
      this.mixer.toggleDeckPlay(slot);
      this.mixer.seekDeckContinuous(slot, this.cuePoint[slot] ?? d.analysis.firstBeat);
    } else {
      this.mixer.seekDeck(slot, d.currentOffset());
      this.cuePoint[slot] = d.currentOffset();
    }
  }

  /** Jump to a hot cue, or with `set`, store the playhead in it. */
  hotCue(slot: Slot, key: HotCueKey, set = false): void {
    const d = this.deck(slot);
    if (!d.analysis) return;
    if (set) {
      this.mixer.setHotCue(slot, key);
      return;
    }
    const t = d.analysis.cuePoints?.[key];
    if (t != null) this.mixer.seekDeck(slot, t);
  }

  loop(slot: Slot, action: "toggle" | "halve" | "double"): void {
    const d = this.deck(slot);
    if (!d.analysis) return;
    if (action === "halve") d.halveLoop();
    else if (action === "double") d.doubleLoop();
    else d.setLoop(d.loopBars > 0 ? d.loopBars : d.lastLoopBars);
  }

  /** Sync is offered only when the other deck has a track to sync to. */
  canSync(slot: Slot): boolean {
    return !!this.deck(slot).analysis && !!this.deck((1 - slot) as Slot).analysis;
  }

  sync(slot: Slot): void {
    if (this.canSync(slot)) this.mixer.syncDeck(slot);
  }

  nudge(slot: Slot, seconds: number): void {
    if (this.deck(slot).buffer) this.mixer.nudgePlayhead(slot, seconds);
  }

  /** Starts or stops the set recording; stopping downloads the file. */
  async toggleRecording(): Promise<{ recording: boolean; message: string }> {
    await this.resume();
    const r = await this.mixer.toggleRecording();
    if (!r.ok) return { recording: false, message: r.message };
    if (r.blob) {
      const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "");
      const a = document.createElement("a");
      a.href = URL.createObjectURL(r.blob);
      a.download = `ncsound-set-${stamp}.${r.ext ?? "webm"}`;
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
      return { recording: false, message: `Recording saved as ${a.download}` };
    }
    return { recording: true, message: "" };
  }
}
