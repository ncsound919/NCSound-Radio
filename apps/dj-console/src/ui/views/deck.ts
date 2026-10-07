/**
 * Deck view: track, BPM, pitch, key, time, transport, hot cues, loop, beat jump,
 * pitch fader. Reads the engine every frame and writes only what changed.
 *
 * Not shown, on purpose: key lock and key shift (the engine stores the flags
 * but nothing in the audio path applies them), stems (phase 7).
 */
import { evaluateHarmonicMatch } from "@ncsound/dj-engine/sync";
import { HOT_CUES, deckName, type ConsoleAudio, type Slot } from "../../audio/engine";
import { consoleStore, setDeckMsg } from "../../state/console";
import { onFrame } from "../../app/scheduler";
import { fader, key, pad, readout } from "../controls";

const MATCH_LABEL: Record<string, string> = {
  perfect: "Same key",
  harmonic: "Compatible",
  "energy-boost": "Energy lift",
  wide: "Clashes",
};

export function fmtTime(sec: number): string {
  const s = Math.max(0, sec);
  const m = Math.floor(s / 60);
  const r = s - m * 60;
  return `${m}:${r < 10 ? "0" : ""}${r.toFixed(1)}`;
}

export function fmtBars(bars: number): string {
  return bars >= 1 ? String(bars) : `1/${Math.round(1 / bars)}`;
}

function div(cls: string, text?: string): HTMLDivElement {
  const d = document.createElement("div");
  d.className = cls;
  if (text !== undefined) d.textContent = text;
  return d;
}

export function deckView(audio: ConsoleAudio, slot: Slot, loadFiles: (slot: Slot, files: FileList | File[]) => void): HTMLElement {
  const name = deckName(slot);
  const mixer = audio.mixer;
  const el = document.createElement("section");
  el.className = "nc-zone nc-deck";
  el.dataset.deck = name.toLowerCase();
  el.setAttribute("aria-label", `Deck ${name}`);
  el.addEventListener("pointerdown", () => consoleStore.set({ focusDeck: slot }));

  /* header */
  const head = div("nc-deck-head");
  const letter = div("nc-deck-letter", name);
  const meta = div("nc-deck-meta");
  const title = div("nc-deck-title", "No track loaded");
  const artist = div("nc-deck-artist", "");
  meta.append(title, artist);
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "audio/*,.mp3,.wav,.aiff,.aif,.flac,.ogg,.m4a";
  input.hidden = true;
  input.addEventListener("change", () => {
    if (input.files?.length) loadFiles(slot, input.files);
    input.value = "";
  });
  const load = key({ label: "Load", onPress: () => input.click() });
  load.el.setAttribute("aria-label", `Load a track to deck ${name}`);
  head.append(letter, meta, load.el, input);

  /* readouts */
  const ro = div("nc-deck-readouts");
  const bpm = readout("BPM");
  const pitchR = readout("Pitch");
  const keyR = readout("Key", null, "accent");
  const time = readout("Remain");
  const match = div("nc-deck-match", "");
  keyR.el.append(match);
  ro.append(bpm.el, pitchR.el, keyR.el, time.el);

  /* hot cues */
  const cues = div("nc-deck-cues");
  const cuePads = HOT_CUES.map((c, i) => {
    const p = pad({ index: i + 1 + slot * 4, name: c.label });
    p.el.title = `Jump to ${c.label} (key ${i + 1 + slot * 4}). Shift-click to set it at the playhead.`;
    p.el.addEventListener("click", (e) => audio.hotCue(slot, c.key, e.shiftKey));
    cues.append(p.el);
    return p;
  });

  /* loop + beat jump */
  const loopRow = div("nc-deck-row");
  const loopK = key({ label: "Loop 4", onPress: () => audio.loop(slot, "toggle") });
  loopK.el.classList.add("nc-key-wide");
  loopK.el.setAttribute("aria-pressed", "false");
  const halve = key({ label: "/2", onPress: () => audio.loop(slot, "halve") });
  halve.el.setAttribute("aria-label", "Halve loop");
  const dbl = key({ label: "x2", onPress: () => audio.loop(slot, "double") });
  dbl.el.setAttribute("aria-label", "Double loop");
  const back = key({ label: "-4", onPress: () => mixer.beatJump(slot, -4) });
  back.el.setAttribute("aria-label", "Jump back 4 beats");
  const fwd = key({ label: "+4", onPress: () => mixer.beatJump(slot, 4) });
  fwd.el.setAttribute("aria-label", "Jump forward 4 beats");
  loopRow.append(loopK.el, halve.el, dbl.el, back.el, fwd.el);

  /* transport */
  const transport = div("nc-deck-row nc-deck-transport");
  const cueK = key({ label: "CUE", onPress: () => audio.cue(slot) });
  cueK.el.title = `Cue (${slot === 0 ? "Q" : "W"}): while playing, return to the cue point; while stopped, set it.`;
  const playK = key({ label: "PLAY", onPress: () => void audio.togglePlay(slot) });
  playK.el.setAttribute("aria-pressed", "false");
  playK.el.title = `Play / pause (${slot === 0 ? "Z" : "X"}, or Space for the focused deck)`;
  const syncK = key({ label: "SYNC", onPress: () => audio.sync(slot) });
  syncK.el.title = "Match this deck's tempo and beat phase to the other deck";
  for (const k of [cueK, playK, syncK]) k.el.classList.add("nc-key-transport");
  transport.append(cueK.el, playK.el, syncK.el);

  /* pitch fader: value is a fraction of the global range, so the range can change under it */
  const pitch = fader({
    label: "Pitch",
    min: -1,
    max: 1,
    value: 0,
    reset: 0,
    step: 0.0005,
    // DJ convention: up is slower, down is faster, so the fader value is the negated pitch.
    format: (v) => `${(-v * mixer.pitchFaderRange).toFixed(2)}%`,
    onInput: (v) => mixer.setDeckPitchPct(slot, -v * mixer.pitchFaderRange),
  });

  const body = div("nc-deck-body");
  const main = div("nc-deck-main");
  main.append(cues, loopRow, transport);
  body.append(main, pitch.el);

  const msg = div("nc-deck-msg", "");
  msg.setAttribute("role", "status");
  el.append(head, ro, body, msg);

  /* drag and drop */
  el.addEventListener("dragover", (e) => {
    if (!e.dataTransfer?.types.includes("Files")) return;
    e.preventDefault();
    el.dataset.drop = "true";
  });
  el.addEventListener("dragleave", (e) => {
    if (!el.contains(e.relatedTarget as Node)) el.dataset.drop = "false";
  });
  el.addEventListener("drop", (e) => {
    e.preventDefault();
    el.dataset.drop = "false";
    if (e.dataTransfer?.files.length) loadFiles(slot, e.dataTransfer.files);
  });

  /* store-driven parts */
  consoleStore.select((s) => s.deckMsg[slot], (m) => {
    msg.textContent = m || (audio.tracks[slot] ? "" : "Drop an audio file here or press Load.");
  });
  consoleStore.select((s) => s.focusDeck, (f) => (el.dataset.focus = String(f === slot)));
  consoleStore.select((s) => s.loadSeq[slot], () => {
    const t = audio.tracks[slot];
    title.textContent = t ? t.title : "No track loaded";
    artist.textContent = t ? t.artist : "";
    el.dataset.loaded = String(!!t);
    if (t) setDeckMsg(slot, "");
  });

  /* per-frame engine readback */
  let lastLoop = "";
  onFrame(() => {
    const d = audio.deck(slot);
    const a = d.analysis;
    const loaded = !!(a && d.buffer);
    bpm.set(a ? (a.bpm * d.rate).toFixed(1) : null);
    pitchR.set(a ? `${d.pitchPct >= 0 ? "+" : ""}${d.pitchPct.toFixed(2)}%` : null);
    const k = a ? d.getEffectiveKey() || null : null;
    keyR.set(k);
    const otherKey = audio.deck((1 - slot) as Slot).getEffectiveKey() || undefined;
    const m = k && otherKey ? MATCH_LABEL[evaluateHarmonicMatch(k, otherKey).tier] ?? "" : "";
    if (match.textContent !== m) match.textContent = m;
    time.set(loaded ? `-${fmtTime((d.buffer!.duration - d.currentOffset()) / d.rate)}` : null);

    playK.setOn(d.playing);
    for (const kk of [cueK, playK, loopK, halve, dbl, back, fwd]) kk.setDisabled(!loaded);
    syncK.setDisabled(!audio.canSync(slot));
    const loopLabel = `Loop ${fmtBars(d.loopBars > 0 ? d.loopBars : d.lastLoopBars)}`;
    if (loopLabel !== lastLoop) {
      lastLoop = loopLabel;
      loopK.el.textContent = loopLabel;
    }
    loopK.setOn(d.loopBars > 0);
    HOT_CUES.forEach((c, i) => {
      const has = a?.cuePoints?.[c.key] != null;
      if (cuePads[i].el.dataset.empty !== String(!has)) cuePads[i].setName(has ? c.label : null);
      cuePads[i].el.disabled = !a; // an empty cue can still be set with shift-click
    });
    pitch.set(-d.pitchPct / mixer.pitchFaderRange);
  });

  return el;
}
