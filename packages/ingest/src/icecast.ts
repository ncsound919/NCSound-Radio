/**
 * Icecast stats poller.
 *
 * Icecast is the only authority on how many people are listening, so the
 * engine is told the count rather than guessing it.
 *
 * Two things about this endpoint cost time to find, both encoded below:
 *
 *  1. The JSON status page is at /status-json.xsl, NOT /admin/status-json.xsl.
 *     Anything under /admin/ is routed to the source/admin *command* parser,
 *     which does not know "status-json.xsl" and answers
 *     "400 - Unrecognised command". The XSL pages under /admin/ work; the
 *     JSON one has to come off the webroot.
 *
 *  2. A source object has no `mount` field. The mount name only appears inside
 *     `listenurl`, so it is parsed back out rather than assumed.
 */

import type { ListenerCounts, StreamEncoder, StreamMount, StreamStatus } from "@ncsound/station-core";

export type IcecastOptions = {
  host?: string;
  port?: number;
  user?: string;
  password?: string;
  /** ms between polls. Listener counts do not move faster than this. */
  intervalMs?: number;
};

type IcecastSource = {
  listenurl?: string;
  bitrate?: number;
  channels?: number;
  samplerate?: number;
  listeners?: number;
  listener_peak?: number;
  stream_start_iso8601?: string;
  title?: string;
  genre?: string;
  server_type?: string;
};

type IcecastDoc = {
  icestats?: {
    server_id?: string;
    server_start_iso8601?: string;
    source?: IcecastSource | IcecastSource[];
  };
};

/** "/live.mp3" from "http://ncsound.local:8010/live.mp3". */
function mountOf(listenurl: string | undefined): string {
  if (!listenurl) return "";
  try {
    return new URL(listenurl).pathname;
  } catch {
    const slash = listenurl.indexOf("/");
    return slash >= 0 ? listenurl.slice(slash) : listenurl;
  }
}

function asArray(s: IcecastSource | IcecastSource[] | undefined): IcecastSource[] {
  if (!s) return [];
  return Array.isArray(s) ? s : [s];
}

/** 128 -> "mp3", but derive it from the listenurl so a future aac/opus works. */
function encoderOf(source: IcecastSource): StreamEncoder {
  const m = source.listenurl?.toLowerCase() ?? "";
  if (m.endsWith(".opus")) return "opus";
  if (m.endsWith(".aac")) return "aac";
  if (m.endsWith(".mp3")) return "mp3";
  return source.server_type === "audio/mpeg" ? "mp3" : "none";
}

export function buildStreamStatus(doc: IcecastDoc, opts: { ingestHealthy: boolean; at?: string }): StreamStatus {
  const icestats = doc.icestats ?? {};
  const sources = asArray(icestats.source);

  const mounts: StreamMount[] = sources.map((s) => ({
    mount: mountOf(s.listenurl),
    encoder: encoderOf(s),
    bitrateKbps: s.bitrate ?? 0,
    // A source only appears in the source list while it is connected, so its
    // presence IS the connected signal.
    connected: true,
    connectedSince: s.stream_start_iso8601 ?? null,
    listeners: s.listeners ?? 0,
    peakListeners24h: s.listener_peak ?? 0,
    bytesSent: 0,
    lastMetadata: s.title ?? null,
  }));

  const reachable = sources.length > 0;

  return {
    ingestHealthy: opts.ingestHealthy,
    onAir: reachable && opts.ingestHealthy,
    encoder: mounts.find((m) => m.bitrateKbps >= 96)?.encoder ?? mounts[0]?.encoder ?? "none",
    mounts,
    liquidsoap: {
      reachable: opts.ingestHealthy,
      version: null,
      uptimeSec: null,
      error: opts.ingestHealthy ? null : "engine is not publishing to the harbor",
    },
    icecast: {
      reachable,
      version: icestats.server_id ?? null,
      error: reachable ? null : "no sources connected to Icecast",
    },
    updatedAt: opts.at ?? new Date().toISOString(),
  };
}

/**
 * Sum listeners across mounts, taking the larger of the two published peaks.
 *
 * The two mounts are alternative bitrates of one station, not two stations, so
 * a listener connected to both would be double counted. Reporting the maximum
 * mount rather than the sum is the closer approximation, and the peak comes
 * from Icecast's own per-mount high-water mark.
 */
export function listenerCountsFrom(status: StreamStatus): ListenerCounts {
  if (!status.icecast.reachable || status.mounts.length === 0) {
    return { current: 0, peak24h: 0, source: "icecast" };
  }
  const current = Math.max(...status.mounts.map((m) => m.listeners));
  const peak = Math.max(...status.mounts.map((m) => m.peakListeners24h));
  return { current, peak24h: peak, source: "icecast" };
}

export class IcecastPoller {
  private readonly opts: Required<Omit<IcecastOptions, never>>;
  private timer: ReturnType<typeof setInterval> | null = null;
  private last: StreamStatus | null = null;

  constructor(opts: IcecastOptions = {}) {
    this.opts = {
      host: opts.host ?? "127.0.0.1",
      port: opts.port ?? 8010,
      user: opts.user ?? "admin",
      password: opts.password ?? "admin",
      intervalMs: opts.intervalMs ?? 5000,
    };
  }

  get status(): StreamStatus | null {
    return this.last;
  }

  private get url(): string {
    const { host, port } = this.opts;
    return `http://${host}:${port}/status-json.xsl`;
  }

  /** One fetch. Never throws: a failed poll reports unreachable, not broken. */
  async poll(ingestHealthy: boolean): Promise<StreamStatus> {
    const auth = Buffer.from(`${this.opts.user}:${this.opts.password}`).toString("base64");
    try {
      const res = await fetch(this.url, {
        headers: { Authorization: `Basic ${auth}`, Accept: "application/json" },
        signal: AbortSignal.timeout(4000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const doc = (await res.json()) as IcecastDoc;
      this.last = buildStreamStatus(doc, { ingestHealthy });
    } catch (err) {
      this.last = {
        ingestHealthy,
        onAir: false,
        encoder: this.last?.encoder ?? "none",
        mounts: [],
        liquidsoap: {
          reachable: ingestHealthy,
          version: null,
          uptimeSec: null,
          error: null,
        },
        icecast: {
          reachable: false,
          version: null,
          error: err instanceof Error ? err.message : String(err),
        },
        updatedAt: new Date().toISOString(),
      };
    }
    return this.last;
  }

  start(isIngestHealthy: () => boolean, onUpdate: (s: StreamStatus) => void): void {
    if (this.timer) return;
    const tick = async () => onUpdate(await this.poll(isIngestHealthy()));
    void tick();
    this.timer = setInterval(() => void tick(), this.opts.intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
