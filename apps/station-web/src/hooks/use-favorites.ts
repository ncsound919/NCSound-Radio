'use client'

/**
 * Listener favorites — "My Waves".
 *
 * Local-only (localStorage) heart list: the station never needs an account to
 * remember which spins a listener loved. Each entry snapshots the track
 * metadata so the strip can render without a network round-trip. Stored via a
 * tiny external store so every consumer re-renders together and cross-tab
 * storage events stay in sync.
 */

import { useSyncExternalStore } from 'react'

export type FavoriteTrack = {
  id: string
  title: string
  artist: string
  rightsId: string
  savedAt: number
}

const KEY = 'wavc-favorites-v1'
const MAX = 30

function read(): FavoriteTrack[] {
  if (typeof window === 'undefined') return []
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (x): x is FavoriteTrack =>
        typeof x === 'object' &&
        x !== null &&
        typeof (x as FavoriteTrack).id === 'string' &&
        typeof (x as FavoriteTrack).title === 'string',
    )
  } catch {
    return []
  }
}

let snapshot: FavoriteTrack[] = []
let hydrated = false

const listeners = new Set<() => void>()

function persist(next: FavoriteTrack[]): void {
  snapshot = next
  hydrated = true
  try {
    localStorage.setItem(KEY, JSON.stringify(next.slice(0, MAX)))
  } catch {
    /* private mode — in-memory still works */
  }
  listeners.forEach((l) => l())
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  if (!hydrated && typeof window !== 'undefined') {
    hydrated = true
    snapshot = read()
  }
  return () => listeners.delete(listener)
}

function getSnapshot(): FavoriteTrack[] {
  if (!hydrated && typeof window !== 'undefined') {
    hydrated = true
    snapshot = read()
  }
  return snapshot
}

// stable identity — useSyncExternalStore requires getServerSnapshot to be
// cached (a fresh [] each call trips React's infinite-loop guard)
const EMPTY: FavoriteTrack[] = []

function getServerSnapshot(): FavoriteTrack[] {
  return EMPTY
}

if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key === KEY) {
      snapshot = read()
      listeners.forEach((l) => l())
    }
  })
}

export function useFavorites() {
  const favorites = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
  const ids = new Set(favorites.map((f) => f.id))

  const toggle = (track: Omit<FavoriteTrack, 'savedAt'>): boolean => {
    const current = getSnapshot()
    const exists = current.some((f) => f.id === track.id)
    if (exists) {
      persist(current.filter((f) => f.id !== track.id))
      return false
    }
    const next = [{ ...track, savedAt: Date.now() }, ...current].slice(0, MAX)
    persist(next)
    return true
  }

  const remove = (id: string): void => {
    persist(getSnapshot().filter((f) => f.id !== id))
  }

  const isFavorite = (id: string): boolean => ids.has(id)

  return { favorites, ids, toggle, remove, isFavorite }
}
