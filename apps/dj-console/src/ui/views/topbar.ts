/**
 * Top bar: mode switch, master tempo, recording, MIDI, clock.
 * Radio mode adds the on-air chip (plan 5.8): AUTOPILOT / LIVE + elapsed /
 * connection state, plus listeners. LIVE comes only from LiveClient, which
 * takes it only from ingest's report of Liquidsoap.
 */
import type { ConsoleAudio } from "../../audio/engine";
import { consoleStore, type ConsoleMode, type MidiStatus } from "../../state/console";
import { onFrame } from "../../app/scheduler";
import { key } from "../controls";
import { fmtTime } from "./deck";
import type { LiveClient } from "../../radio/live";
import { PHASE_LABEL, fmtElapsed } from "./broadcast";

function span(cls: string, text = ""): HTMLSpanElement {
  const s = document.createElement("span");
  s.className = cls;
  s.textContent = text;
  return s;
}

function midiText(m: MidiStatus): string {
  switch (m.kind) {
    case "unsupported": return "MIDI unsupported";
    case "off": return "Connect MIDI";
    case "denied": return "MIDI blocked";
    case "no-device": return "No MIDI device";
    case "connected": return m.names[0].replace(/\s*MIDI\s*\d*$/i, "") + (m.names.length > 1 ? ` +${m.names.length - 1}` : "");
  }
}

export function topbarView(
  audio: ConsoleAudio,
  onMidiConnect: () => void,
  onSettings: () => void,
  live?: LiveClient,
  opts: { restricted?: boolean; label?: string } = {},
): HTMLElement {
  const mixer = audio.mixer;
  const el = document.createElement("header");
  el.className = "nc-topbar";

  const brand = span("nc-brand", "NCSOUND");
  const seg = document.createElement("div");
  seg.className = "nc-seg";
  seg.setAttribute("role", "radiogroup");
  seg.setAttribute("aria-label", "Console mode");
  const modes: Array<[ConsoleMode, string]> = [["party", "Party"], ["radio", "Radio"]];
  const segBtns = modes.map(([mode, label]) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "nc-seg-btn";
    b.setAttribute("role", "radio");
    b.textContent = label;
    b.title = "Switch mode (M)";
    b.addEventListener("click", () => consoleStore.set({ mode }));
    seg.append(b);
    return { mode, b };
  });

  const tempo = document.createElement("div");
  tempo.className = "nc-top-tempo";
  const tempoVal = span("nc-top-num", "--");
  tempo.append(span("nc-ctl-label", "Master"), tempoVal, span("nc-top-unit", "BPM"));

  const status = span("nc-top-status");
  status.setAttribute("role", "status");

  const recTime = span("nc-top-num nc-top-rec", "");
  const rec = key({
    label: "REC",
    tone: "live",
    onPress: async () => {
      const r = await audio.toggleRecording();
      if (r.message) consoleStore.set({ status: r.message });
    },
  });
  rec.el.setAttribute("aria-pressed", "false");
  rec.el.title = "Record the master output to a file";

  const midiBtn = document.createElement("button");
  midiBtn.type = "button";
  midiBtn.className = "nc-chip";
  midiBtn.addEventListener("click", onMidiConnect);

  const settingsBtn = document.createElement("button");
  settingsBtn.type = "button";
  settingsBtn.className = "nc-chip";
  settingsBtn.textContent = "Settings";
  settingsBtn.title = "Output devices, headphone cue, OBS, MIDI";
  settingsBtn.addEventListener("click", onSettings);

  // OBS chip, shown only when an address is configured (plan 6.1).
  const obsBtn = document.createElement("button");
  obsBtn.type = "button";
  obsBtn.className = "nc-chip";
  obsBtn.hidden = true;
  obsBtn.addEventListener("click", onSettings);

  // On-air chip (plan 5.8). Shown in Radio mode, and in Party mode whenever a
  // live session is active so switching modes can't hide that you're live.
  const onAir = span("nc-onair");
  onAir.setAttribute("role", "status");
  onAir.hidden = true;

  const clock = span("nc-top-num nc-top-clock", "");

  // A host/guest has no mode switch (always Radio) and no OBS chip; their name
  // shows instead so they can see which invite they are on.
  const who = opts.restricted ? span("nc-chip", opts.label ?? "guest") : null;
  if (who) who.title = "Signed in with an invite link";
  el.append(brand, ...(opts.restricted ? [who!] : [seg]), onAir, tempo, status, recTime, rec.el, ...(opts.restricted ? [] : [obsBtn]), midiBtn, settingsBtn, clock);

  consoleStore.select((s) => s.mode, (mode) => {
    for (const { mode: m, b } of segBtns) b.setAttribute("aria-checked", String(m === mode));
    document.body.dataset.mode = mode;
  });
  consoleStore.select((s) => s.status, (t) => (status.textContent = t));
  consoleStore.select((s) => s.midi, (m) => {
    midiBtn.textContent = midiText(m);
    midiBtn.dataset.state = m.kind;
    midiBtn.title = m.kind === "connected"
      ? `${m.names.join(", ")}${m.last ? ` · last: ${m.last}` : " · nothing received yet"}`
      : m.kind === "off" ? "Allow this page to use your MIDI controller" : midiText(m);
    midiBtn.disabled = m.kind === "unsupported";
  });

  consoleStore.select((s) => (s.obs.configured ? `${s.obs.status}:${s.obs.currentScene ?? ""}` : ""), () => {
    const o = consoleStore.get().obs;
    obsBtn.hidden = !o.configured;
    obsBtn.textContent = o.status === "connected" ? `OBS ${o.currentScene ?? "on"}` : o.status === "connecting" ? "OBS…" : o.status === "error" ? "OBS ✕" : "OBS off";
    obsBtn.dataset.state = o.status;
    obsBtn.title = `OBS ${o.address} — ${o.status}${o.message ? `: ${o.message}` : ""}`;
  });

  let lastClock = "";
  onFrame(() => {
    // Master tempo = the tempo deck's BPM (the engine's active deck), while something plays.
    const md = audio.deck(mixer.active as 0 | 1);
    const anyPlaying = audio.deck(0).playing || audio.deck(1).playing;
    const bpmText = anyPlaying && md.analysis ? (md.analysis.bpm * md.rate).toFixed(1) : "--";
    if (tempoVal.textContent !== bpmText) tempoVal.textContent = bpmText;
    const t = mixer.getMasterTelemetry();
    rec.setOn(t.recordingActive);
    const rt = t.recordingActive ? fmtTime(t.recordingElapsedSec).replace(/\.\d$/, "") : "";
    if (recTime.textContent !== rt) recTime.textContent = rt;
    if (live) {
      const ls = live.state;
      const st = consoleStore.get().station;
      const mode = consoleStore.get().mode;
      const active = ls.phase !== "idle" && ls.phase !== "ended" && ls.phase !== "failed";
      onAir.hidden = !(mode === "radio" || active);
      let text: string = PHASE_LABEL[ls.phase];
      if (ls.phase === "idle" || ls.phase === "ended" || ls.phase === "failed") text = st?.connected ? (st.broadcast.onAir ? "AUTOPILOT" : "OFF AIR") : "STATION ?";
      else if (ls.phase === "on_air") text = `LIVE ${ls.onAirSince !== null ? fmtElapsed(Date.now() - ls.onAirSince) : ""}`.trim();
      else if (ls.phase === "countdown" && ls.countdown !== null) text = `LIVE IN ${ls.countdown}`;
      else if (ls.phase === "lost") text = "LOST · AUTOPILOT";
      const listeners = st?.connected && st.listeners !== null ? ` · ${st.listeners} listening` : "";
      const full = text + listeners;
      if (onAir.textContent !== full) onAir.textContent = full;
      if (onAir.dataset.phase !== ls.phase) onAir.dataset.phase = ls.phase;
      const isLive = ls.phase === "on_air" ? "on" : "";
      if ((document.body.dataset.live ?? "") !== isLive) document.body.dataset.live = isLive;
    }
    const now = new Date();
    const c = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
    if (c !== lastClock) clock.textContent = lastClock = c;
  });
  return el;
}
