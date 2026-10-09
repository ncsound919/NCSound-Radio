/**
 * Settings panel (plan 3A.1): output devices and the headphone cue.
 * Opened from the top bar. Device names need media permission; a button asks
 * for it and otherwise shows generic labels.
 */
import { invitesPanel } from "./invites";
import type { ConsoleAudio } from "../../audio/engine";
import type { ObsService } from "../../services/obs";
import { consoleStore, persistDevice, persistObs, persistDjName } from "../../state/console";
import { listOutputs, masterOutputSupported, headphoneSupported, setMasterOutput } from "../../audio/outputs";
import { knob } from "../controls";
import { onFrame } from "../../app/scheduler";
import { r2Token, setR2Token } from "../../library/sources/r2";
import { learnTargets, midiRemap } from "../../midi/remap";

const pct = (v: number) => `${Math.round(v * 100)}%`;

export function settingsPanel(audio: ConsoleAudio, obs: ObsService, opts: { restricted?: boolean } = {}): HTMLElement {
  const el = document.createElement("section");
  el.className = "nc-settings";
  el.setAttribute("aria-label", "Settings");
  el.hidden = true;

  const head = document.createElement("div");
  head.className = "nc-settings-head";
  const title = document.createElement("span");
  title.textContent = "Settings";
  const close = document.createElement("button");
  close.type = "button";
  close.className = "nc-settings-close";
  close.textContent = "Close";
  close.addEventListener("click", () => (el.hidden = true));
  head.append(title, close);

  const mkField = (label: string) => {
    const field = document.createElement("div");
    field.className = "nc-settings-field";
    const l = document.createElement("label");
    l.textContent = label;
    field.append(l);
    return field;
  };

  const masterField = mkField("Master output");
  const masterSelect = document.createElement("select");
  masterSelect.setAttribute("aria-label", "Master output device");
  masterField.append(masterSelect);

  const hpField = mkField("Headphone (cue) output");
  const hpSelect = document.createElement("select");
  hpSelect.setAttribute("aria-label", "Headphone output device");
  const hpEnable = document.createElement("button");
  hpEnable.type = "button";
  hpEnable.className = "nc-settings-btn";
  hpEnable.textContent = "Enable";
  hpField.append(hpSelect, hpEnable);

  const mixField = mkField("Headphone mix (cue ↔ master)");
  const mix = knob({
    label: "Mix",
    min: 0,
    max: 1,
    value: 1,
    reset: 1,
    step: 0.01,
    format: (v) => (v >= 0.99 ? "Cue" : v <= 0.01 ? "Master" : pct(v)),
    onInput: (v) => {
      audio.headphone.setMix(v);
      consoleStore.set((s) => ({ outputs: { ...s.outputs, mix: v } }));
    },
  });
  mixField.append(mix.el);

  const levelField = mkField("Headphone level");
  const level = knob({
    label: "Level",
    min: 0,
    max: 1,
    value: 0.8,
    reset: 0.8,
    step: 0.01,
    format: pct,
    onInput: (v) => {
      audio.headphone.setLevel(v);
      consoleStore.set((s) => ({ outputs: { ...s.outputs, level: v } }));
    },
  });
  levelField.append(level.el);

  const namesBtn = document.createElement("button");
  namesBtn.type = "button";
  namesBtn.className = "nc-settings-btn";
  namesBtn.textContent = "Show device names";
  namesBtn.addEventListener("click", async () => {
    const devices = await listOutputs(true);
    consoleStore.set((s) => ({ outputs: { ...s.outputs, devices } }));
  });

  const note = document.createElement("p");
  note.className = "nc-settings-note";

  /* OBS (plan 6.1 / 6.5) */
  const obsField = mkField("OBS address (obs-websocket)");
  const obsAddr = document.createElement("input");
  obsAddr.type = "text";
  obsAddr.className = "nc-settings-input";
  obsAddr.placeholder = "127.0.0.1:4455";
  obsAddr.setAttribute("aria-label", "OBS address");
  const obsPw = document.createElement("input");
  obsPw.type = "password";
  obsPw.className = "nc-settings-input";
  obsPw.placeholder = "OBS password (if set)";
  obsPw.setAttribute("aria-label", "OBS password");
  const obsRow = document.createElement("div");
  obsRow.className = "nc-settings-row";
  const obsConnect = document.createElement("button");
  obsConnect.type = "button";
  obsConnect.className = "nc-settings-btn";
  obsConnect.textContent = "Connect";
  const obsDisconnect = document.createElement("button");
  obsDisconnect.type = "button";
  obsDisconnect.className = "nc-settings-btn";
  obsDisconnect.textContent = "Disconnect";
  obsRow.append(obsConnect, obsDisconnect);
  const obsNote = document.createElement("p");
  obsNote.className = "nc-settings-note";
  obsField.append(obsAddr, obsPw, obsRow, obsNote);

  /* Cloudflare Stream: send the RTMPS server + live-input key to OBS. OBS then
     streams there; the console's Start/Stop stream control goes live on it. */
  const STREAM_SERVER_KEY = "ncsound.console.stream.server";
  const STREAM_KEY_KEY = "ncsound.console.stream.key";
  const streamField = mkField("Cloudflare Stream (OBS \u2192 Stream)");
  const streamServer = document.createElement("input");
  streamServer.type = "text";
  streamServer.className = "nc-settings-input";
  streamServer.placeholder = "rtmps://live.cloudflare.com:443/live/";
  streamServer.setAttribute("aria-label", "Stream server (RTMPS)");
  const streamKey = document.createElement("input");
  streamKey.type = "password";
  streamKey.className = "nc-settings-input";
  streamKey.placeholder = "Stream key";
  streamKey.autocomplete = "off";
  streamKey.setAttribute("aria-label", "Stream key");
  try {
    streamServer.value = localStorage.getItem(STREAM_SERVER_KEY) ?? "rtmps://live.cloudflare.com:443/live/";
    streamKey.value = localStorage.getItem(STREAM_KEY_KEY) ?? "";
  } catch {
    streamServer.value = "rtmps://live.cloudflare.com:443/live/";
  }
  const streamRow = document.createElement("div");
  streamRow.className = "nc-settings-row";
  const sendStream = document.createElement("button");
  sendStream.type = "button";
  sendStream.className = "nc-settings-btn";
  sendStream.textContent = "Send to OBS";
  streamRow.append(sendStream);
  const streamNote = document.createElement("p");
  streamNote.className = "nc-settings-note";
  streamField.append(streamServer, streamKey, streamRow, streamNote);
  const persistStream = () => {
    try {
      localStorage.setItem(STREAM_SERVER_KEY, streamServer.value.trim());
      localStorage.setItem(STREAM_KEY_KEY, streamKey.value);
    } catch {
      /* not persisted */
    }
  };
  streamServer.addEventListener("change", persistStream);
  streamKey.addEventListener("change", persistStream);
  sendStream.addEventListener("click", async () => {
    const server = streamServer.value.trim();
    const key = streamKey.value;
    if (!server || !key) {
      streamNote.textContent = "Enter the RTMPS server and the Cloudflare Stream key first.";
      return;
    }
    if (!obs.connected) {
      streamNote.textContent = "Connect to OBS first.";
      return;
    }
    persistStream();
    const sent = await obs.setStreamService(server, key);
    streamNote.textContent = sent
      ? "Sent. Start streaming from the Visuals tab (Go live)."
      : "OBS rejected the stream settings — see the OBS status message above.";
  });

  /* DJ name for the OBS overlay */
  const djField = mkField("DJ name (OBS overlay)");
  const djName = document.createElement("input");
  djName.type = "text";
  djName.className = "nc-settings-input";
  djName.placeholder = "Your name";
  djName.setAttribute("aria-label", "DJ name");
  djField.append(djName);

  /* Cloudflare R2 library token (only needed once the Worker is locked) */
  const r2Field = mkField("R2 library token");
  const r2Input = document.createElement("input");
  r2Input.type = "password";
  r2Input.className = "nc-settings-input";
  r2Input.placeholder = "Only if ncsound-api is locked";
  r2Input.autocomplete = "off";
  r2Input.setAttribute("aria-label", "R2 library token");
  r2Input.value = r2Token();
  r2Input.addEventListener("change", () => setR2Token(r2Input.value));
  r2Field.append(r2Input);

  /* MIDI mapping: channel filter + learn (src/midi/remap.ts) */
  const midiField = mkField("MIDI controller mapping");
  const chanSel = document.createElement("select");
  chanSel.setAttribute("aria-label", "MIDI channel");
  const anyOpt = document.createElement("option");
  anyOpt.value = "";
  anyOpt.textContent = "Listen on any channel";
  chanSel.append(anyOpt);
  for (let c = 1; c <= 16; c++) {
    const o = document.createElement("option");
    o.value = String(c);
    o.textContent = `Channel ${c} only`;
    chanSel.append(o);
  }
  chanSel.value = midiRemap.state.channel ? String(midiRemap.state.channel) : "";
  chanSel.addEventListener("change", () => midiRemap.setChannel(chanSel.value ? Number(chanSel.value) : null));

  const targets = learnTargets();
  const targetSel = document.createElement("select");
  targetSel.setAttribute("aria-label", "Control to learn");
  const groups = new Map<string, HTMLOptGroupElement>();
  for (const t of targets) {
    let g = groups.get(t.group);
    if (!g) {
      g = document.createElement("optgroup");
      g.label = t.group;
      groups.set(t.group, g);
      targetSel.append(g);
    }
    const o = document.createElement("option");
    o.value = t.id;
    o.textContent = t.label;
    g.append(o);
  }
  const midiRow = document.createElement("div");
  midiRow.className = "nc-settings-row";
  const learnBtn = document.createElement("button");
  learnBtn.type = "button";
  learnBtn.className = "nc-settings-btn";
  learnBtn.textContent = "Learn";
  const resetBtn = document.createElement("button");
  resetBtn.type = "button";
  resetBtn.className = "nc-settings-btn";
  resetBtn.textContent = "Reset mapping";
  midiRow.append(learnBtn, resetBtn);
  const midiNote = document.createElement("p");
  midiNote.className = "nc-settings-note";
  midiField.append(chanSel, targetSel, midiRow, midiNote);
  learnBtn.addEventListener("click", () => {
    if (midiRemap.learningTarget) return midiRemap.cancelLearn();
    const t = targets.find((x) => x.id === targetSel.value);
    if (t) midiRemap.startLearn(t);
  });
  resetBtn.addEventListener("click", () => midiRemap.reset());
  const midiSync = () => {
    const l = midiRemap.learningTarget;
    learnBtn.textContent = l ? "Cancel" : "Learn";
    const n = midiRemap.learnedCount;
    midiNote.textContent = [midiRemap.message, n ? `${n} control${n === 1 ? "" : "s"} remapped.` : "Using the console's own note/CC numbers."].filter(Boolean).join(" ");
  };
  midiRemap.subscribe(midiSync);
  midiSync();

  // Rarely-touched sections fold away so the panel stays short on a laptop.
  const fold = (field: HTMLElement): HTMLElement => {
    const label = field.querySelector("label");
    const d = document.createElement("details");
    d.className = "nc-settings-fold";
    const sum = document.createElement("summary");
    sum.textContent = label?.textContent ?? "More";
    label?.remove();
    d.append(sum, field);
    return d;
  };

  // Host/guest settings: audio devices, levels, name, MIDI. Not OBS or cloud
  // library config, which belong to the station owner's machine.
  el.append(
    head, masterField, hpField, mixField, levelField, namesBtn, djField,
    ...(opts.restricted ? [] : [obsField, fold(streamField)]),
    fold(midiField),
    ...(opts.restricted ? [] : [fold(r2Field), invitesPanel()]),
    note,
  );

  const fill = (sel: HTMLSelectElement, selected: string | null, includeNone: boolean) => {
    const { devices } = consoleStore.get().outputs;
    sel.innerHTML = "";
    if (includeNone) {
      const o = document.createElement("option");
      o.value = "";
      o.textContent = "System default";
      sel.append(o);
    }
    for (const d of devices) {
      const o = document.createElement("option");
      o.value = d.id;
      o.textContent = d.label;
      sel.append(o);
    }
    if (selected != null && devices.some((d) => d.id === selected)) sel.value = selected;
  };

  masterSelect.addEventListener("change", async () => {
    const id = masterSelect.value;
    const r = await setMasterOutput(audio.mixer, id);
    persistDevice("master", id || null);
    consoleStore.set((s) => ({ outputs: { ...s.outputs, masterId: id || null, note: r.ok ? "" : r.message } }));
  });

  hpEnable.addEventListener("click", async () => {
    const id = hpSelect.value;
    if (!id) {
      consoleStore.set((s) => ({ outputs: { ...s.outputs, note: "Pick a headphone device first." } }));
      return;
    }
    const r = await audio.headphone.start(id);
    if (r.ok) {
      persistDevice("headphone", id);
      consoleStore.set((s) => ({
        outputs: { ...s.outputs, headphoneId: id, headphoneActive: true, latencyMs: audio.headphone.latencyMs(), note: "" },
      }));
    } else {
      consoleStore.set((s) => ({ outputs: { ...s.outputs, headphoneActive: false, note: r.message } }));
    }
  });

  obsAddr.value = consoleStore.get().obs.address;
  obsPw.value = consoleStore.get().obs.password;
  djName.value = consoleStore.get().djName;
  obsConnect.addEventListener("click", () => {
    const addr = obsAddr.value.trim();
    const pw = obsPw.value;
    persistObs(addr, pw);
    consoleStore.set((s) => ({ obs: { ...s.obs, address: addr, password: pw, configured: addr.length > 0 } }));
    void obs.connect(addr, pw);
  });
  obsDisconnect.addEventListener("click", () => obs.disconnect());
  djName.addEventListener("input", () => {
    consoleStore.set({ djName: djName.value });
    persistDjName(djName.value);
  });
  consoleStore.select((s) => s.obs.status, () => {
    const o = consoleStore.get().obs;
    obsNote.textContent = o.status === "connected" ? "Connected to OBS." : o.status === "off" ? "" : o.message;
  });
  consoleStore.select((s) => s.obs.message, (m) => {
    if (consoleStore.get().obs.status !== "connected") obsNote.textContent = m;
  });

  consoleStore.select(
    (s) => s.outputs.devices,
    () => {
      fill(masterSelect, consoleStore.get().outputs.masterId, true);
      fill(hpSelect, consoleStore.get().outputs.headphoneId, false);
    },
  );
  consoleStore.select(
    (s) => s.outputs.note,
    (n) => (note.textContent = n),
  );

  let lastLatency: number | null | undefined;
  onFrame(() => {
    const o = consoleStore.get().outputs;
    const lat = o.headphoneActive ? audio.headphone.latencyMs() : null;
    if (lat !== lastLatency) {
      lastLatency = lat;
      if (!o.note) {
        note.textContent = lat != null
          ? `Headphone path: ~${lat.toFixed(1)} ms (Web Audio). The <audio> element may add more.${lat > 40 ? " That is above 40 ms." : ""}`
          : "";
      }
    }
  });

  // Populate once, then keep in sync.
  fill(masterSelect, consoleStore.get().outputs.masterId, true);
  fill(hpSelect, consoleStore.get().outputs.headphoneId, false);
  consoleStore.set((s) => ({
    outputs: { ...s.outputs, masterSupported: masterOutputSupported(), headphoneSupported: headphoneSupported() },
  }));

  return el;
}
