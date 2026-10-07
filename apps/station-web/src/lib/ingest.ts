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

import { streamUrl as streamUrlFor } from './stream'

const INGEST_BASE = process.env.INGEST_URL ?? 'http://127.0.0.1:8099'

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
  /**
   * The upload into Liquidsoap's harbor.
   *
   * The one link that went unreported while it was broken — the engine rendered
   * audio and uploaded to nothing, and the only evidence was a line in
   * Liquidsoap's own log. `connected` stays true when nothing is reading, so
   * `backlogBytes` is the honest liveness signal.
   */
  harbor?: {
    connected: boolean
    bytesSent: number
    framesSent: number
    backlogBytes: number
    reconnects: number
    lastError: string | null
  } | null
  /**
   * Per-deck state and the master spectrum.
   *
   * `playing` is an observation of the deck, not the `state` string. The state
   * string reads "playing" while no deck is rolling, which is how a station
   * reports itself healthy while transmitting nothing.
   *
   * Decks live under `telemetry`, matching the engine's own status shape.
   * Reading them from the top level silently yields undefined, which is how this
   * briefly reported "no deck is rolling" while the mount was passing audio.
   */
  telemetry: {
    spectrum: number[]
    /** -1 when never; climbing into the thousands means production has stopped. */
    renderStallMs?: number
    renderedAheadSec?: number
    decks?: { slot: number; trackId: string | null; playing: boolean; positionSec: number }[]
  }
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
  /**
   * THE on-air answer, computed once by the engine.
   *
   * This route used to derive `mode` itself from `stream.onAir && onAir`, which
   * stayed true after the station was taken off air — because the Icecast mount
   * stays connected while Liquidsoap outputs silence. The DJ console read a
   * different subset of the same inputs and disagreed. Both now read this.
   */
  /**
   * What the delivery path is actually carrying.
   *
   * `broadcast` says whether the station is *meant* to be audible; this says
   * whether it *is*. They disagree exactly when something between the engine
   * and the listener is broken — the case no other field could see, and the one
   * that hid five hours of silence.
   */
  watchdog?: {
    enabled: boolean
    last: {
      verdict: 'audible' | 'silent' | 'unreachable'
      meanDb: number | null
      peakDb: number | null
      mount: string
      measuredAt: string
      error: string | null
    } | null
    silentStreak: number
    operatorWantsOnAir: boolean | null
    holdingBecause: string | null
    recoveries: { at: string; action: string; ok: boolean; detail: string }[]
    lastRecoveryAt: string | null
  } | null
  station?: { onAir: boolean | null; error: string | null }
  /**
   * Liquidsoap's own report of whether the engine's upload is connected.
   *
   * From `input.harbor`'s connect/disconnect callbacks, so it is a fact rather
   * than an inference. The publisher's client-side flag is not usable: writing to
   * a socket whose peer is gone never fails, so after a daemon restart it read
   * `true` with zero reconnects while the mount carried -91 dBFS.
   */
  harborSource?: { onAir: boolean | null; error: string | null } | null
  broadcast?: {
    onAir: boolean
    reason: string
    components: {
      enginePlaying: boolean
      outputLive: boolean
      mountConnected: boolean
    }
  }
  queue?: Array<{ id: string; title: string; artist: string; bpm: number | null }>
}

/** Public stream URL, served by Icecast rather than by Next. */
export const streamUrl = (mobile = false) => streamUrlFor(mobile ? 'mobile' : 'hi')

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

/**
 * One track as the engine holds it.
 *
 * `id` is the engine's own stable id (derived from the file path), not a
 * database surrogate. The library sync writes it straight into `Track.id` so
 * the site, the console and the engine all refer to a record by the same key —
 * which is what makes "is this the same track?" answerable instead of a guess
 * based on matching titles.
 */
export type CrateTrack = {
  id: string
  title: string
  artist: string
  album: string | null
  durationSec: number
  bpm: number | null
  key: string | null
  path: string
}

export const ingestCrate = () => getJson<CrateTrack[]>('/crate')

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
 *
 * `id` is a per-attempt envelope id, and it is what makes a retry safe: the
 * ingest service replays the stored result for an id it has already seen
 * instead of running the command twice. Without one, `AbortSignal.timeout`
 * firing after ingest had already applied the command would leave the operator
 * pressing "TAKE OFF AIR" again and stopping the engine a second time.
 *
 * Do NOT reuse `actor.id` as the envelope id — it is a constant ('ops'), and
 * the replay cache would then return the first result forever, so every later
 * command would be silently discarded.
 */
export async function sendCommand(
  command: unknown,
  actor = { id: 'web', role: 'ops' as const, label: 'station web' },
  envelopeId = crypto.randomUUID(),
) {
  try {
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    // Mandatory whenever ingest is bound beyond loopback: `listen()` refuses to
    // start without a token in that case, and every mutating POST 401s
    // without one. Omitted here it used to fail as a 502 "unauthorized", which
    // reads like the engine refusing rather than a missing credential.
    if (process.env.INGEST_TOKEN) headers.authorization = `Bearer ${process.env.INGEST_TOKEN}`
    const res = await fetch(`${INGEST_BASE}/command`, {
      method: 'POST',
      signal: AbortSignal.timeout(4000),
      headers,
      body: JSON.stringify({ id: envelopeId, actor, command }),
    })
    const body = (await res.json()) as { ok: boolean } & Record<string, unknown>
    return { unreachable: false as const, body }
  } catch {
    return { unreachable: true as const, body: null }
  }
}