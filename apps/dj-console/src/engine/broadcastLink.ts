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
  /** Seconds since the engine's own start, or null when unreachable. */
  uptimeSec: number | null;
  /** Engine's last reported error, or null. */
  engineError: string | null;
  /** Real count from Icecast, or null when it has not been measured. */
  listeners: number | null;
  peakListeners24h: number | null;
  streamOnAir: boolean | null;
  icecastReachable: boolean | null;
  icecastVersion: string | null;
  mounts: BroadcastMount[];
  /** Title Icecast last saw from ICY metadata. */
  liveTitle: string | null;
  /**
   * What the engine has cued after the current track.
   *
   * From the engine, not the booth's queue — the rehearsal list routinely
   * differs from what will actually air, and the OBS overlay must not
   * announce a track the stream will never play.
   */
  queue: Array<{ id: string; title: string; artist: string; bpm: number | null }>;
  /**
   * The engine's single on-air answer.
   *
   * Read, not derived. This console and the station site each used to compute
   * "are we live?" from a different subset of the same three inputs, and they
   * disagreed in the case that mattered: taking the station off air satisfied
   * the site's test (Icecast mount connected, engine still armed a track) and
   * failed the console's (the Liquidsoap switch was off), so the listener-facing
   * site kept announcing "live" while the station transmitted silence.
   */
  broadcast: {
    onAir: boolean;
    reason: string;
    components: { enginePlaying: boolean; outputLive: boolean; mountConnected: boolean };
  };
  /**
   * What the delivery path is actually carrying.
   *
   * `broadcast` says whether the station is *meant* to be audible; this says
   * whether it *is*. The station once broadcast silence for five hours with
   * every field above reading healthy, because they all describe the engine's
   * intentions and none of them describes the mount. The DJ is the person who
   * would have noticed first, so this belongs on their board.
   */
  watchdog: {
    enabled: boolean;
    last: {
      verdict: 'audible' | 'silent' | 'unreachable';
      meanDb: number | null;
      measuredAt: string;
      error: string | null;
    } | null;
    operatorWantsOnAir: boolean | null;
    holdingBecause: string | null;
    lastRecovery: { at: string; ok: boolean; detail: string } | null;
  } | null;
  stationOnAir: boolean | null;
  stationError: string | null;
  updatedAt: string;
  error: string | null;
};

const OFFLINE: BroadcastStatus = {
  connected: false,
  engineReady: false,
  engineState: "unreachable",
  crateSize: 0,
  uptimeSec: null,
  engineError: null,
  listeners: null,
  peakListeners24h: null,
  streamOnAir: null,
  icecastReachable: null,
  icecastVersion: null,
  mounts: [],
  liveTitle: null,
  queue: [],
  stationOnAir: null,
  broadcast: {
    onAir: false,
    reason: 'ingest service is not reachable',
    components: { enginePlaying: false, outputLive: false, mountConnected: false },
  },
  watchdog: null,
  stationError: "ingest service is not reachable",
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
    uptimeSec: number;
    lastError: string | null;
  };
  stream: {
    onAir: boolean;
    icecast: { reachable: boolean; version: string | null };
    mounts: BroadcastMount[];
  } | null;
  queue?: Array<{ id: string; title: string; artist: string; bpm: number | null }>;
  station?: { onAir: boolean | null; error: string | null };
  /** Delivery-path measurement, straight from ingest. */
  watchdog?: {
    enabled: boolean;
    last: {
      verdict: 'audible' | 'silent' | 'unreachable';
      meanDb: number | null;
      peakDb: number | null;
      mount: string;
      measuredAt: string;
      error: string | null;
    } | null;
    silentStreak: number;
    operatorWantsOnAir: boolean | null;
    holdingBecause: string | null;
    recoveries: { at: string; action: string; ok: boolean; detail: string }[];
    lastRecoveryAt: string | null;
  } | null;
  broadcast?: {
    onAir: boolean;
    reason: string;
    components: { enginePlaying: boolean; outputLive: boolean; mountConnected: boolean };
  };
}): BroadcastStatus {
  const live = doc.stream?.mounts?.find((m) => m.lastMetadata) ?? null;
  return {
    connected: true,
    engineReady: doc.engine.state === "playing" || doc.engine.state === "idle",
    engineState: doc.engine.state,
    crateSize: doc.engine.autopilot.crateSize,
    uptimeSec: doc.engine.uptimeSec,
    engineError: doc.engine.lastError,
    listeners: doc.engine.listeners.current,
    peakListeners24h: doc.engine.listeners.peak24h,
    streamOnAir: doc.stream?.onAir ?? null,
    icecastReachable: doc.stream?.icecast.reachable ?? null,
    icecastVersion: doc.stream?.icecast.version ?? null,
    mounts: doc.stream?.mounts ?? [],
    liveTitle: live?.lastMetadata ?? null,
    queue: doc.queue ?? [],
    stationOnAir: doc.station?.onAir ?? null,
    // Read from the engine, never computed here. See the note on `broadcast`.
    broadcast: doc.broadcast ?? {
      onAir: false,
      reason: 'engine did not report a broadcast state',
      components: { enginePlaying: false, outputLive: false, mountConnected: false },
    },
    watchdog: doc.watchdog
      ? {
          enabled: doc.watchdog.enabled,
          last: doc.watchdog.last,
          operatorWantsOnAir: doc.watchdog.operatorWantsOnAir,
          holdingBecause: doc.watchdog.holdingBecause,
          lastRecovery: doc.watchdog.lastRecoveryAt
            ? {
                at: doc.watchdog.lastRecoveryAt,
                ok: doc.watchdog.recoveries.filter((r) => r.at === doc.watchdog!.lastRecoveryAt).pop()?.ok ?? true,
                detail:
                  doc.watchdog.recoveries
                    .filter((r) => r.at === doc.watchdog!.lastRecoveryAt)
                    .pop()?.detail ?? 'recovered',
              }
            : null,
        }
      : null,
    stationError: doc.station?.error ?? null,
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