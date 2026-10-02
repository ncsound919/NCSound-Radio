'use client'

/**
 * Ops control-room PIN session state.
 * The PIN is validated once against POST /api/ops/auth, then kept in
 * sessionStorage (per-tab) and sent as the `x-ops-pin` header on every
 * mutating ops request. Closing the tab locks the room again.
 *
 * Backed by useSyncExternalStore so the lock state is hydration-safe:
 * server + first render read the "locked" snapshot, then it self-corrects.
 */

import { useCallback, useSyncExternalStore } from 'react'

const STORAGE_KEY = 'wavc-ops-pin'
const CHANGE_EVENT = 'wavc-ops-pin-change'

function readPin(): string | null {
  try {
    return sessionStorage.getItem(STORAGE_KEY)
  } catch {
    return null
  }
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener(CHANGE_EVENT, onChange)
  window.addEventListener('storage', onChange)
  return () => {
    window.removeEventListener(CHANGE_EVENT, onChange)
    window.removeEventListener('storage', onChange)
  }
}

function writePin(pin: string | null): void {
  try {
    if (pin === null) sessionStorage.removeItem(STORAGE_KEY)
    else sessionStorage.setItem(STORAGE_KEY, pin)
  } catch {
    /* storage unavailable — in-memory only */
  }
  window.dispatchEvent(new Event(CHANGE_EVENT))
}

export function useOpsPin() {
  const pin = useSyncExternalStore(
    subscribe,
    readPin,
    () => null, // server snapshot: locked
  )

  const unlock = useCallback(async (candidate: string): Promise<boolean> => {
    try {
      const res = await fetch('/api/ops/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin: candidate }),
      })
      if (!res.ok) return false
      writePin(candidate)
      return true
    } catch {
      return false
    }
  }, [])

  const lock = useCallback(() => {
    writePin(null)
  }, [])

  /** Headers to merge into mutating ops fetches. */
  const authHeaders = useCallback(
    (): Record<string, string> => (pin ? { 'x-ops-pin': pin } : {}),
    [pin],
  )

  return { pin, unlocked: pin !== null, unlock, lock, authHeaders }
}
