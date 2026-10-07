import { Store } from "./store";
import type { BroadcastStatus } from "../engine/broadcastLink";

export type ConsoleMode = "party" | "radio";

export type MidiStatus =
  | { kind: "unsupported" }
  | { kind: "off" }
  | { kind: "denied" }
  | { kind: "no-device" }
  | { kind: "connected"; names: string[]; last: string };

export type OutputState = {
  masterSupported: boolean;
  headphoneSupported: boolean;
  devices: Array<{ id: string; label: string }>;
  masterId: string | null;
  headphoneId: string | null;
  headphoneActive: boolean;
  /** Headphone mix: 0 = master, 1 = cue. */
  mix: number;
  level: number;
  latencyMs: number | null;
  cue: [boolean, boolean];
  note: string;
};

export type ObsStatus = "off" | "connecting" | "connected" | "error";

export type ObsSceneItem = { id: number; name: string; enabled: boolean; kind: string };

export type ObsState = {
  /** True once an address is saved or entered. */
  configured: boolean;
  address: string;
  /** obs-websocket password. Stored in browser storage; see docs/OBS-SETUP.md. */
  password: string;
  status: ObsStatus;
  message: string;
  scenes: string[];
  currentScene: string | null;
  streaming: boolean;
  recording: boolean;
  sceneItems: ObsSceneItem[];
  media: Array<{ name: string; playing: boolean }>;
};

export type ConsoleState = {
  mode: ConsoleMode;
  /** Deck the keyboard's space bar and arrows act on: the one last touched. */
  focusDeck: 0 | 1;
  /** One quiet status line per deck (load errors, hints). */
  deckMsg: [string, string];
  /** Console-wide status line (recording saved, MIDI errors). */
  status: string;
  /** Bumped when a track loads, so views rebuild waveform tiles. */
  loadSeq: [number, number];
  midi: MidiStatus;
  outputs: OutputState;
  obs: ObsState;
  /** DJ name shown on the OBS overlay lower third. */
  djName: string;
  /** Station status from ingest `/status`, polled in Radio mode only; null until first read. */
  station: BroadcastStatus | null;
};

const MODE_KEY = "ncsound.console.mode";
const MASTER_OUT_KEY = "ncsound.console.masterOut";
const HEADPHONE_OUT_KEY = "ncsound.console.headphoneOut";
const OBS_ADDRESS_KEY = "ncsound.console.obs.address";
const OBS_PASSWORD_KEY = "ncsound.console.obs.password";
const DJ_NAME_KEY = "ncsound.console.djName";

function loadMode(): ConsoleMode {
  try {
    return localStorage.getItem(MODE_KEY) === "radio" ? "radio" : "party";
  } catch {
    return "party";
  }
}

function loadDevice(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function loadString(key: string): string {
  try {
    return localStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}

export const consoleStore = new Store<ConsoleState>({
  mode: loadMode(),
  focusDeck: 0,
  deckMsg: ["", ""],
  status: "",
  loadSeq: [0, 0],
  midi: { kind: "off" },
  outputs: {
    masterSupported: false,
    headphoneSupported: false,
    devices: [],
    masterId: loadDevice(MASTER_OUT_KEY),
    headphoneId: loadDevice(HEADPHONE_OUT_KEY),
    headphoneActive: false,
    mix: 1,
    level: 0.8,
    latencyMs: null,
    cue: [false, false],
    note: "",
  },
  obs: {
    configured: loadString(OBS_ADDRESS_KEY).length > 0,
    address: loadString(OBS_ADDRESS_KEY),
    password: loadString(OBS_PASSWORD_KEY),
    status: "off",
    message: "",
    scenes: [],
    currentScene: null,
    streaming: false,
    recording: false,
    sceneItems: [],
    media: [],
  },
  djName: loadString(DJ_NAME_KEY),
  station: null,
});

export function persistObs(address: string, password: string): void {
  try {
    localStorage.setItem(OBS_ADDRESS_KEY, address);
    localStorage.setItem(OBS_PASSWORD_KEY, password);
  } catch {
    /* private window: the choice just won't persist */
  }
}

export function persistDjName(name: string): void {
  try {
    localStorage.setItem(DJ_NAME_KEY, name);
  } catch {
    /* ignore */
  }
}

export function persistDevice(key: "master" | "headphone", id: string | null): void {
  try {
    const k = key === "master" ? MASTER_OUT_KEY : HEADPHONE_OUT_KEY;
    if (id) localStorage.setItem(k, id);
    else localStorage.removeItem(k);
  } catch {
    /* private window: the choice just won't persist */
  }
}

export function setDeckMsg(slot: 0 | 1, msg: string): void {
  consoleStore.set((s) => {
    const deckMsg: [string, string] = [...s.deckMsg];
    deckMsg[slot] = msg;
    return { deckMsg };
  });
}

consoleStore.select(
  (s) => s.mode,
  (mode) => {
    try {
      localStorage.setItem(MODE_KEY, mode);
    } catch {
      /* private window: the mode just won't persist */
    }
  },
);
