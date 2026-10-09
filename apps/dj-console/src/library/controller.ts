/**
 * The library controller (plan phase 4).
 *
 * Owns the in-memory track list, the background analysis queue, the Up Next
 * queue, crates and the session history. It is the only writer to
 * `libraryStore`; the Library view reads it.
 *
 * Decoding stays on the main thread (as plan 4.1 specifies — `decodeAudioData`
 * is async and decodes off-thread internally); analysis and the fine waveform
 * run in a Worker, so a 300-track index never blocks a frame. Indexing pauses
 * while either deck is loading.
 */
import type { ConsoleAudio, LoadOptions, Slot } from "../audio/engine";
import { consoleStore, setDeckMsg } from "../state/console";
import { Store } from "../state/store";
import { onFrame } from "../app/scheduler";
import { analyzeChannelsInline, AnalysisRunner } from "./analysisRunner";
import { getCachedAnalysis, putCachedAnalysis, requestPersistentStorage, analysisCacheStats } from "./analysisCache";
import { cacheKeyFor, hashBytes } from "./hash";
import { dequeueAt, enqueue, exportName, nextUp, toHistoryCsv, toM3U8 } from "./crates";
import { AudibleLogger } from "./history";
import type { LibraryQuery } from "./search";
import type { AnalysisRecord, CrateRecord, HistoryEntry, LibraryTrack } from "./types";
import { getAllTracks, getCrates, getHandle, getMeta, getTrackBlob, putCrate, putHandle, putMeta, putTrack, putTrackBlob, removeTrack, removeTrackBlob, META_HISTORY, META_QUEUE } from "./persist";
import { folderSupported, folderTrack, getFileByPath, listFolderFiles, pickFolder, readFolderFile, type FsDirHandle } from "./sources/folder";
import { fetchStationCrate, stationAudioUrl, stationTrack } from "./sources/station";
import { fetchR2Catalog, r2Track } from "./sources/r2";
import { cachedOfflineKeys, fetchR2Audio, pinOffline, type PinProgress } from "./sources/r2Cache";
import { tracksFromFiles } from "./sources/files";
import { measureLoudness as measureTrackLoudness, normalizeTrack as normalizeTrackBytes, type Loudness } from "../services/transcode";
import { publishFeatureVector } from "../services/vectorize";
import type { TrackAnalysis } from "@ncsound/station-core";

export type LibraryIndex = {
  total: number;
  ready: number;
  failed: number;
  pending: number;
  running: boolean;
  current: string;
};

export type LibraryState = {
  tracks: LibraryTrack[];
  query: LibraryQuery;
  queue: string[];
  crates: CrateRecord[];
  history: HistoryEntry[];
  index: LibraryIndex;
  /** A one-line explanation of a source that could not load (station, folder). */
  note: string;
  persisted: boolean | null;
  usageBytes: number | null;
};

const HEAD_BYTES = 64 * 1024;
/** Most recent set-history entries kept in memory and persisted. */
const HISTORY_MAX = 500;

export const libraryStore = new Store<LibraryState>({
  tracks: [],
  query: { text: "", matchesOnly: false, sort: "artist", desc: false, target: null },
  queue: [],
  crates: [],
  history: [],
  index: { total: 0, ready: 0, failed: 0, pending: 0, running: false, current: "" },
  note: "",
  persisted: null,
  usageBytes: null,
});

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class LibraryController {
  private readonly runner = new AnalysisRunner();
  private readonly logger = new AudibleLogger();
  private pending: string[] = [];
  private indexing = false;
  private hidden = false;
  private stopFrames: (() => void) | null = null;

  constructor(private readonly audio: ConsoleAudio) {}

  /** Load persisted state, then start the background indexer. */
  async boot(): Promise<void> {
    await this.restore();
    this.startIndexing();
    void requestPersistentStorage().then((persisted) => libraryStore.set({ persisted }));
    void this.refreshStorage();
    this.stopFrames = onFrame(() => this.tick());
  }

  private async restore(): Promise<void> {
    try {
      const [tracks, crates, queue, history] = await Promise.all([
        getAllTracks(),
        getCrates(),
        getMeta<string[]>(META_QUEUE),
        getMeta<HistoryEntry[]>(META_HISTORY),
      ]);
      // A recovered "analysing" state is stale: nothing is running after a reload.
      const normalised = tracks.map((t) =>
        t.status === "analysing" ? { ...t, status: "queued" as const } : t,
      );
      libraryStore.set({
        tracks: normalised,
        crates: crates ?? [],
        queue: queue ?? [],
        history: history ?? [],
      });
      this.enqueueIndex(normalised.filter((t) => t.status !== "ready" && t.status !== "failed" && t.source !== "r2").map((t) => t.id));
      this.recomputeIndex();
    } catch {
      // IndexedDB unavailable: run in memory only.
      libraryStore.set({ note: "Browser storage is unavailable, so the library won't persist." });
    }
  }

  /* ---------- adding tracks ---------- */

  async addFiles(files: FileList | File[]): Promise<void> {
    const added = await tracksFromFiles(files);
    if (!added.length) {
      libraryStore.set({ note: "No audio files in that drop." });
      return;
    }
    const existing = new Set(libraryStore.get().tracks.map((t) => t.id));
    const fresh: LibraryTrack[] = [];
    for (const { track, file } of added) {
      if (existing.has(track.id)) continue;
      // Mark it seen as we go: without this, two files that derive the same id
      // in one drop both pass the check and the library renders a duplicate.
      existing.add(track.id);
      fresh.push(track);
      void putTrackBlob(track.id, file).catch(() => undefined);
      void putTrack(track).catch(() => undefined);
    }
    if (!fresh.length) {
      libraryStore.set({ note: "Those files are already in the library." });
      return;
    }
    this.insert(fresh);
    this.enqueueIndex(fresh.map((t) => t.id));
    void this.refreshStorage();
  }

  async addFolder(): Promise<void> {
    if (!folderSupported()) {
      libraryStore.set({ note: "Folder import needs Chrome or Edge (File System Access API)." });
      return;
    }
    let dir: FsDirHandle;
    try {
      dir = await pickFolder();
    } catch (e) {
      // The user cancelling the picker is not an error worth a banner.
      if (e instanceof DOMException && e.name === "AbortError") return;
      libraryStore.set({ note: e instanceof Error ? e.message : "Could not open that folder." });
      return;
    }
    const handleId = `dir-${Date.now().toString(36)}`;
    try {
      const entries = await listFolderFiles(dir);
      if (!entries.length) {
        libraryStore.set({ note: "No audio files found in that folder." });
        return;
      }
      const existing = new Set(libraryStore.get().tracks.map((t) => t.id));
      const fresh: LibraryTrack[] = [];
      for (const entry of entries) {
        const file = await readFolderFile(entry.handle).catch(() => null);
        if (!file) continue;
        const track = folderTrack(handleId, entry.path, file);
        track.lastModified = file.lastModified;
        if (existing.has(track.id)) continue;
        fresh.push(track);
        void putTrack(track).catch(() => undefined);
      }
      await putHandle(handleId, dir as unknown as FileSystemDirectoryHandle).catch(() => undefined);
      this.insert(fresh);
      this.enqueueIndex(fresh.map((t) => t.id));
    } catch (e) {
      libraryStore.set({ note: e instanceof Error ? e.message : "Could not read that folder." });
    }
  }

  async addStation(): Promise<void> {
    try {
      const items = await fetchStationCrate();
      const existing = new Set(libraryStore.get().tracks.map((t) => t.id));
      const fresh = items.map(stationTrack).filter((t) => !existing.has(t.id));
      this.insert(fresh);
      this.enqueueIndex(fresh.map((t) => t.id));
      libraryStore.set({ note: fresh.length ? `Added ${fresh.length} tracks from the station crate.` : "Station crate already imported." });
    } catch (e) {
      libraryStore.set({ note: e instanceof Error ? e.message : "Station library unavailable." });
    }
  }

  /**
   * Import the Cloudflare R2 library. The catalog is small (a JSON list) but the
   * audio is not on disk, so each track is fetched over HTTP the first time it
   * is indexed or loaded and then cached by the analysis cache.
   */
  async addR2(): Promise<void> {
    try {
      const items = await fetchR2Catalog();
      const existing = new Set(libraryStore.get().tracks.map((t) => t.id));
      const fresh = items.map(r2Track).filter((t) => !existing.has(t.id));
      this.insert(fresh);
      // Not indexed in the background: that would download the whole bucket
      // (GBs) over whatever network this is. A track is analysed when it is
      // loaded, pinned offline, or indexed on request.
      libraryStore.set({ note: fresh.length ? `Added ${fresh.length} tracks from R2 (ncsound-media). Analysed when loaded or saved offline.` : "R2 library already imported." });
    } catch (e) {
      libraryStore.set({ note: e instanceof Error ? e.message : "R2 library unavailable." });
    }
  }

  /**
   * Save the Up Next queue's R2 tracks (or, with none queued, the given ids)
   * for offline use, then analyse them. Returns what happened, in words.
   */
  async saveOffline(ids?: string[]): Promise<string> {
    const s = libraryStore.get();
    const want = new Set(ids ?? s.queue);
    const tracks = s.tracks.filter((t) => want.has(t.id) && t.source === "r2" && (t.r2Key ?? t.path));
    if (!tracks.length) return "Queue R2 tracks first (Up Next), then save them offline.";
    const keys = tracks.map((t) => (t.r2Key ?? t.path) as string);
    const had = await cachedOfflineKeys();
    const todo = keys.filter((k) => !had.has(k));
    const report = (p: PinProgress) =>
      libraryStore.set({ note: `Saving offline: ${p.done}/${p.total} (${(p.bytes / 1e6).toFixed(0)} MB)${p.failed.length ? `, ${p.failed.length} failed` : ""}` });
    const p = await pinOffline(todo, report);
    this.enqueueIndex(tracks.map((t) => t.id));
    const msg = `${keys.length - p.failed.length}/${keys.length} tracks saved offline${p.failed.length ? `; failed: ${p.failed.map((k) => k.split("/").pop()).join(", ")}` : ""}.`;
    libraryStore.set({ note: msg });
    return msg;
  }

  private insert(tracks: LibraryTrack[]): void {
    if (!tracks.length) return;
    libraryStore.set((s) => ({ tracks: [...s.tracks, ...tracks] }));
    this.recomputeIndex();
  }

  /* ---------- background indexing ---------- */

  private enqueueIndex(ids: string[]): void {
    const have = new Set(this.pending);
    for (const id of ids) if (!have.has(id)) this.pending.push(id);
    // The loop exits when the queue drains; a later add must restart it.
    if (this.pending.length) this.startIndexing();
  }

  private startIndexing(): void {
    if (this.indexing) return;
    this.indexing = true;
    libraryStore.set((s) => ({ index: { ...s.index, running: true } }));
    void this.indexLoop();
  }

  private async indexLoop(): Promise<void> {
    try {
      for (;;) {
        // Pause while a deck is loading or the tab is hidden (plan 4.4): the
        // main thread is busy, and chewing CPU there would starve the deck.
        while (this.hidden || this.audio.loading[0] || this.audio.loading[1]) await delay(300);
        const id = this.pending.shift();
        if (id === undefined) break;
        const track = this.find(id);
        if (!track || track.status === "ready") continue;
        await this.indexTrack(track);
      }
    } finally {
      this.indexing = false;
      libraryStore.set((s) => ({ index: { ...s.index, running: false, current: "" } }));
      this.recomputeIndex();
    }
  }

  private async indexTrack(track: LibraryTrack): Promise<void> {
    this.patchTrack(track.id, { status: "analysing", error: undefined });
    libraryStore.set((s) => ({ index: { ...s.index, current: track.fileName } }));
    try {
      const bytes = await this.readBytes(track);
      const record = await this.analyseBytes(track, bytes);
      this.patchTrack(track.id, {
        status: "ready",
        error: undefined,
        cacheKey: record.cacheKey,
        durationSec: record.durationSec,
        bpm: record.analysis.bpm ?? null,
        key: record.analysis.key ?? null,
      });
      this.publishVector(track, record.analysis);
    } catch (e) {
      this.patchTrack(track.id, { status: "failed", error: e instanceof Error ? e.message : String(e) });
    }
    this.recomputeIndex();
  }

  /**
   * Publish an R2 track's audio fingerprint to the Vectorize index. Best-effort,
   * and only for R2 tracks: a local file/folder track has no object key to key
   * the index by (the listener app only ever sees R2 keys).
   */
  private publishVector(track: LibraryTrack, analysis: TrackAnalysis): void {
    if (track.source !== "r2" || !track.r2Key) return;
    void publishFeatureVector(track.r2Key, analysis, {
      title: track.title,
      artist: track.artist,
      album: track.album ?? "",
      bpm: analysis.bpm ?? 0,
      key: analysis.key ?? "",
    }).catch(() => undefined);
  }

  /**
   * Decode, then analyse in the Worker (or inline where there is no Worker).
   * Returns a cache record, writing it only when it was freshly computed.
   */
  private async analyseBytes(track: LibraryTrack, bytes: ArrayBuffer): Promise<AnalysisRecord> {
    const head = new Uint8Array(bytes.slice(0, Math.min(bytes.byteLength, HEAD_BYTES)));
    const cacheKey = cacheKeyFor(track.fileName, bytes.byteLength, track.lastModified, hashBytes(head));
    const cached = await getCachedAnalysis(cacheKey).catch(() => undefined);
    if (cached) return cached;

    const buf = await this.audio.mixer.ctx.decodeAudioData(bytes);
    const channels = copyChannels(buf);
    const result = this.runner.supported
      ? await this.runner.analyze(channels, buf.sampleRate)
      : analyzeChannelsInline(channels, buf.sampleRate);
    const record: AnalysisRecord = {
      cacheKey,
      durationSec: buf.duration,
      analysis: result.analysis,
      waveform: result.waveform,
      analysedAtMs: Date.now(),
    };
    void putCachedAnalysis(record).catch(() => undefined);
    return record;
  }

  /* ---------- loading to a deck ---------- */

  /** Load a library track onto a deck. Returns true only when it actually loaded. */
  async loadToDeck(slot: Slot, trackId: string, opts: { refuseIfPlaying?: boolean } = {}): Promise<boolean> {
    const track = this.find(trackId);
    if (!track) return false;
    if (opts.refuseIfPlaying !== false && this.audio.deck(slot).playing) {
      setDeckMsg(slot, `Deck ${slot === 0 ? "A" : "B"} is playing. Pause it before loading.`);
      return false;
    }
    setDeckMsg(slot, `Loading ${track.title}…`);
    consoleStore.set({ focusDeck: slot });
    try {
      const bytes = await this.readBytes(track);
      const head = new Uint8Array(bytes.slice(0, Math.min(bytes.byteLength, HEAD_BYTES)));
      const cacheKey = cacheKeyFor(track.fileName, bytes.byteLength, track.lastModified, hashBytes(head));
      let record = await getCachedAnalysis(cacheKey).catch(() => undefined);
      const buf = await this.audio.mixer.ctx.decodeAudioData(bytes);
      if (!record) {
        const channels = copyChannels(buf);
        const result = this.runner.supported
          ? await this.runner.analyze(channels, buf.sampleRate)
          : analyzeChannelsInline(channels, buf.sampleRate);
        record = { cacheKey, durationSec: buf.duration, analysis: result.analysis, waveform: result.waveform, analysedAtMs: Date.now() };
        void putCachedAnalysis(record).catch(() => undefined);
        this.patchTrack(trackId, {
          status: "ready",
          error: undefined,
          cacheKey,
          durationSec: record.durationSec,
          bpm: record.analysis.bpm ?? null,
          key: record.analysis.key ?? null,
        });
      }
      const loadOpts: LoadOptions = {
        title: track.title,
        artist: track.artist,
        fileName: track.fileName,
        libraryId: track.id,
        overrideAnalysis: record.analysis,
        waveform: record.waveform,
      };
      await this.audio.loadDecoded(slot, buf, loadOpts);
      this.logger.reset(slot);
      consoleStore.set((s) => {
        const loadSeq: [number, number] = [...s.loadSeq];
        loadSeq[slot]++;
        return { loadSeq };
      });
      return true;
    } catch (e) {
      setDeckMsg(slot, e instanceof Error ? e.message : `Couldn't load ${track.title}.`);
      return false;
    }
  }

  /**
   * Load the head of the Up Next queue into the idle deck and advance the queue.
   *
   * The head is removed only when the load succeeded, so a refused load (both
   * decks playing, a decode failure) leaves the queue intact rather than
   * silently dropping a track.
   */
  async loadNext(): Promise<boolean> {
    const id = nextUp(libraryStore.get().queue);
    if (!id) return false;
    const idle: Slot = this.audio.deck(0).playing ? 1 : 0;
    const ok = await this.loadToDeck(idle, id);
    if (ok) this.removeQueueAt(0);
    return ok;
  }

  /* ---------- loudness / transcode (Cloudflare Container) ---------- */

  /** EBU R128 loudness for a library track, via the ffmpeg Container. */
  async measureLoudness(trackId: string): Promise<Loudness> {
    const track = this.find(trackId);
    if (!track) throw new Error("Track not found.");
    return measureTrackLoudness(await this.readBytes(track));
  }

  /** Re-encode a library track to MP3 and return the bytes. */
  async normalizeTrack(trackId: string): Promise<Blob> {
    const track = this.find(trackId);
    if (!track) throw new Error("Track not found.");
    return normalizeTrackBytes(await this.readBytes(track));
  }

  /* ---------- sources of bytes ---------- */

  private async readBytes(track: LibraryTrack): Promise<ArrayBuffer> {
    if (track.source === "files") {
      const blob = await getTrackBlob(track.id);
      if (!blob) throw new Error("The uploaded file is no longer in browser storage.");
      return blob.arrayBuffer();
    }
    if (track.source === "folder") {
      if (!track.handleId) throw new Error("This folder track has no stored handle.");
      const dir = (await getHandle(track.handleId)) as unknown as FsDirHandle | undefined;
      if (!dir) throw new Error("The folder handle is gone. Re-add the folder.");
      const file = await getFileByPath(dir, track.path ?? track.fileName);
      return file.arrayBuffer();
    }
    if (track.source === "r2") {
      const key = track.r2Key ?? track.path;
      if (!key) throw new Error("This R2 track has no object key.");
      return fetchR2Audio(key);
    }
    // station
    const url = stationAudioUrl(track.stationId ?? track.id);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Station audio unavailable (${res.status}).`);
    return res.arrayBuffer();
  }

  /* ---------- queue, crates ---------- */

  toggleQueue(trackId: string): void {
    libraryStore.set((s) => ({ queue: enqueue(s.queue, trackId) }));
    void putMeta(META_QUEUE, libraryStore.get().queue).catch(() => undefined);
  }

  removeQueueAt(index: number): void {
    libraryStore.set((s) => ({ queue: dequeueAt(s.queue, index) }));
    void putMeta(META_QUEUE, libraryStore.get().queue).catch(() => undefined);
  }

  clearQueue(): void {
    libraryStore.set({ queue: [] });
    void putMeta(META_QUEUE, []).catch(() => undefined);
  }

  saveCrate(name: string): void {
    this.saveCrateFromSelection(name, [...libraryStore.get().queue]);
  }

  async saveCrateFromSelection(name: string, trackIds: string[]): Promise<void> {
    const trimmed = name.trim();
    if (!trimmed) return;
    const crate: CrateRecord = { name: trimmed, trackIds, updatedAtMs: Date.now() };
    libraryStore.set((s) => ({ crates: [...s.crates.filter((c) => c.name !== trimmed), crate] }));
    await putCrate(crate).catch(() => undefined);
  }

  loadCrate(name: string): void {
    const crate = libraryStore.get().crates.find((c) => c.name === name);
    if (crate) {
      libraryStore.set({ queue: [...crate.trackIds] });
      void putMeta(META_QUEUE, crate.trackIds).catch(() => undefined);
    }
  }

  exportCrate(name: string): void {
    const crate = libraryStore.get().crates.find((c) => c.name === name);
    if (!crate) return;
    const byId = new Map(libraryStore.get().tracks.map((t) => [t.id, t]));
    const tracks = crate.trackIds.map((id) => byId.get(id)).filter((t): t is LibraryTrack => !!t);
    download(toM3U8(tracks), exportName(`crate-${name}`, "m3u8"), "audio/x-mpegurl");
  }

  exportHistory(): void {
    download(toHistoryCsv(libraryStore.get().history), exportName("history", "csv"), "text/csv");
  }

  /* ---------- search ---------- */

  setQuery(patch: Partial<LibraryQuery>): void {
    libraryStore.set((s) => ({ query: { ...s.query, ...patch } }));
  }

  /** Reference for the ±6% BPM / harmonic highlight: the audible deck's effective key. */
  setMatchTargetDeck(): void {
    const active: Slot = this.audio.deck(0).playing ? 0 : this.audio.deck(1).playing ? 1 : 0;
    const d = this.audio.deck(active);
    const bpm = d.analysis ? d.analysis.bpm * d.rate : null;
    libraryStore.set((s) => ({
      query: { ...s.query, target: d.analysis && bpm ? { bpm, key: d.getEffectiveKey() || undefined } : null },
    }));
  }

  private tick(): void {
    const [gA, gB] = this.audio.mixer.computeCrossfaderGains();
    const gains = [gA, gB];
    const now = Date.now();
    for (const slot of [0, 1] as Slot[]) {
      const d = this.audio.deck(slot);
      const loaded = this.audio.tracks[slot];
      const entry = this.logger.observe({
        slot,
        playing: d.playing,
        gain: d.channelVolume * gains[slot],
        track: loaded
          ? {
              trackId: loaded.libraryId ?? loaded.fileName,
              title: loaded.title,
              artist: loaded.artist,
              fileName: loaded.fileName,
              bpm: d.analysis?.bpm ?? 0,
              key: d.getEffectiveKey() ?? "",
              durationSec: loaded.durationSec,
            }
          : null,
        nowMs: now,
      });
      if (entry) this.pushHistory(entry);
    }
  }

  private pushHistory(entry: HistoryEntry): void {
    // Bounded: a long set would otherwise grow this without limit and rewrite
    // the whole array to IndexedDB on every entry.
    const history = [...libraryStore.get().history, entry].slice(-HISTORY_MAX);
    libraryStore.set({ history });
    void putMeta(META_HISTORY, history).catch(() => undefined);
    const i = libraryStore.get().tracks.findIndex((t) => t.id === entry.trackId);
    if (i >= 0) this.patchTrack(entry.trackId, { playedAtMs: entry.startedAtMs });
  }

  /* ---------- housekeeping ---------- */

  remove(trackId: string): void {
    const track = this.find(trackId);
    libraryStore.set((s) => ({
      tracks: s.tracks.filter((t) => t.id !== trackId),
      queue: s.queue.filter((id) => id !== trackId),
    }));
    this.pending = this.pending.filter((id) => id !== trackId);
    void removeTrack(trackId).catch(() => undefined);
    if (track?.source === "files") void removeTrackBlob(trackId).catch(() => undefined);
    this.recomputeIndex();
  }

  private find(id: string): LibraryTrack | undefined {
    return libraryStore.get().tracks.find((t) => t.id === id);
  }

  private patchTrack(id: string, patch: Partial<LibraryTrack>): void {
    let updated: LibraryTrack | undefined;
    libraryStore.set((s) => {
      const i = s.tracks.findIndex((t) => t.id === id);
      if (i < 0) return {};
      const tracks = s.tracks.slice();
      updated = { ...tracks[i], ...patch };
      tracks[i] = updated;
      return { tracks };
    });
    if (updated) void putTrack(updated).catch(() => undefined);
  }

  private recomputeIndex(): void {
    const tracks = libraryStore.get().tracks;
    let ready = 0;
    let failed = 0;
    for (const t of tracks) {
      if (t.status === "ready") ready++;
      else if (t.status === "failed") failed++;
    }
    libraryStore.set({ index: { total: tracks.length, ready, failed, pending: tracks.length - ready - failed, running: this.indexing, current: libraryStore.get().index.current } });
  }

  private async refreshStorage(): Promise<void> {
    try {
      const stats = await analysisCacheStats();
      libraryStore.set({ usageBytes: stats.bytes });
    } catch {
      /* ignore */
    }
  }

  /** Called by the view when the tab is hidden, so indexing yields the CPU. */
  setHidden(hidden: boolean): void {
    this.hidden = hidden;
  }

  dispose(): void {
    this.stopFrames?.();
    this.stopFrames = null;
    this.runner.terminate();
  }
}

function copyChannels(buf: AudioBuffer): Float32Array[] {
  const out: Float32Array[] = [];
  for (let c = 0; c < buf.numberOfChannels; c++) out.push(new Float32Array(buf.getChannelData(c)));
  return out;
}

function download(text: string, filename: string, mime: string): void {
  const blob = new Blob([text], { type: `${mime};charset=utf-8` });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
}
