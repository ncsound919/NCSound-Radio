'use client'

/**
 * useNowPlaying — shared singleton poller for GET /api/nowplaying.
 *
 * Every consumer of the hook (player bar, header listener chip, on-air
 * section) shares ONE fetch loop: the first subscriber triggers an immediate
 * fetch, then the response is re-fetched every `pollMs` while at least one
 * subscriber is mounted. When the last subscriber unmounts, the timer stops.
 *
 * The hook stays pure — it does not interpolate playback time. Consumers use
 * `lastFetch` + `current.startedAt`/`current.progress` to animate locally.
 */

import { useEffect, useState } from 'react'
import type { NowPlayingResponse } from '@/lib/station-types'

export type NowPlayingSnapshot = {
  data: NowPlayingResponse | null
  error: string | null
  lastFetch: number // Date.now() of the last successful fetch
}

const INITIAL: NowPlayingSnapshot = { data: null, error: null, lastFetch: 0 }

let snapshot: NowPlayingSnapshot = INITIAL
const subscribers = new Set<(s: NowPlayingSnapshot) => void>()
let timer: ReturnType<typeof setInterval> | null = null
let activePollMs = 10000
let inFlight = false

function commit(patch: Partial<NowPlayingSnapshot>): void {
  snapshot = { ...snapshot, ...patch }
  subscribers.forEach((fn) => fn(snapshot))
}

async function fetchNowPlaying(): Promise<void> {
  if (inFlight) return
  inFlight = true
  try {
    const res = await fetch('/api/nowplaying', { cache: 'no-store' })

    if (!res.ok) {
      // The 503 body is a real payload, not an error page: it carries
      // mode:"offline", current:null and an offlineReason. It used to be
      // discarded here, so the reason was unreachable and every consumer fell
      // back on stale data. Commit it, and state plainly that it is stale.
      let reason = `HTTP ${res.status}`
      try {
        const body = (await res.json()) as Partial<NowPlayingResponse>
        if (body.offlineReason) reason = body.offlineReason
      } catch {
        /* not a JSON body; the status code is all we have */
      }
      commit({ data: null, error: `Off air — ${reason}`, lastFetch: Date.now() })
      return
    }

    const data = (await res.json()) as NowPlayingResponse
    commit({ data, error: null, lastFetch: Date.now() })
  } catch {
    // Network-level failure. data is cleared rather than kept, because a frozen
    // snapshot presented as current is how a dead station looks alive.
    commit({ data: null, error: 'Feed unavailable — retrying…', lastFetch: Date.now() })
  } finally {
    inFlight = false
  }
}

function startLoop(): void {
  if (timer) return
  void fetchNowPlaying()
  timer = setInterval(() => void fetchNowPlaying(), activePollMs)
}

function stopLoop(): void {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
}

function subscribe(fn: (s: NowPlayingSnapshot) => void, pollMs: number): () => void {
  const isFirst = subscribers.size === 0
  subscribers.add(fn)
  if (isFirst) {
    activePollMs = Math.max(2000, pollMs)
    startLoop()
  } else {
    fn(snapshot) // late subscriber syncs with the shared snapshot right away
  }
  return () => {
    subscribers.delete(fn)
    if (subscribers.size === 0) stopLoop()
  }
}

export function useNowPlaying(pollMs = 10000): NowPlayingSnapshot {
  const [local, setLocal] = useState<NowPlayingSnapshot>(INITIAL)

  useEffect(() => {
    return subscribe(setLocal, pollMs)
  }, [pollMs])

  return local
}
