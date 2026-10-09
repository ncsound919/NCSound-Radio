/**
 * The redesigned console: top bar, waveforms, Deck A | Mixer | Deck B, and the
 * mode-specific bottom zone.
 */
import "../ui/tokens.css";
import "./shell.css";
import "../ui/views/views.css";
import { ConsoleAudio, deckName, type Slot } from "../audio/engine";
import { consoleStore, setDeckMsg } from "../state/console";
import { topbarView } from "../ui/views/topbar";
import { waveformsView } from "../ui/views/waveforms";
import { deckView } from "../ui/views/deck";
import { mixerView } from "../ui/views/mixer";
import { fxView } from "../ui/views/fx";
import { samplerView } from "../ui/views/sampler";
import { visualsView } from "../ui/views/visuals";
import { settingsPanel } from "../ui/views/settings";
import { libraryView } from "../ui/views/library";
import { LibraryController } from "../library/controller";
import { listOutputs, setMasterOutput } from "../audio/outputs";
import { ObsService } from "../services/obs";
import { AudibleDeckTracker } from "../audio/audibleDeck";
import { publishNowPlaying } from "../audio/nowPlaying";
import { tabs } from "../ui/controls";
import { FX_DIVISIONS } from "@ncsound/dj-engine/fx";
import { bindKeyboard, SHORTCUTS } from "./keyboard";
import { autoConnectMidi, connectMidi } from "../midi/access";
import type { MidiAction } from "../midi/mpd226";
import type { ConsoleMode } from "../state/console";
import { broadcastView } from "../ui/views/broadcast";
import { requestsView } from "../ui/views/requests";
import { LiveClient, browserLiveDeps } from "../radio/live";
import { broadcastLink } from "../engine/broadcastLink";
import { canRead, getWho, isRestricted, sessionToken } from "./session";

export function boot(root: HTMLElement): ConsoleAudio {
  const restricted = isRestricted();
  if (restricted) {
    // A host/guest console is a radio terminal: no Party mode, no OBS, no admin.
    consoleStore.set({ mode: "radio" });
    document.body.dataset.role = getWho()?.role ?? "guest";
  }
  const audio = new ConsoleAudio();
  root.innerHTML = "";
  root.className = "nc-app";

  const loadFiles = (slot: Slot, files: FileList | File[]) => {
    const file = Array.from(files).find((f) => f.type.startsWith("audio/") || /\.(mp3|wav|aiff?|flac|ogg|m4a|aac)$/i.test(f.name));
    if (!file) {
      setDeckMsg(slot, "That isn't an audio file.");
      return;
    }
    setDeckMsg(slot, `Loading ${file.name}…`);
    // Let the message paint before decode and analysis block the main thread.
    requestAnimationFrame(() => setTimeout(async () => {
      try {
        await audio.load(slot, file);
        consoleStore.set((s) => {
          const loadSeq: [number, number] = [...s.loadSeq];
          loadSeq[slot]++;
          return { loadSeq, focusDeck: slot };
        });
      } catch (e) {
        setDeckMsg(slot, e instanceof Error ? e.message : `Couldn't load into deck ${deckName(slot)}.`);
      }
    }, 0));
  };

  const onMidi = (a: MidiAction) => {
    const m = audio.mixer;
    switch (a.type) {
      case "hotcue": audio.hotCue(a.slot, a.key); break;
      case "play": void audio.togglePlay(a.slot); break;
      case "cue": audio.cue(a.slot); break;
      case "sync": audio.sync(a.slot); break;
      case "loop": audio.loop(a.slot, "toggle"); break;
      case "volume": m.setDeckChannelVolume(a.slot, a.value); break;
      case "crossfader": m.setCrossfader(a.value); break;
      case "filter": audio.deck(a.slot).setColorFilter(a.value); break;
      case "trim": audio.deck(a.slot).setManualTrim(a.value, m.autoGainEnabled); break;
      case "eq": audio.deck(a.slot).setEq(a.band, a.value); break;
      case "eqKill": audio.deck(a.slot).setEqKill(a.band, a.on); break;
      case "headphoneCue": {
        audio.setDeckCue(a.slot, a.on);
        consoleStore.set((s) => {
          const cue = [...s.outputs.cue] as [boolean, boolean];
          cue[a.slot] = a.on;
          return { outputs: { ...s.outputs, cue } };
        });
        break;
      }
      case "pad": audio.sampler.trigger(a.bank, a.pad, { velocity: a.velocity }); break;
      case "fxOn": {
        const u = audio.mixer.fx.units[a.unit];
        u.setOn(!u.state().on);
        break;
      }
      case "fxDivision": {
        const u = audio.mixer.fx.units[0];
        const i = FX_DIVISIONS.indexOf(u.state().division);
        u.setDivision(FX_DIVISIONS[(i + a.delta + FX_DIVISIONS.length) % FX_DIVISIONS.length]);
        break;
      }
      case "fxWet": audio.mixer.fx.units[0].setWet(a.value); break;
      case "fxParam": audio.mixer.fx.units[0].setParam(a.value); break;
      case "samplerVolume": audio.sampler.setVolume(a.value); break;
      case "obs": {
        const o = consoleStore.get().obs;
        if (a.action === "scene") {
          const name = o.scenes[a.index ?? -1];
          if (name) void obs.setScene(name);
        } else if (a.action === "mediaPlay" || a.action === "mediaStop") {
          const media = o.media[0];
          if (media) void obs.mediaAction(media.name, a.action === "mediaPlay" ? "play" : "stop");
        } else if (a.action === "camera") {
          const item = o.sceneItems[0];
          if (item) void obs.setItemEnabled(item.id, !item.enabled);
        } else if (a.action === "overlay") {
          const item = o.sceneItems.find((it) => /overlay/i.test(it.name));
          if (item) void obs.setItemEnabled(item.id, !item.enabled);
        } else if (a.action === "record") {
          void obs.toggleRecord();
        }
        break;
      }
      case "transport": {
        const f = consoleStore.get().focusDeck;
        if (a.action === "play") void audio.togglePlay(f);
        else if (a.action === "stop" && audio.deck(f).playing) void audio.togglePlay(f);
        else if (a.action === "rec") void audio.toggleRecording().then((r) => r.message && consoleStore.set({ status: r.message }));
        break;
      }
    }
  };

  const shell = document.createElement("div");
  shell.className = "nc-shell";
  shell.dataset.frame = "";

  const stage = document.createElement("main");
  stage.className = "nc-stage";
  const bottom = document.createElement("section");
  bottom.className = "nc-zone nc-bottom";
  bottom.setAttribute("aria-label", "Library, sampler and FX");

  // Built once and rearranged per mode, so the FX view's frame subscription is
  // not recreated every time the DJ toggles Party / Radio.
  const library = new LibraryController(audio);
  // Go live (plan 5.3). The encoder reads a program-bus tap: post-limiter
  // master, so it carries decks, sampler and mic talkover. Created on first
  // use so a Party-only session never pays for it.
  let programDest: MediaStreamAudioDestinationNode | null = null;
  const programStream = () => {
    if (!programDest) {
      programDest = audio.mixer.ctx.createMediaStreamDestination();
      audio.mixer.addProgramTap(programDest);
    }
    return programDest.stream;
  };
  const live = new LiveClient(browserLiveDeps(programStream, sessionToken(), { autoRejoin: !restricted }));
  const obs = new ObsService();
  const panels = {
    library: libraryView(audio, library),
    sampler: samplerView(audio),
    fx: fxView(audio),
    visuals: visualsView(obs),
    broadcast: broadcastView(audio, live, obs),
    requests: requestsView(audio, library),
  };
  void library.boot();
  const buildTabs = (mode: ConsoleMode): HTMLElement => {
    if (restricted) {
      const items = [
        { id: "broadcast", label: "Broadcast", panel: panels.broadcast },
        { id: "library", label: "Library", panel: panels.library },
        ...(canRead("/requests") ? [{ id: "requests", label: "Requests", panel: panels.requests }] : []),
        { id: "sampler", label: "Sampler", panel: panels.sampler },
      ];
      return tabs(items).el;
    }
    const items = mode === "party"
      ? [
          { id: "library", label: "Library", panel: panels.library },
          { id: "sampler", label: "Sampler", panel: panels.sampler },
          { id: "fx", label: "FX", panel: panels.fx },
          { id: "visuals", label: "Visuals", panel: panels.visuals },
        ]
      : [
          { id: "library", label: "Library", panel: panels.library },
          { id: "broadcast", label: "Broadcast", panel: panels.broadcast },
          { id: "requests", label: "Requests", panel: panels.requests },
          { id: "sampler", label: "Sampler", panel: panels.sampler },
        ];
    return tabs(items).el;
  };
  let bottomTabs = buildTabs(consoleStore.get().mode);
  const keys = document.createElement("p");
  keys.className = "nc-bottom-keys";
  keys.textContent = SHORTCUTS;
  bottom.append(bottomTabs, keys);

  stage.append(
    waveformsView(audio, loadFiles),
    deckView(audio, 0, loadFiles),
    mixerView(audio),
    deckView(audio, 1, loadFiles),
    bottom,
  );
  const settings = settingsPanel(audio, obs, { restricted });
  shell.append(topbarView(audio, () => void connectMidi(onMidi), () => { settings.hidden = !settings.hidden; }, live, { restricted, label: getWho()?.label }), stage);
  root.append(shell, settings);

  // Output devices: populate, then apply a saved master sink if one was chosen.
  void listOutputs(false).then((devices) => consoleStore.set((s) => ({ outputs: { ...s.outputs, devices } })));
  const savedMaster = consoleStore.get().outputs.masterId;
  if (savedMaster) {
    void setMasterOutput(audio.mixer, savedMaster).then((r) => {
      if (!r.ok) consoleStore.set((s) => ({ outputs: { ...s.outputs, note: `Saved master output unavailable, using default. ${r.message}` } }));
    });
  }

  consoleStore.select((s) => s.mode, (mode) => {
    const next = buildTabs(mode);
    bottomTabs.replaceWith(next);
    bottomTabs = next;
    // Station status is polled only in Radio mode: a Party set at a club has
    // no station to ask, and polling a dead ingest only makes noise.
    if (mode === "radio") broadcastLink.start((station) => consoleStore.set({ station }));
    else broadcastLink.stop();
  });

  // Closing the tab while live drops the station to autopilot; ask first.
  window.addEventListener("beforeunload", (e) => {
    const p = live.state.phase;
    if (p === "armed" || p === "on_air" || p === "countdown" || p === "connecting") {
      e.preventDefault();
      // Some browsers require returnValue to be set for the confirmation to show.
      e.returnValue = "";
    }
  });

  // Browsers keep audio suspended until a gesture; any click or key wakes it.
  const wake = () => void audio.resume();
  document.addEventListener("pointerdown", wake, { capture: true });
  document.addEventListener("keydown", wake, { capture: true });
  // Dropping a file anywhere else must not navigate away from a live set.
  window.addEventListener("dragover", (e) => e.preventDefault());
  window.addEventListener("drop", (e) => e.preventDefault());

  // Publish now-playing for the OBS overlay (plan 6.4). The audible deck is the
  // one with the most gain after channel fader and crossfader, held for 4 s.
  const audible = new AudibleDeckTracker(4000);
  const publish = () => {
    const gains = audio.mixer.computeCrossfaderGains();
    const levels: [{ playing: boolean; gain: number }, { playing: boolean; gain: number }] = [
      { playing: audio.deck(0).playing, gain: audio.deck(0).channelVolume * gains[0] },
      { playing: audio.deck(1).playing, gain: audio.deck(1).channelVolume * gains[1] },
    ];
    const slot = audible.update(performance.now(), levels);
    const t = slot != null ? audio.tracks[slot] : null;
    const store = consoleStore.get();
    // Real on-air, not a hardcoded null: only claim it in radio mode, and only
    // when ingest actually answered (`connected`). A disconnected link leaves
    // it null (unknown) rather than showing the overlay a green dot for a
    // station that may be off air.
    const link = broadcastLink.status;
    publishNowPlaying({
      slot,
      title: t?.title ?? "",
      artist: t?.artist ?? "",
      djName: store.djName,
      mode: store.mode,
      onAir: store.mode === "radio" && link.connected ? link.broadcast.onAir : null,
      at: Date.now(),
    });
  };
  setInterval(publish, 1000);

  // OBS: reconnect automatically when an address was saved.
  if (consoleStore.get().obs.configured) void obs.connect();
  const debug = new URLSearchParams(location.search).has("debug");
  if (debug) {
    (window as unknown as { __ncConsole?: ConsoleAudio; __ncObs?: ObsService }).__ncObs = obs;
    (window as unknown as { __ncLive?: LiveClient }).__ncLive = live;
    (window as unknown as { __ncConsole?: ConsoleAudio }).__ncConsole = audio;
  }

  bindKeyboard(audio);
  void autoConnectMidi(onMidi);
  return audio;
}
