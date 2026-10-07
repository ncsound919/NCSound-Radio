/**
 * Broadcast tab (plan 5.3, 5.5, 5.6 in part): go live, hand back, mic, and
 * the station's own status.
 *
 * Every state here is read back: the live phase from LiveClient (whose
 * "on air" comes only from ingest's report of Liquidsoap), the station panel
 * from ingest `/status`. Nothing turns red because a button was pressed.
 *
 * Autopilot controls (plan 5.6): Skip (`mix.skip`, a 1-bar cut to the next
 * track), Hold/Resume (`autopilot.set`: Hold stops sequencing, the current
 * track plays on), and one pad per imaging file from ingest `/imaging`
 * (`imaging.play`). Each shows the engine's answer, never an assumed success.
 */
import type { ConsoleAudio } from "../../audio/engine";
import type { LiveClient, LiveClientState, LivePhase } from "../../radio/live";
import type { ObsService } from "../../services/obs";
import { consoleStore } from "../../state/console";
import { key, readout } from "../controls";
import { fetchImaging, stationCommand } from "../../radio/station";
import { can } from "../../app/session";
import { broadcastLink } from "../../engine/broadcastLink";

function div(cls: string, text?: string): HTMLDivElement {
  const d = document.createElement("div");
  d.className = cls;
  if (text !== undefined) d.textContent = text;
  return d;
}

export const PHASE_LABEL: Record<LivePhase, string> = {
  idle: "Autopilot",
  preflight: "Checking",
  countdown: "Countdown",
  connecting: "Connecting",
  armed: "Sending, not yet on air",
  on_air: "LIVE",
  ending: "Handing back",
  lost: "Connection lost",
  ended: "Handed back",
  failed: "Can't go live",
};

export function fmtElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

const MIC_DEVICE_KEY = "ncsound.console.micIn";

export function broadcastView(audio: ConsoleAudio, live: LiveClient, obs: ObsService): HTMLElement {
  const el = div("nc-bcast");

  /* ---------------- go live ---------------- */
  const goCol = div("nc-bcast-col");
  goCol.append(div("nc-bcast-title", "Go live"));

  const banner = div("nc-bcast-banner");
  const bannerPhase = div("nc-bcast-phase");
  const bannerMsg = div("nc-bcast-msg");
  banner.append(bannerPhase, bannerMsg);
  banner.setAttribute("role", "status");
  banner.setAttribute("aria-live", "polite");

  const rate = document.createElement("select");
  rate.className = "nc-select";
  rate.setAttribute("aria-label", "Live stream bitrate");
  for (const k of [192, 128]) {
    const o = document.createElement("option");
    o.value = String(k);
    o.textContent = `${k} kbps${k === 128 ? " (weak venue uplink)" : ""}`;
    rate.append(o);
  }
  rate.value = String(live.state.bitrateKbps);
  rate.addEventListener("change", () => live.setBitrate(Number(rate.value) as 128 | 192));

  const goKey = key({ label: "Go live", tone: "live", onPress: () => void live.goLive() });
  const cancelKey = key({ label: "Cancel", onPress: () => live.cancel() });
  const endKey = key({ label: "Hand back", onPress: () => void live.end() });
  const rejoinKey = key({ label: "Rejoin", tone: "live", onPress: () => void live.rejoin() });
  goKey.el.title = "Arm, count down 8 s, then take the station live";
  endKey.el.title = "End the live session; autopilot resumes";
  const actions = div("nc-bcast-row");
  actions.append(rate, goKey.el, cancelKey.el, endKey.el, rejoinKey.el);

  const checks = document.createElement("ul");
  checks.className = "nc-bcast-checks";

  const health = div("nc-bcast-row");
  const rElapsed = readout("On air", null, "live");
  const rSend = readout("Send kbps", null);
  const rQueued = readout("Queued s", null);
  const rIngest = readout("Ingest kbps", null);
  const rDrift = readout("Behind s", null);
  rDrift.el.title = "How far ingest's encoder is behind real time, from ffmpeg's own audio clock. Steady is fine; rising means the uplink can't keep up.";
  health.append(rElapsed.el, rSend.el, rQueued.el, rIngest.el, rDrift.el);

  /* mic */
  const micRow = div("nc-bcast-row");
  const micSel = document.createElement("select");
  micSel.className = "nc-select";
  micSel.setAttribute("aria-label", "Microphone input");
  const micKey = key({
    label: "Mic",
    tone: "live",
    onPress: async () => {
      const deviceId = micSel.value || null;
      const r = await audio.mixer.toggleMicTalkover({ deviceId, processing: false });
      micKey.setOn(r.active);
      consoleStore.set({ status: r.ok ? (r.active ? "Mic on air: music ducked 10 dB." : "Mic off.") : r.message });
      if (r.active) void fillMics(); // labels appear once permission is granted
    },
  });
  micKey.el.setAttribute("aria-pressed", "false");
  micKey.el.title = "Talk over the music: 110 Hz high-pass, music ducked about 10 dB";
  const micNote = div("nc-bcast-note", "Voice processing is off for broadcast sound. Use headphones: a laptop mic near speakers will feed back.");
  micRow.append(micSel, micKey.el);

  async function fillMics(): Promise<void> {
    let saved: string | null = null;
    try {
      saved = localStorage.getItem(MIC_DEVICE_KEY);
    } catch {
      /* storage blocked */
    }
    const devices = navigator.mediaDevices?.enumerateDevices ? await navigator.mediaDevices.enumerateDevices().catch(() => []) : [];
    const inputs = devices.filter((d) => d.kind === "audioinput");
    micSel.innerHTML = "";
    const def = document.createElement("option");
    def.value = "";
    def.textContent = "Default microphone";
    micSel.append(def);
    inputs.forEach((d, i) => {
      if (!d.deviceId || d.deviceId === "default") return;
      const o = document.createElement("option");
      o.value = d.deviceId;
      o.textContent = d.label || `Microphone ${i + 1}`;
      micSel.append(o);
    });
    if (saved && Array.from(micSel.options).some((o) => o.value === saved)) micSel.value = saved;
  }
  micSel.addEventListener("change", () => {
    try {
      localStorage.setItem(MIC_DEVICE_KEY, micSel.value);
    } catch {
      /* storage blocked */
    }
  });
  void fillMics();

  /* ---------------- OBS video stream ---------------- */
  // The console starts and stops the stream OBS is configured to send
  // (Settings -> Stream in OBS). The label and lit state are read back from
  // OBS, never set by the click, so a failed start never looks live.
  const obsTitle = div("nc-bcast-title", "OBS video stream");
  const obsRow = div("nc-bcast-row");
  const obsStatus = readout("OBS", null);
  const obsStreamKey = key({ label: "Start streaming", tone: "live", onPress: () => void (obs.streaming ? obs.stopStream() : obs.startStream()) });
  obsStreamKey.el.title = "Start or stop the stream OBS is configured to send";
  const obsNote = div("nc-bcast-note");
  obsRow.append(obsStatus.el, obsStreamKey.el);
  const paintObs = () => {
    const o = consoleStore.get().obs;
    obsStatus.set(o.status === "connected" ? (o.streaming ? "streaming" : "ready") : o.status);
    obsStreamKey.el.textContent = o.streaming ? "Stop streaming" : "Start streaming";
    obsStreamKey.setOn(o.streaming);
    obsStreamKey.setDisabled(o.status !== "connected");
    obsNote.textContent = o.status === "connected"
      ? (o.message || (o.streaming ? "OBS is streaming." : "OBS ready. The stream starts in OBS's configured output."))
      : o.configured ? (o.message || "OBS not connected.") : "No OBS address set. Add it in Settings to stream video.";
  };
  consoleStore.select((s) => s.obs.status, paintObs);
  consoleStore.select((s) => s.obs.streaming, paintObs);
  consoleStore.select((s) => s.obs.message, paintObs);
  paintObs();

  goCol.append(banner, actions, health, checks, div("nc-bcast-title", "Microphone"), micRow, micNote, obsTitle, obsRow, obsNote);

  /* ---------------- station ---------------- */
  const stCol = div("nc-bcast-col");
  stCol.append(div("nc-bcast-title", "Station"));
  const stRow = div("nc-bcast-row");
  // Ingest's single on-air answer for the AUTOPILOT path (engine, switch,
  // mount). It is not the live feed: while this console is live it can read
  // "Off air" and that is correct.
  const rAir = readout("Autopilot", null);
  const rListeners = readout("Listeners", null);
  const rPeak = readout("Peak 24h", null);
  const rMount = readout("Mount check", null);
  stRow.append(rAir.el, rListeners.el, rPeak.el, rMount.el);
  const nowLine = div("nc-bcast-line");
  const nextLine = div("nc-bcast-line");
  const reasonLine = div("nc-bcast-note");
  /* autopilot controls */
  const apRow = div("nc-bcast-row");
  const apResult = div("nc-bcast-note");
  const run = async (label: string, cmd: Parameters<typeof stationCommand>[0]) => {
    apResult.textContent = `${label}…`;
    const r = await stationCommand(cmd);
    apResult.textContent = r.ok ? `${label}: done.` : `${label} failed: ${r.error}`;
    // Re-read the station now rather than on the next 4 s poll, so Hold/Resume
    // and "autopilot next" reflect the engine's new state straight away.
    if (r.ok) consoleStore.set({ station: await broadcastLink.once() });
  };
  const skipKey = key({ label: "Skip", onPress: () => void run("Skip", { type: "mix.skip" }) });
  skipKey.el.title = "Cut to autopilot's next track (1 bar)";
  const holdKey = key({
    label: "Hold",
    onPress: () => {
      const on = consoleStore.get().station?.autopilotEnabled;
      void run(on === false ? "Resume" : "Hold", { type: "autopilot.set", enabled: on === false });
    },
  });
  holdKey.el.title = "Hold: stop sequencing, the current track keeps playing. Resume: autopilot picks and mixes again.";
  // Only offer what this caller is allowed to do (ingest enforces it regardless).
  skipKey.el.hidden = !can("mix.skip");
  holdKey.el.hidden = !can("autopilot.set");
  apRow.append(skipKey.el, holdKey.el);
  apRow.hidden = skipKey.el.hidden && holdKey.el.hidden;

  const imgTitle = div("nc-bcast-title", "Imaging");
  const imgPads = div("nc-bcast-pads");
  const imgNote = div("nc-bcast-note");
  async function loadImaging(): Promise<void> {
    const r = await fetchImaging();
    imgPads.innerHTML = "";
    if (!r) {
      imgNote.textContent = "Imaging list unavailable: the station engine is not reachable.";
      return;
    }
    if (!can("imaging.play")) return;
    imgNote.textContent = r.reason ?? (r.items.length > 12 ? `Showing 12 of ${r.items.length}.` : "");
    for (const it of r.items.slice(0, 12)) {
      const k = key({ label: it.id, onPress: () => void run(`Play ${it.id}`, { type: "imaging.play", jingleId: it.id }) });
      k.el.title = it.file;
      imgPads.append(k.el);
    }
  }
  consoleStore.select((s) => s.mode, (m) => {
    if (m === "radio") void loadImaging();
  });

  stCol.append(stRow, nowLine, nextLine, reasonLine, ...(apRow.hidden ? [] : [div("nc-bcast-title", "Autopilot"), apRow, apResult]), imgTitle, imgPads, imgNote);

  el.append(goCol, stCol);

  /* ---------------- render ---------------- */
  const renderLive = (s: LiveClientState) => {
    el.dataset.phase = s.phase;
    bannerPhase.textContent = s.phase === "countdown" && s.countdown !== null ? `Live in ${s.countdown}` : PHASE_LABEL[s.phase];
    bannerMsg.textContent = s.message;
    const p = s.phase;
    const lostWaiting = p === "lost" && s.retryUntil === null;
    goKey.el.hidden = !(p === "idle" || p === "ended" || p === "failed");
    cancelKey.el.hidden = !(p === "preflight" || p === "countdown" || p === "connecting");
    endKey.el.hidden = !(p === "armed" || p === "on_air" || p === "lost");
    endKey.el.textContent = p === "lost" ? "Stop rejoining" : "Hand back";
    rejoinKey.el.hidden = !(lostWaiting || p === "failed");
    rate.disabled = live.busy;

    // The checklist matters while arming and when something failed; once the
    // station confirms, it would only push the health line off screen.
    checks.hidden = p === "idle" || p === "on_air" || p === "ending" || p === "ended";
    checks.innerHTML = "";
    for (const c of s.checks) {
      const li = document.createElement("li");
      li.dataset.state = c.state;
      li.textContent = `${c.state === "pass" ? "✓" : c.state === "fail" ? "✕" : "·"} ${c.label}${c.detail ? `: ${c.detail}` : ""}`;
      checks.append(li);
    }

    const flowing = p === "armed" || p === "on_air" || p === "ending";
    health.hidden = !flowing;
    rSend.set(flowing && s.sendKbps !== null ? String(s.sendKbps) : null);
    const bytesPerSec = (s.bitrateKbps * 1000) / 8;
    rQueued.set(flowing ? (s.queuedBytes / bytesPerSec).toFixed(1) : null);
    rIngest.set(flowing && s.server ? String(Math.round((s.server.bytesPerSec * 8) / 1000)) : null);
    rDrift.set(flowing && s.server?.driftMeasured ? Math.max(0, -s.server.driftSec).toFixed(1) : null);
  };
  live.store.select((s) => s, renderLive);

  // Elapsed ticks independently of state changes.
  setInterval(() => {
    const s = live.state;
    rElapsed.set(s.phase === "on_air" && s.onAirSince !== null ? fmtElapsed(Date.now() - s.onAirSince) : null);
  }, 500);

  consoleStore.select((s) => s.station, (st) => {
    const reachable = !!st?.connected;
    skipKey.setDisabled(!reachable);
    holdKey.setDisabled(!reachable || st?.autopilotEnabled === null);
    holdKey.el.textContent = st?.autopilotEnabled === false ? "Resume" : "Hold";
    holdKey.setOn(st?.autopilotEnabled === false);
    if (!st || !st.connected) {
      rAir.set(null);
      rListeners.set(null);
      rPeak.set(null);
      rMount.set(null);
      nowLine.textContent = "";
      nextLine.textContent = "";
      reasonLine.textContent = st ? "The station engine (ingest) is not reachable." : "Station status loads in Radio mode.";
      return;
    }
    rAir.set(st.broadcast.onAir ? "On air" : "Off air");
    rListeners.set(st.listeners === null ? null : String(st.listeners));
    rPeak.set(st.peakListeners24h === null ? null : String(st.peakListeners24h));
    rMount.set(st.watchdog?.last ? st.watchdog.last.verdict : null);
    nowLine.textContent = st.liveTitle ? `Now on the stream: ${st.liveTitle}` : "Now on the stream: no title from Icecast";
    const nx = st.queue[0];
    nextLine.textContent = nx ? `Autopilot next: ${nx.artist ? `${nx.artist} – ` : ""}${nx.title}` : "Autopilot next: nothing cued";
    reasonLine.textContent = st.broadcast.reason;
  });

  return el;
}
