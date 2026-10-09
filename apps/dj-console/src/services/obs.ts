/**
 * OBS client (plan 6.1): obs-websocket v5 via obs-websocket-js.
 *
 * The console drives OBS, it does not replace it. Everything the Visuals tab
 * shows is read back from OBS (`GetSceneList`, `GetSceneItemList`, stream and
 * record status); nothing is typed in by the operator. Reconnects use backoff.
 * When no address is configured the service is inert and the UI says so.
 */
import OBSWebSocket from "obs-websocket-js";
import { consoleStore, type ObsState, type ObsSceneItem } from "../state/console";

const DEFAULT_ADDRESS = "ws://127.0.0.1:4455";

/** Accept "127.0.0.1:4455", "localhost:4455" or a full ws/wss URL. */
export function normalizeAddress(input: string): string {
  const s = input.trim();
  if (!s) return "";
  if (/^wss?:\/\//i.test(s)) return s;
  return `ws://${s}`;
}

export const defaultObsAddress = DEFAULT_ADDRESS;

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec => (v && typeof v === "object" ? (v as Rec) : {});
const str = (v: unknown, d = ""): string => (typeof v === "string" ? v : d);
const num = (v: unknown): number => (typeof v === "number" ? v : 0);
const bool = (v: unknown): boolean => v === true;
const describe = (e: unknown): string => (e instanceof Error ? e.message : typeof e === "string" ? e : "OBS unreachable");

const MEDIA_KIND = /ffmpeg|vlc|media|browser/i;
const MEDIA_ACTION: Record<"play" | "stop" | "restart", string> = {
  play: "OBS_WEBSOCKET_MEDIA_INPUT_ACTION_PLAY",
  stop: "OBS_WEBSOCKET_MEDIA_INPUT_ACTION_STOP",
  restart: "OBS_WEBSOCKET_MEDIA_INPUT_ACTION_RESTART",
};

export class ObsService {
  private obs = new OBSWebSocket();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private backoffMs = 1000;
  private wantConnection = false;
  private bound = false;

  get state(): ObsState {
    return consoleStore.get().obs;
  }

  get connected(): boolean {
    return consoleStore.get().obs.status === "connected";
  }

  get streaming(): boolean {
    return consoleStore.get().obs.streaming;
  }

  /** Connect (or reconnect) using the given credentials, falling back to saved ones. */
  async connect(address?: string, password?: string): Promise<void> {
    this.bind();
    const cur = consoleStore.get().obs;
    const addr = normalizeAddress(address ?? cur.address);
    const pw = password ?? cur.password;
    if (!addr) {
      this.patch({ status: "off", message: "No OBS address set." });
      return;
    }
    this.wantConnection = true;
    this.clearReconnect();
    this.patch({ configured: true, address: addr, password: pw, status: "connecting", message: "" });
    try {
      await this.obs.connect(addr, pw || undefined);
      this.backoffMs = 1000;
      this.patch({ status: "connected", message: "" });
      await this.refresh();
    } catch (e) {
      this.patch({ status: "error", message: describe(e) });
      this.scheduleReconnect();
    }
  }

  disconnect(): void {
    this.wantConnection = false;
    this.clearReconnect();
    void this.obs.disconnect().catch(() => {});
    this.patch({ status: "off", message: "", scenes: [], currentScene: null, streaming: false, recording: false, sceneItems: [], media: [] });
  }

  /** Pull scenes, the current scene, stream/record state and the scene's sources. */
  async refresh(): Promise<void> {
    if (!this.connected) return;
    try {
      const scenes = rec(await this.obs.call("GetSceneList"));
      const names = (Array.isArray(scenes.scenes) ? scenes.scenes : []).map((s) => str(rec(s).sceneName)).filter(Boolean);
      const current = str(scenes.currentProgramSceneName) || null;
      const stream = rec(await this.obs.call("GetStreamStatus"));
      const record = rec(await this.obs.call("GetRecordStatus"));
      this.patch({
        scenes: names,
        currentScene: current,
        streaming: bool(stream.outputActive),
        recording: bool(record.outputActive),
      });
      await this.refreshScene();
    } catch (e) {
      this.patch({ message: describe(e) });
    }
  }

  /** Read the current scene's items and media states. */
  async refreshScene(): Promise<void> {
    if (!this.connected) return;
    const scene = consoleStore.get().obs.currentScene;
    if (!scene) {
      this.patch({ sceneItems: [], media: [] });
      return;
    }
    try {
      const res = rec(await this.obs.call("GetSceneItemList", { sceneName: scene }));
      const items: ObsSceneItem[] = (Array.isArray(res.sceneItems) ? res.sceneItems : []).map((it) => {
        const r = rec(it);
        return { id: num(r.sceneItemId), name: str(r.sourceName), enabled: bool(r.sceneItemEnabled), kind: str(r.inputKind) };
      });
      const media = items.filter((it) => MEDIA_KIND.test(it.kind)).map((it) => ({ name: it.name, playing: false }));
      for (const m of media) {
        try {
          const st = rec(await this.obs.call("GetMediaInputStatus", { inputName: m.name }));
          m.playing = str(st.mediaState) === "OBS_MEDIA_STATE_PLAYING";
        } catch {
          /* a source that is not a media input: leave it stopped */
        }
      }
      this.patch({ sceneItems: items, media });
    } catch (e) {
      this.patch({ message: describe(e) });
    }
  }

  async setScene(name: string): Promise<void> {
    if (!this.connected) return;
    await this.guard(async () => {
      await this.obs.call("SetCurrentProgramScene", { sceneName: name });
      this.patch({ currentScene: name });
      await this.refreshScene();
    });
  }

  async setItemEnabled(id: number, enabled: boolean): Promise<void> {
    const scene = consoleStore.get().obs.currentScene;
    if (!this.connected || !scene) return;
    await this.guard(async () => {
      await this.obs.call("SetSceneItemEnabled", { sceneName: scene, sceneItemId: id, sceneItemEnabled: enabled });
      this.patch({ sceneItems: consoleStore.get().obs.sceneItems.map((it) => (it.id === id ? { ...it, enabled } : it)) });
    });
  }

  async mediaAction(name: string, action: "play" | "stop" | "restart"): Promise<void> {
    if (!this.connected) return;
    await this.guard(async () => {
      await this.obs.call("TriggerMediaInputAction", { inputName: name, mediaAction: MEDIA_ACTION[action] });
      await this.refreshScene();
    });
  }

  async toggleRecord(): Promise<void> {
    if (!this.connected) return;
    await this.guard(async () => {
      await this.obs.call("ToggleRecord");
      const record = rec(await this.obs.call("GetRecordStatus"));
      this.patch({ recording: bool(record.outputActive) });
    });
  }

  /**
   * Start streaming. OBS must already have a service and stream key configured
   * (Settings -> Stream). If it does not, `StartStream` still returns success
   * and OBS sits in OUTPUT_STARTING forever without ever emitting an error, so
   * this waits for the output to actually go active and, if it does not, says
   * so plainly instead of leaving the operator thinking they are live.
   */
  async startStream(): Promise<void> {
    if (!this.connected || this.streaming) return;
    await this.guard(async () => {
      await this.obs.call("StartStream");
      this.patch({ message: "Starting the OBS stream…" });
      for (let i = 0; i < 12; i++) {
        await new Promise((r) => setTimeout(r, 500));
        if (!this.connected) return;
        if (this.streaming) return;
        const st = rec(await this.obs.call("GetStreamStatus").catch(() => ({})));
        if (bool(st.outputActive)) {
          this.patch({ streaming: true, message: "" });
          return;
        }
      }
      this.patch({ streaming: false, message: "OBS did not go live. Set the service and stream key in OBS: Settings → Stream, then try again." });
    });
  }

  async stopStream(): Promise<void> {
    if (!this.connected || !this.streaming) return;
    await this.guard(async () => {
      await this.obs.call("StopStream");
      this.patch({ streaming: false, message: "" });
    });
  }

  /**
   * Point OBS's stream output at a service (Cloudflare Stream: RTMPS server +
   * live-input key). OBS must be connected. This only writes settings; the
   * existing Start/Stop stream control then goes live on them.
   */
  async setStreamService(server: string, key: string): Promise<boolean> {
    if (!this.connected) return false;
    try {
      await this.obs.call("SetStreamServiceSettings", {
        streamServiceType: "rtmp_custom",
        streamServiceSettings: { server, key },
      });
      this.patch({ message: "Sent the stream server and key to OBS." });
      return true;
    } catch (e) {
      // Report the failure to the caller as well as the status line: the caller
      // used to print "Sent." unconditionally while OBS had rejected it.
      this.patch({ message: describe(e) });
      return false;
    }
  }

  /** Read back what OBS is configured to stream to, if connected. */
  async getStreamService(): Promise<{ server: string; key: string } | null> {
    if (!this.connected) return null;
    try {
      const res = rec(await this.obs.call("GetStreamServiceSettings"));
      const s = rec(res.streamServiceSettings);
      return { server: str(s.server), key: str(s.key) };
    } catch {
      return null;
    }
  }

  async toggleStream(): Promise<void> {
    if (!this.connected) return;
    if (this.streaming) await this.stopStream();
    else await this.startStream();
  }

  private async guard(fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (e) {
      this.patch({ message: describe(e) });
    }
  }

  private patch(p: Partial<ObsState>): void {
    consoleStore.set((s) => ({ obs: { ...s.obs, ...p } }));
  }

  private bind(): void {
    if (this.bound) return;
    this.bound = true;
    this.obs.on("ConnectionClosed", () => {
      if (this.wantConnection) {
        this.patch({ status: "connecting", message: "Reconnecting to OBS…" });
        this.scheduleReconnect();
      } else {
        this.patch({ status: "off" });
      }
    });
    this.obs.on("ConnectionError", () => {
      if (this.wantConnection) this.scheduleReconnect();
    });
    this.obs.on("CurrentProgramSceneChanged", (d) => {
      this.patch({ currentScene: d.sceneName });
      void this.refreshScene();
    });
    this.obs.on("StreamStateChanged", (d) => this.patch({ streaming: d.outputActive }));
    this.obs.on("RecordStateChanged", (d) => this.patch({ recording: d.outputActive }));
  }

  private scheduleReconnect(): void {
    if (!this.wantConnection || this.reconnectTimer) return;
    const delay = this.backoffMs;
    this.backoffMs = Math.min(15000, this.backoffMs * 2);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, delay);
  }

  private clearReconnect(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }
}
