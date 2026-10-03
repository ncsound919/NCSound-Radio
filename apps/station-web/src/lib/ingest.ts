/**
 * Client for the ingest service.
 *
 * The station app is a Next.js server; the DJ engine is a separate long-running
 * process. This is the only place that knows how to reach it, so nothing else
 * in the app has to care about ports or failure modes.
 *
 * Every getter returns null when ingest is unreachable. Callers must render an
 * offline state from that rather than substituting a plausible-looking number:
 * a station that shows 38 listeners when it has none is worse than one that
 * admits it is not connected.
 */

const INGEST_BASE = process.env.INGEST_URL ?? 'http://127.0.0.1:8099'

/** Icecast moved off 8000: an unrelated Windows service holds that port. */
const ICECAST_PORT = process.env.ICECAST_PORT ?? '8010'

export type IngestEngineStatus = {
  state: string
  onAir: {
    current: {
      track: {
        id: string
        title: string
        artist: string
        durationSec: number
        bpm: number | null
      }
      startedAt: string
      elapsed: number
      duration: number
      remaining: number
      progress: number
    }
    element: { kind: string }
    daypart: { clean: boolean; label: string }
    liveShow: unknown | null
    next: Array<{
      id: string
      title: string
      artist: string
      durationSec: number
      bpm: number | null
      elementKind: string
    }>
    cycleSec: number
    serverTime: string
  } | null
  autopilot: { enabled: boolean; vibeTemplateId: string | null; crateSize: number }
  listeners: { current: number; peak24h: number; source: string }
  uptimeSec: number
  serverTime: string
  lastError: string | null
}

export type IngestStreamStatus = {
  onAir: boolean
  encoder: string
  mounts: Array<{
    mount: string
    bitrateKbps: number
    listeners: number
    peakListeners24h: number
    lastMetadata: string | null
    connected: boolean
  }>
  icecast: { reachable: boolean; version: string | null; error: string | null }
  updatedAt: string
}

export type IngestStatus = {
  engine: IngestEngineStatus
  stream: IngestStreamStatus | null
}

/** Public stream URL, served by Icecast rather than by Next. */
export const streamUrl = (mobile = false) =>
  `http://127.0.0.1:${ICECAST_PORT}${mobile ? '/mobile.mp3' : '/live.mp3'}`

async function getJson<T>(path: string, timeoutMs = 2500): Promise<T | null> {
  try {
    const res = await fetch(`${INGEST_BASE}${path}`, {
      signal: AbortSignal.timeout(timeoutMs),
      cache: 'no-store',
      headers: { accept: 'application/json' },
    })
    if (!res.ok) return null
    return (await res.json()) as T
  } catch {
    return null
  }
}

export const ingestStatus = () => getJson<IngestStatus>('/status')

export const ingestHealth = () =>
  getJson<{ ok: boolean; ready: boolean; engineState: string; crateSize: number; onAir: boolean }>(
    '/health',
    1500,
  )

export const ingestListenerHistory = () =>
  getJson<{ startedAt: string | null; samples: Array<{ at: string; current: number }> }>(
    '/listeners/history',
  )

/**
 * Send a control command to the engine.
 *
 * Returns null when ingest cannot be reached, which is distinct from the
 * command being refused: unreachable means "not connected", refused means
 * "the station said no".
 */
export async function sendCommand(command: unknown, actor = { id: 'web', role: 'ops' as const, label: 'station web' }) {
  try {
    const res = await fetch(`${INGEST_BASE}/command`, {
      method: 'POST',
      signal: AbortSignal.timeout(4000),
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ actor, command }),
    })
    const body = (await res.json()) as { ok: boolean } & Record<string, unknown>
    if (!res.ok && !body.ok) return { unreachable: false as const, body }
    return { unreachable: false as const, body }
  } catch {
    return { unreachable: true as const, body: null }
  }
}