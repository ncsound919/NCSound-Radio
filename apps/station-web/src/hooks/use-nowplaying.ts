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
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = (await res.json()) as NowPlayingResponse
    commit({ data, error: null, lastFetch: Date.now() })
  } catch {
    commit({ error: 'Feed unavailable — retrying…' })
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
