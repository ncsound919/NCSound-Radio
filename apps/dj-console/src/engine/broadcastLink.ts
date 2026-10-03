/**
 * Broadcast truth for the DJ console.
 *
 * The console mixes locally in the browser, so it can read its own decks and
 * master bus synchronously. It cannot know how many people are listening, and
 * it certainly cannot know whether Icecast has the stream. Those come from the
 * ingest service, which owns the headless engine and polls Icecast.
 *
 * Previously this information came from a vite middleware with 42 listeners
 * hardcoded in it. Anything that is not measured here is reported as null so
 * the UI can show "not connected" rather than a plausible number.
 *
 * Requests go through the vite proxy at /ingest, because ingest sends no CORS
 * headers and a cross-origin call from the browser would be blocked.
 */

export type BroadcastMount = {
  mount: string;
  bitrateKbps: number;
  listeners: number;
  peakListeners24h: number;
  lastMetadata: string | null;
};

export type BroadcastStatus = {
  /** ingest answered at all. */
  connected: boolean;
  /** ingest answered and the engine has a crate loaded and is playing. */
  engineReady: boolean;
  engineState: string;
  crateSize: number;
  /** Real count from Icecast, or null when it has not been measured. */
  listeners: number | null;
  peakListeners24h: number | null;
  streamOnAir: boolean | null;
  icecastReachable: boolean | null;
  icecastVersion: string | null;
  mounts: BroadcastMount[];
  /** Title Icecast last saw from ICY metadata. */
  liveTitle: string | null;
  updatedAt: string;
  error: string | null;
};

const OFFLINE: BroadcastStatus = {
  connected: false,
  engineReady: false,
  engineState: "unreachable",
  crateSize: 0,
  listeners: null,
  peakListeners24h: null,
  streamOnAir: null,
  icecastReachable: null,
  icecastVersion: null,
  mounts: [],
  liveTitle: null,
  updatedAt: new Date().toISOString(),
  error: "ingest service is not reachable",
};

async function getJson<T>(path: string, timeoutMs = 2500): Promise<T | null> {
  try {
    const res = await fetch(`/ingest${path}`, {
      signal: AbortSignal.timeout(timeoutMs),
      cache: "no-store",
      headers: { accept: "application/json" },
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

function toStatus(doc: {
  engine: {
    state: string;
    autopilot: { crateSize: number };
    listeners: { current: number; peak24h: number };
  };
  stream: {
    onAir: boolean;
    icecast: { reachable: boolean; version: string | null };
    mounts: BroadcastMount[];
  } | null;
}): BroadcastStatus {
  const live = doc.stream?.mounts?.find((m) => m.lastMetadata) ?? null;
  return {
    connected: true,
    engineReady: doc.engine.state === "playing" || doc.engine.state === "idle",
    engineState: doc.engine.state,
    crateSize: doc.engine.autopilot.crateSize,
    listeners: doc.engine.listeners.current,
    peakListeners24h: doc.engine.listeners.peak24h,
    streamOnAir: doc.stream?.onAir ?? null,
    icecastReachable: doc.stream?.icecast.reachable ?? null,
    icecastVersion: doc.stream?.icecast.version ?? null,
    mounts: doc.stream?.mounts ?? [],
    liveTitle: live?.lastMetadata ?? null,
    updatedAt: new Date().toISOString(),
    error: null,
  };
}

/**
 * Poll broadcast status on an interval.
 *
 * onUpdate receives OFFLINE rather than throwing when ingest is down, so a
 * caller can render a disconnected state from the same code path.
 */
export class BroadcastLink {
  private timer: ReturnType<typeof setInterval> | null = null;
  private latest: BroadcastStatus = OFFLINE;

  constructor(private readonly intervalMs = 4000) {}

  get status(): BroadcastStatus {
    return this.latest;
  }

  async once(): Promise<BroadcastStatus> {
    const doc = await getJson<Parameters<typeof toStatus>[0]>("/status");
    this.latest = doc ? toStatus(doc) : { ...OFFLINE, updatedAt: new Date().toISOString() };
    return this.latest;
  }

  start(onUpdate: (s: BroadcastStatus) => void): void {
    if (this.timer) return;
    const tick = async () => onUpdate(await this.once());
    void tick();
    this.timer = setInterval(() => void tick(), this.intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

export const broadcastLink = new BroadcastLink();