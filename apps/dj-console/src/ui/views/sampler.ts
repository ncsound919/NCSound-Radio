/**
 * Sampler tab (plan 3C.5): 4 banks x 16 pads mirroring the MPD226, drag a file
 * onto a pad or use the picker, Shift-click a pad to edit it. Everything is read
 * back from the engine; pads persist in IndexedDB.
 */
import type { ConsoleAudio } from "../../audio/engine";
import type { PadConfig, PadMode, PadQuantize } from "@ncsound/dj-engine/sampler";
import { onFrame } from "../../app/scheduler";
import { key, knob, pad as padControl } from "../controls";
import { deletePad, padId, savePad, loadPads, usage, requestPersist, type StoredPad } from "../../audio/samplerStore";
import { consoleStore } from "../../state/console";

const BANKS = ["A", "B", "C", "D"];
const MODES: PadMode[] = ["oneshot", "gate", "loop"];
const MODE_LABEL: Record<PadMode, string> = { oneshot: "One-shot", gate: "Gate", loop: "Loop" };
const QUANTIZE: PadQuantize[] = [0, 0.25, 1, 4];
const Q_LABEL: Record<number, string> = { 0: "Off", 0.25: "1/16", 1: "1 beat", 4: "1 bar" };
const SWATCHES = 6;

const mb = (bytes: number) => `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

function div(cls: string, text?: string): HTMLDivElement {
  const d = document.createElement("div");
  d.className = cls;
  if (text !== undefined) d.textContent = text;
  return d;
}

export function samplerView(audio: ConsoleAudio): HTMLElement {
  const sampler = audio.sampler;
  const el = div("nc-sampler");
  let bank = 0;
  let selected = -1;

  /* bank selector + volume */
  const top = div("nc-sampler-top");
  const bankKeys = BANKS.map((label, i) => {
    const k = key({ label: `${label}`, toggle: true, onToggle: () => selectBank(i) });
    k.el.setAttribute("aria-label", `Sampler bank ${label}`);
    return k;
  });
  const volume = knob({
    label: "Sampler Vol", min: 0, max: 1, value: 0.9, reset: 0.9, step: 0.01,
    format: (v) => `${Math.round(v * 100)}%`,
    onInput: (v) => sampler.setVolume(v),
  });
  top.append(...bankKeys.map((k) => k.el), volume.el);
  el.append(top);

  /* grid */
  const grid = div("nc-sampler-grid");
  const pads: ReturnType<typeof padControl>[] = [];
  for (let i = 0; i < 16; i++) {
    const p = padControl({ index: i + 1 });
    p.el.dataset.gridCell = "";
    p.el.addEventListener("pointerdown", (e) => {
      if (e.shiftKey) return;
      sampler.trigger(bank, i, { velocity: 1 });
    });
    p.el.addEventListener("click", (e) => {
      if (e.shiftKey) { selected = i; renderEditor(); }
    });
    // Drag-drop a file onto a pad.
    p.el.addEventListener("dragover", (e) => { if (e.dataTransfer?.types.includes("Files")) e.preventDefault(); });
    p.el.addEventListener("drop", (e) => {
      e.preventDefault();
      const f = e.dataTransfer?.files?.[0];
      if (f) void loadFile(bank, i, f);
    });
    pads.push(p);
    grid.append(p.el);
  }
  el.append(grid);

  /* editor */
  const editor = div("nc-sampler-editor");
  const editorTitle = div("nc-sampler-editor-title", "Shift-click a pad to edit");
  const nameInput = document.createElement("input");
  nameInput.type = "text";
  nameInput.className = "nc-sampler-name";
  nameInput.placeholder = "Pad name";
  nameInput.setAttribute("aria-label", "Pad name");
  const gain = knob({ label: "Gain", min: 0, max: 1, value: 1, reset: 1, step: 0.01, format: (v) => `${Math.round(v * 100)}%`, onInput: (v) => patch({ gain: v }) });
  const modeRow = div("nc-sampler-row");
  const modeKeys = MODES.map((m) => {
    const k = key({ label: MODE_LABEL[m], toggle: true, onToggle: () => patch({ mode: m }) });
    return { m, k };
  });
  modeRow.append(...modeKeys.map((x) => x.k.el));
  const chokeRow = div("nc-sampler-row");
  const chokeKeys = [0, 1, 2, 3, 4].map((g) => {
    const k = key({ label: g === 0 ? "Choke off" : `Group ${g}`, toggle: true, onToggle: () => patch({ choke: g }) });
    return { g, k };
  });
  chokeRow.append(...chokeKeys.map((x) => x.k.el));
  const qRow = div("nc-sampler-row");
  const qKeys = QUANTIZE.map((q) => {
    const k = key({ label: Q_LABEL[q], toggle: true, onToggle: () => patch({ quantize: q }) });
    return { q, k };
  });
  qRow.append(...qKeys.map((x) => x.k.el));
  const colorRow = div("nc-sampler-row nc-sampler-colors");
  const colorKeys = Array.from({ length: SWATCHES }, (_, c) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "nc-swatch";
    b.dataset.color = String(c);
    b.dataset.gridCell = "";
    b.setAttribute("aria-label", `Colour ${c + 1}`);
    b.addEventListener("click", () => patch({ color: c }));
    return b;
  });
  colorRow.append(...colorKeys);
  const fileInput = document.createElement("input");
  fileInput.type = "file";
  fileInput.accept = "audio/*,.wav,.mp3,.aiff,.aif,.flac,.ogg";
  fileInput.hidden = true;
  const actions = div("nc-sampler-row");
  const loadBtn = key({ label: "Load file", onPress: () => { if (selected >= 0) fileInput.click(); } });
  const clearBtn = key({ label: "Clear", onPress: () => void clearPad(bank, selected) });
  actions.append(loadBtn.el, clearBtn.el, fileInput);
  fileInput.addEventListener("change", () => {
    const f = fileInput.files?.[0];
    if (f && selected >= 0) void loadFile(bank, selected, f);
    fileInput.value = "";
  });
  editor.append(editorTitle, nameInput, gain.el, modeRow, chokeRow, qRow, colorRow, actions);
  editor.hidden = true;
  el.append(editor);

  const usageLine = div("nc-sampler-usage", "");
  el.append(usageLine);

  /* behaviour */
  function selectBank(i: number) {
    bank = i;
    for (let b = 0; b < bankKeys.length; b++) bankKeys[b].setOn(b === i);
    selected = -1;
    renderEditor();
  }

  function patch(p: Partial<PadConfig>): void {
    if (selected < 0) return;
    sampler.setPad(bank, selected, p);
    // Persist config only if this pad has stored bytes.
    void persistConfig();
    renderPads();
    renderEditor();
  }

  async function persistConfig(): Promise<void> {
    const buf = sampler.getBuffer(bank, selected);
    if (!buf) return; // default/physical sample: nothing stored to update
    const rec = stored.get(padId(bank, selected));
    if (!rec) return;
    rec.config = sampler.getPad(bank, selected);
    rec.name = sampler.getPad(bank, selected).name;
    await savePad(rec);
  }

  async function loadFile(b: number, p: number, file: File): Promise<void> {
    const bytes = await file.arrayBuffer();
    let decoded: AudioBuffer;
    try {
      decoded = await audio.mixer.ctx.decodeAudioData(bytes.slice(0));
    } catch {
      consoleStore.set({ status: `Couldn't decode ${file.name}.` });
      return;
    }
    const name = file.name.replace(/\.[a-z0-9]{2,5}$/i, "");
    sampler.setBuffer(b, p, decoded, name);
    const config = sampler.getPad(b, p);
    const rec: StoredPad = { id: padId(b, p), bank: b, pad: p, name, type: file.type, bytes, config };
    stored.set(rec.id, rec);
    await savePad(rec);
    if (b === bank) { renderPads(); renderEditor(); }
    void refreshUsage();
  }

  async function clearPad(b: number, p: number): Promise<void> {
    if (p < 0) return;
    sampler.setBuffer(b, p, null, "");
    sampler.setPad(b, p, { name: "" });
    stored.delete(padId(b, p));
    await deletePad(b, p);
    if (b === bank) { renderPads(); renderEditor(); }
    void refreshUsage();
  }

  function renderPads(): void {
    for (let i = 0; i < 16; i++) {
      const cfg = sampler.getPad(bank, i);
      const has = sampler.hasBuffer(bank, i);
      pads[i].setName(has && cfg.name ? cfg.name : null);
      pads[i].el.dataset.color = String(cfg.color);
      pads[i].el.dataset.filled = String(has);
      pads[i].el.dataset.selected = String(i === selected);
      pads[i].el.title = has ? `${cfg.name || "Sample"} — ${MODE_LABEL[cfg.mode]}, ${Q_LABEL[cfg.quantize]}. Shift-click to edit.` : "Empty. Drop a file or Shift-click to edit.";
    }
  }

  function renderEditor(): void {
    if (selected < 0) { editor.hidden = true; return; }
    editor.hidden = false;
    const cfg = sampler.getPad(bank, selected);
    editorTitle.textContent = `Bank ${BANKS[bank]} · Pad ${selected + 1}${sampler.hasBuffer(bank, selected) ? "" : " (empty)"}`;
    if (nameInput.value !== cfg.name) nameInput.value = cfg.name;
    gain.set(cfg.gain);
    for (const { m, k } of modeKeys) k.setOn(m === cfg.mode);
    for (const { g, k } of chokeKeys) k.setOn(g === cfg.choke);
    for (const { q, k } of qKeys) k.setOn(q === cfg.quantize);
    colorKeys.forEach((b, c) => (b.dataset.on = String(c === cfg.color)));
  }

  nameInput.addEventListener("input", () => {
    if (selected < 0) return;
    sampler.setPad(bank, selected, { name: nameInput.value });
    void persistConfig();
    renderPads();
  });

  async function refreshUsage(): Promise<void> {
    const u = await usage();
    usageLine.textContent = u ? `Sampler storage: ${mb(u.usage)} of ${mb(u.quota)} available to this browser.` : "";
  }

  /* boot: load stored pads, then default bank for anything still empty */
  const stored = new Map<string, StoredPad>();
  void (async () => {
    try {
      await requestPersist();
    } catch { /* not granted: samples may be evicted, which we say below */ }
    try {
      const recs = await loadPads();
      for (const rec of recs) {
        stored.set(rec.id, rec);
        try {
          const buf = await audio.mixer.ctx.decodeAudioData(rec.bytes.slice(0));
          audio.sampler.setBuffer(rec.bank, rec.pad, buf, rec.name);
          audio.sampler.setPad(rec.bank, rec.pad, rec.config);
        } catch { /* skip a pad that no longer decodes */ }
      }
    } catch { /* IndexedDB unavailable: run without persistence */ }
    void refreshUsage();
    renderPads();
  })();

  // Fill the default bank only where nothing was stored.
  import("../../audio/clubSounds").then(({ loadDefaultBank }) => {
    loadDefaultBank(audio.mixer.ctx, {
      setBuffer: (b, p, buf, name) => { if (!sampler.hasBuffer(b, p)) sampler.setBuffer(b, p, buf, name); },
    });
    renderPads();
  });

  selectBank(0);
  renderPads();

  // Live pad activity flash for on-screen feedback of MIDI/external triggers.
  onFrame(() => {
    // Nothing per-frame here yet; the grid is event-driven. Kept as the single
    // place per-frame sampler UI updates would go if added.
  });

  return el;
}
