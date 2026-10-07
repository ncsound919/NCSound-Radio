/**
 * Visuals tab (plan 6.2): drives OBS over obs-websocket v5.
 * The scene list, sources, media state and stream/record status are all read
 * back from OBS. If OBS is not connected the controls are inert and the tab
 * says so — no placebo.
 */
import type { ObsService } from "../../services/obs";
import { consoleStore } from "../../state/console";
import { key, readout } from "../controls";

function div(cls: string, text?: string): HTMLDivElement {
  const d = document.createElement("div");
  d.className = cls;
  if (text !== undefined) d.textContent = text;
  return d;
}

export function visualsView(obs: ObsService): HTMLElement {
  const el = div("nc-visuals");

  const status = readout("OBS", null);
  const stream = readout("Stream", null, "live");
  const rec = div("nc-visuals-row");
  const recKey = key({ label: "OBS Record", toggle: true, tone: "live", onPress: () => void obs.toggleRecord() });
  recKey.el.setAttribute("aria-label", "Toggle OBS recording");
  // OBS owns the video stream; the console starts and stops it. The label and
  // pressed state are read back from OBS, never set by the click alone.
  const streamKey = key({ label: "Go live", tone: "live", onPress: () => void (obs.streaming ? obs.stopStream() : obs.startStream()) });
  streamKey.el.setAttribute("aria-label", "Start or stop the OBS stream");

  const head = div("nc-visuals-row");
  head.append(status.el, key({ label: "Reconnect", onPress: () => void obs.connect() }).el);
  el.append(head);

  const notConfigured = div("nc-visuals-note", "No OBS address set. Add it in Settings to control scenes and sources.");
  el.append(notConfigured);

  /* scenes */
  const scenesTitle = div("nc-visuals-title", "Scenes");
  const scenesWrap = div("nc-visuals-scenes");
  el.append(scenesTitle, scenesWrap);

  /* sources */
  const sourcesTitle = div("nc-visuals-title", "Sources in the current scene");
  const sourcesWrap = div("nc-visuals-sources");
  el.append(sourcesTitle, sourcesWrap);

  /* stream + record */
  const outputRow = div("nc-visuals-row");
  outputRow.append(stream.el, streamKey.el, recKey.el);
  el.append(outputRow);

  const note = div("nc-visuals-note");
  el.append(note);

  let lastScenes: string[] | null = null;
  let lastItems: unknown = null;

  const rebuildScenes = () => {
    const s = consoleStore.get().obs;
    scenesWrap.innerHTML = "";
    if (!s.scenes.length) {
      scenesWrap.append(div("nc-visuals-empty", s.status === "connected" ? "No scenes reported by OBS." : "Scene list appears when OBS connects."));
      return;
    }
    for (const name of s.scenes) {
      const k = key({ label: name, toggle: true, onPress: () => void obs.setScene(name) });
      k.setOn(name === s.currentScene);
      k.el.setAttribute("aria-label", `OBS scene ${name}`);
      scenesWrap.append(k.el);
    }
  };

  const rebuildSources = () => {
    const s = consoleStore.get().obs;
    sourcesWrap.innerHTML = "";
    if (s.status !== "connected") {
      sourcesWrap.append(div("nc-visuals-empty", "Sources appear when OBS connects."));
      return;
    }
    if (!s.sceneItems.length) {
      sourcesWrap.append(div("nc-visuals-empty", "This scene has no sources."));
      return;
    }
    for (const item of s.sceneItems) {
      const row = div("nc-visuals-source");
      const toggle = key({ label: item.enabled ? "Shown" : "Hidden", toggle: true, onPress: () => void obs.setItemEnabled(item.id, !item.enabled) });
      toggle.setOn(item.enabled);
      toggle.el.title = `${item.kind || "source"} — show/hide this source`;
      toggle.el.setAttribute("aria-label", `Toggle ${item.name}`);
      row.append(div("nc-visuals-source-name", item.name), toggle.el);
      // Media sources get transport.
      const media = s.media.find((m) => m.name === item.name);
      if (media) {
        const t = div("nc-visuals-media");
        t.append(
          key({ label: media.playing ? "Playing" : "Play", toggle: true, onPress: () => void obs.mediaAction(item.name, "play") }).el,
          key({ label: "Stop", onPress: () => void obs.mediaAction(item.name, "stop") }).el,
          key({ label: "Restart", onPress: () => void obs.mediaAction(item.name, "restart") }).el,
        );
        row.append(t);
      }
      sourcesWrap.append(row);
    }
  };

  const paintStream = (s: { status: string; streaming: boolean }) => {
    stream.set(s.streaming ? "live" : "off");
    streamKey.el.textContent = s.streaming ? "Stop stream" : "Go live";
    streamKey.setOn(s.streaming);
    streamKey.setDisabled(s.status !== "connected");
  };

  consoleStore.select((s) => s.obs.scenes, (scenes) => {
    if (lastScenes !== scenes) { lastScenes = scenes; rebuildScenes(); }
  });
  consoleStore.select((s) => s.obs.currentScene, () => rebuildScenes());
  consoleStore.select((s) => s.obs.sceneItems, (items) => {
    // sceneItems is a fresh array each refresh; rebuild only when it actually changes.
    const sig = JSON.stringify(items);
    if (lastItems !== sig) { lastItems = sig; rebuildSources(); }
  });

  consoleStore.select((s) => s.obs.status, () => {
    const s = consoleStore.get().obs;
    status.set(s.status === "connected" ? (s.currentScene ?? "connected") : s.status);
    notConfigured.hidden = s.configured;
    rebuildScenes();
    rebuildSources();
    paintStream(s);
  });
  consoleStore.select((s) => s.obs.streaming, () => paintStream(consoleStore.get().obs));
  consoleStore.select((s) => s.obs.recording, (on) => recKey.setOn(on));
  consoleStore.select((s) => s.obs.message, (m) => (note.textContent = m));

  // Initial paint from whatever the store already holds.
  const s0 = consoleStore.get().obs;
  status.set(s0.status === "connected" ? (s0.currentScene ?? "connected") : s0.status);
  paintStream(s0);
  recKey.setOn(s0.recording);
  notConfigured.hidden = s0.configured;
  note.textContent = s0.message;
  rebuildScenes();
  rebuildSources();

  return el;
}
