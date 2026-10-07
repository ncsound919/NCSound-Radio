/**
 * Library tab (plan 4.5-4.9): search-first track list, virtualized rows,
 * harmonic/BPM matching highlight, Up Next queue, crates, set-history export.
 *
 * Reads `libraryStore`; every action goes through the controller, which owns
 * the analysis Worker and IndexedDB. Nothing here renders a number it wasn't
 * given: an unanalysed track shows "--" for BPM/key/time.
 */
import type { ConsoleAudio, Slot } from "../../audio/engine";
import { consoleStore } from "../../state/console";
import { libraryStore, type LibraryController } from "../../library/controller";
import { filterTracks, type LibrarySort, type ScoredTrack } from "../../library/search";
import type { LibraryTrack, TrackStatus } from "../../library/types";
import { key } from "../controls";
import "./library.css";

const ROW_H = 28;
const TRACK_MIME = "application/x-ncsound-track";

const STATUS_LABEL: Record<TrackStatus, string> = {
  unindexed: "—",
  queued: "queued",
  analysing: "analysing",
  ready: "ready",
  failed: "failed",
};

const SORTS: Array<{ sort: LibrarySort; label: string }> = [
  { sort: "artist", label: "Artist" },
  { sort: "title", label: "Title" },
  { sort: "bpm", label: "BPM" },
  { sort: "key", label: "Key" },
  { sort: "time", label: "Time" },
  { sort: "status", label: "Status" },
];

function div(cls: string, text?: string): HTMLDivElement {
  const d = document.createElement("div");
  d.className = cls;
  if (text !== undefined) d.textContent = text;
  return d;
}

function fmtDuration(sec: number | null): string {
  if (sec == null || !Number.isFinite(sec)) return "--";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec - m * 60);
  return `${m}:${s < 10 ? "0" : ""}${s}`;
}

function idleSlot(audio: ConsoleAudio): Slot | null {
  const p0 = audio.deck(0).playing;
  const p1 = audio.deck(1).playing;
  if (p0 && p1) return null;
  return p0 ? 1 : 0;
}

export function libraryView(audio: ConsoleAudio, controller: LibraryController): HTMLElement {
  const el = div("nc-library");
  el.setAttribute("aria-label", "Library");

  /* ---------- toolbar ---------- */
  const toolbar = div("nc-lib-toolbar");
  const search = document.createElement("input");
  search.type = "search";
  search.className = "nc-lib-search";
  search.placeholder = "Search artist, title, key, BPM (e.g. 8A, 120-126)";
  search.setAttribute("aria-label", "Search library");
  search.addEventListener("input", () => controller.setQuery({ text: search.value }));

  const matches = key({
    label: "Matches",
    toggle: true,
    onToggle: (on) => {
      controller.setMatchTargetDeck();
      controller.setQuery({ matchesOnly: on });
    },
  });
  matches.el.title = "Only tracks within ±6% of the playing deck and harmonically compatible";

  const fileInput = document.createElement("input");
  fileInput.type = "file";
  fileInput.accept = "audio/*,.mp3,.wav,.aiff,.aif,.flac,.ogg,.m4a";
  fileInput.multiple = true;
  fileInput.hidden = true;
  fileInput.addEventListener("change", () => {
    if (fileInput.files?.length) void controller.addFiles(fileInput.files);
    fileInput.value = "";
  });
  const addFiles = key({ label: "Add files", onPress: () => fileInput.click() });
  const addFolder = key({ label: "Folder", onPress: () => void controller.addFolder() });
  addFolder.el.title = "Index a folder on this computer (Chrome/Edge)";
  const addStation = key({ label: "Station", onPress: () => void controller.addStation() });
  addStation.el.title = "Import the station crate (station computer only)";
  const addR2 = key({ label: "R2", onPress: () => void controller.addR2() });
  addR2.el.title = "Import the Cloudflare R2 library (ncsound-media) through ncsound-api";

  const saveOffline = key({ label: "Offline", onPress: () => void controller.saveOffline() });
  saveOffline.el.title = "Save the Up Next queue's R2 tracks on this computer so they load without a network";

  const indexStatus = div("nc-lib-index", "");
  indexStatus.setAttribute("role", "status");
  toolbar.append(search, matches.el, addFiles.el, addFolder.el, addStation.el, addR2.el, saveOffline.el, fileInput, indexStatus);

  /* ---------- table ---------- */
  const body = div("nc-lib-body");
  const table = div("nc-lib-table nc-lib-cols");
  table.setAttribute("role", "table");
  table.setAttribute("aria-label", "Tracks");

  const head = div("nc-lib-head");
  head.setAttribute("role", "row");
  const headButtons = SORTS.map(({ sort, label }) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "nc-lib-sort";
    b.textContent = label;
    b.setAttribute("role", "columnheader");
    b.setAttribute("aria-label", `Sort by ${label}`);
    b.addEventListener("click", () => {
      const q = libraryStore.get().query;
      controller.setQuery({ sort, desc: q.sort === sort ? !q.desc : false });
    });
    head.append(b);
    return { sort, b };
  });
  const actHead = div("nc-lib-act");
  actHead.setAttribute("role", "columnheader");
  actHead.textContent = "";
  head.append(actHead);

  const scroll = div("nc-lib-scroll");
  scroll.setAttribute("role", "rowgroup");
  scroll.tabIndex = 0;
  scroll.setAttribute("aria-label", "Track list");
  const spacer = div("nc-lib-spacer");
  scroll.append(spacer);

  table.append(head, scroll);

  /* ---------- side ---------- */
  const side = div("nc-lib-side");

  const queuePanel = div("nc-lib-panel");
  const queueH = div("nc-lib-h", "Up Next");
  const queueList = document.createElement("ul");
  queueList.className = "nc-lib-list";
  queueList.setAttribute("aria-label", "Up Next queue");
  const queueActions = div("nc-lib-crate-row");
  const loadNext = key({ label: "Load next", onPress: () => void controller.loadNext() });
  const clearQ = key({ label: "Clear", onPress: () => controller.clearQueue() });
  loadNext.el.dataset.gridCell = "";
  clearQ.el.dataset.gridCell = "";
  queueActions.append(loadNext.el, clearQ.el);
  queuePanel.append(queueH, queueList, queueActions);

  const cratePanel = div("nc-lib-panel");
  const crateH = div("nc-lib-h", "Crates");
  const crateList = document.createElement("ul");
  crateList.className = "nc-lib-list";
  crateList.setAttribute("aria-label", "Crates");
  const crateRow = div("nc-lib-crate-row");
  const crateName = document.createElement("input");
  crateName.type = "text";
  crateName.className = "nc-lib-crate-name";
  crateName.placeholder = "New crate from queue";
  crateName.setAttribute("aria-label", "New crate name");
  const saveCrate = key({
    label: "Save",
    onPress: () => {
      controller.saveCrate(crateName.value);
      crateName.value = "";
    },
  });
  saveCrate.el.dataset.gridCell = "";
  crateRow.append(crateName, saveCrate.el);
  cratePanel.append(crateH, crateList, crateRow);

  const foot = div("nc-lib-foot");
  const note = div("nc-lib-note", "");
  const storage = div("nc-lib-storage", "");
  const exportHistory = key({ label: "Export history CSV", onPress: () => controller.exportHistory() });
  exportHistory.el.dataset.gridCell = "";
  foot.append(note, storage, exportHistory.el);
  side.append(queuePanel, cratePanel, foot);

  body.append(table, side);
  el.append(toolbar, body);

  /* ---------- rendering ---------- */
  let filtered: ScoredTrack[] = [];
  let selectedId: string | null = null;
  let renderQueued = false;

  function rowEl(sc: ScoredTrack, index: number): HTMLElement {
    const t = sc.track;
    const row = div("nc-lib-row");
    row.setAttribute("role", "row");
    row.setAttribute("aria-rowindex", String(index + 1));
    row.dataset.index = String(index);
    if (sc.matches) row.dataset.match = "true";
    if (t.id === selectedId) row.dataset.sel = "true";
    if (t.playedAtMs) row.dataset.played = "true";
    row.style.transform = `translateY(${index * ROW_H}px)`;
    row.draggable = true;

    const cell = (cls: string, text: string, extra = "") => {
      const c = div(`nc-lib-c nc-lib-${cls}${extra}`, text);
      c.setAttribute("role", "cell");
      return c;
    };
    row.append(
      cell("artist", t.artist),
      cell("title", t.title),
      cell("bpm", t.bpm != null ? t.bpm.toFixed(1) : "--"),
      cell("key", t.key ?? "--"),
      cell("time", fmtDuration(t.durationSec)),
      cell("status", STATUS_LABEL[t.status], ""),
    );
    const statusCell = row.querySelector(".nc-lib-status") as HTMLElement | null;
    if (statusCell) statusCell.dataset.status = t.status;

    const act = div("nc-lib-c nc-lib-act");
    act.setAttribute("role", "cell");
    const q = document.createElement("button");
    q.type = "button";
    q.className = "nc-key nc-lib-q";
    q.dataset.gridCell = "";
    q.textContent = "Q";
    q.title = "Add to Up Next";
    q.setAttribute("aria-label", `Add ${t.title} to Up Next`);
    q.addEventListener("click", (e) => {
      e.stopPropagation();
      controller.toggleQueue(t.id);
    });
    act.append(q);

    // ffmpeg container: measure EBU R128 loudness / normalise, via the console
    // server's /transcode proxy (token stays server-side).
    const lufs = document.createElement("button");
    lufs.type = "button";
    lufs.className = "nc-key nc-lib-q";
    lufs.dataset.gridCell = "";
    lufs.textContent = "LUFS";
    lufs.title = "Measure loudness (EBU R128)";
    lufs.setAttribute("aria-label", `Measure loudness of ${t.title}`);
    lufs.addEventListener("click", async (e) => {
      e.stopPropagation();
      consoleStore.set({ status: `Measuring ${t.title}\u2026` });
      try {
        const l = await controller.measureLoudness(t.id);
        const parts: string[] = [];
        if (l.integratedLufs != null) parts.push(`${l.integratedLufs.toFixed(1)} LUFS`);
        if (l.truePeakDbfs != null) parts.push(`${l.truePeakDbfs.toFixed(1)} dBTP`);
        if (l.lra != null) parts.push(`LRA ${l.lra.toFixed(1)}`);
        consoleStore.set({ status: `${t.title}: ${parts.join(" \u00b7 ") || "no measurement"}` });
      } catch (err) {
        consoleStore.set({ status: err instanceof Error ? err.message : "Loudness measure failed." });
      }
    });
    const norm = document.createElement("button");
    norm.type = "button";
    norm.className = "nc-key nc-lib-q";
    norm.dataset.gridCell = "";
    norm.textContent = "Norm";
    norm.title = "Normalise to MP3 (download)";
    norm.setAttribute("aria-label", `Normalise ${t.title}`);
    norm.addEventListener("click", async (e) => {
      e.stopPropagation();
      consoleStore.set({ status: `Normalising ${t.title}\u2026` });
      try {
        const blob = await controller.normalizeTrack(t.id);
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `${t.artist} - ${t.title}.mp3`.replace(/[\\/:*?"<>|]/g, "_");
        document.body.append(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 60_000);
        consoleStore.set({ status: `Normalised ${t.title} (${Math.round(blob.size / 1024)} KB).` });
      } catch (err) {
        consoleStore.set({ status: err instanceof Error ? err.message : "Normalise failed." });
      }
    });
    act.append(lufs, norm);
    row.append(act);

    row.addEventListener("click", () => {
      selectedId = t.id;
      schedule();
    });
    row.addEventListener("dblclick", () => loadToIdle(t.id));
    row.addEventListener("dragstart", (e) => {
      e.dataTransfer?.setData(TRACK_MIME, t.id);
      e.dataTransfer?.setData("text/plain", t.title);
      if (e.dataTransfer) e.dataTransfer.effectAllowed = "copy";
    });
    return row;
  }

  function renderRows(): void {
    const top = scroll.scrollTop;
    const viewH = scroll.clientHeight;
    const start = Math.max(0, Math.floor(top / ROW_H) - 6);
    const end = Math.min(filtered.length, Math.ceil((top + viewH) / ROW_H) + 6);
    spacer.style.height = `${filtered.length * ROW_H}px`;
    spacer.textContent = "";
    for (let i = start; i < end; i++) spacer.append(rowEl(filtered[i], i));
  }

  function renderSide(): void {
    const s = libraryStore.get();
    const byId = new Map(s.tracks.map((t) => [t.id, t]));

    queueList.textContent = "";
    if (!s.queue.length) {
      const li = document.createElement("li");
      li.className = "nc-lib-empty";
      li.textContent = "Nothing queued.";
      queueList.append(li);
    } else {
      s.queue.forEach((id, i) => {
        const t = byId.get(id);
        const li = document.createElement("li");
        li.className = "nc-lib-item";
        li.append(div("", t ? `${t.artist} – ${t.title}` : id));
        const remove = document.createElement("button");
        remove.type = "button";
        remove.className = "nc-key";
        remove.dataset.gridCell = "";
        remove.textContent = "×";
        remove.setAttribute("aria-label", `Remove ${t?.title ?? id} from Up Next`);
        remove.addEventListener("click", () => controller.removeQueueAt(i));
        li.append(remove);
        queueList.append(li);
      });
    }

    crateList.textContent = "";
    if (!s.crates.length) {
      const li = document.createElement("li");
      li.className = "nc-lib-empty";
      li.textContent = "No crates yet.";
      crateList.append(li);
    } else {
      for (const crate of s.crates) {
        const li = document.createElement("li");
        li.className = "nc-lib-item";
        li.append(div("", `${crate.name} (${crate.trackIds.length})`));
        const load = document.createElement("button");
        load.type = "button";
        load.className = "nc-key";
        load.dataset.gridCell = "";
        load.textContent = "Load";
        load.setAttribute("aria-label", `Load crate ${crate.name} into Up Next`);
        load.addEventListener("click", () => controller.loadCrate(crate.name));
        const exp = document.createElement("button");
        exp.type = "button";
        exp.className = "nc-key";
        exp.dataset.gridCell = "";
        exp.textContent = "M3U8";
        exp.setAttribute("aria-label", `Export crate ${crate.name} as M3U8`);
        exp.addEventListener("click", () => controller.exportCrate(crate.name));
        const wrap = div("nc-lib-crate-row");
        wrap.append(load, exp);
        li.append(wrap);
        crateList.append(li);
      }
    }

    note.textContent = s.note;
    note.hidden = !s.note;
    const parts: string[] = [];
    if (s.index.total) parts.push(`${s.index.total} tracks`);
    if (s.index.ready) parts.push(`${s.index.ready} ready`);
    if (s.index.failed) parts.push(`${s.index.failed} failed`);
    // navigator.storage.estimate() covers the whole origin (all IndexedDB,
    // localStorage), not just this library, so it is labelled as such rather
    // than presented as the library's own size.
    if (s.usageBytes != null) parts.push(`${(s.usageBytes / 1e6).toFixed(0)} MB origin storage`);
    if (s.persisted === false) parts.push("storage not persistent");
    storage.textContent = parts.join(" · ");
  }

  function renderIndex(): void {
    const s = libraryStore.get();
    const active = s.index.running || s.index.pending > 0;
    indexStatus.dataset.state = active ? "running" : "idle";
    if (active) {
      indexStatus.textContent = `Indexing · ${s.index.ready}/${s.index.total}${s.index.current ? ` · ${s.index.current}` : ""}`;
    } else {
      indexStatus.textContent = s.index.total ? "Index idle" : "No tracks";
    }
  }

  function renderAll(): void {
    filtered = filterTracks(libraryStore.get().tracks, libraryStore.get().query);
    for (const { sort, b } of headButtons) {
      const q = libraryStore.get().query;
      b.setAttribute("aria-pressed", String(q.sort === sort));
      b.textContent = q.sort === sort ? `${SORTS.find((s) => s.sort === sort)!.label} ${q.desc ? "▾" : "▴"}` : SORTS.find((s) => s.sort === sort)!.label;
    }
    renderRows();
    renderIndex();
    renderSide();
  }

  function schedule(): void {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => {
      renderQueued = false;
      renderAll();
    });
  }

  /* ---------- interactions ---------- */
  function loadToIdle(id: string): void {
    const slot = idleSlot(audio);
    if (slot == null) {
      libraryStore.set({ note: "Both decks are playing. Stop one to load a track." });
      return;
    }
    void controller.loadToDeck(slot, id);
  }

  scroll.addEventListener("scroll", () => {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => {
      renderQueued = false;
      renderRows();
    });
  });
  scroll.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      const cur = filtered.findIndex((r) => r.track.id === selectedId);
      const next = Math.min(filtered.length - 1, Math.max(0, (cur < 0 ? 0 : cur) + (e.key === "ArrowDown" ? 1 : -1)));
      if (filtered[next]) {
        selectedId = filtered[next].track.id;
        const top = next * ROW_H;
        if (top < scroll.scrollTop) scroll.scrollTop = top;
        else if (top + ROW_H > scroll.scrollTop + scroll.clientHeight) scroll.scrollTop = top + ROW_H - scroll.clientHeight;
        renderRows();
        e.preventDefault();
      }
    } else if (e.key === "Enter" && selectedId) {
      // Enter loads to the focused deck; Shift+Enter to the other one (plan 4.7).
      const focused = consoleStore.get().focusDeck;
      const target: Slot = e.shiftKey ? ((1 - focused) as Slot) : focused;
      void controller.loadToDeck(target, selectedId);
      e.preventDefault();
    }
  });

  // Listeners live on `document` because drops resolve against the deck views.
  // An AbortController lets the view tear them all down at once if it is ever
  // unmounted (the console mounts once today, but a leak here is invisible).
  const listeners = new AbortController();
  document.addEventListener("visibilitychange", () => controller.setHidden(document.hidden), { signal: listeners.signal });

  // Drag a library row onto a deck (plan 4.7). The deck views carry data-deck;
  // we resolve the drop target here so deck.ts needs no library-specific code.
  document.addEventListener(
    "dragover",
    (e) => {
      if (!e.dataTransfer?.types.includes(TRACK_MIME)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
    },
    { capture: true, signal: listeners.signal },
  );
  document.addEventListener(
    "drop",
    (e) => {
      const id = e.dataTransfer?.getData(TRACK_MIME);
      if (!id) return;
      e.preventDefault();
      e.stopPropagation();
      const target = document.elementFromPoint(e.clientX, e.clientY)?.closest("[data-deck]") as HTMLElement | null;
      const name = target?.dataset.deck;
      const slot: Slot = name === "b" ? 1 : 0;
      void controller.loadToDeck(slot, id);
    },
    { capture: true, signal: listeners.signal },
  );

  /* ---------- subscriptions ---------- */
  const resize = typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => schedule()) : null;
  resize?.observe(scroll);
  const unsubscribe = libraryStore.select((s) => s, () => schedule());
  schedule();

  (el as HTMLElement & { dispose?: () => void }).dispose = () => {
    listeners.abort();
    resize?.disconnect();
    unsubscribe();
  };

  return el;
}
