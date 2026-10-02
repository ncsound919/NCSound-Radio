'use client'

/**
 * useJson — tiny one-shot JSON fetcher with manual retry and a 12 s timeout.
 * `extraKey` lets a consumer force a refetch when a secondary signal changes
 * (e.g. refetch history when the current spin id changes).
 */

import { useCallback, useEffect, useState } from 'react'

export function useJson<T>(url: string, extraKey?: string) {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState(false)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let cancelled = false
    const ctrl = new AbortController()
    const timeout = setTimeout(() => ctrl.abort(), 12000)
    fetch(url, { cache: 'no-store', signal: ctrl.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        return (await res.json()) as T
      })
      .then((json) => {
        if (!cancelled) {
          setData(json)
          setError(false)
        }
      })
      .catch(() => {
        if (!cancelled) setError(true)
      })
      .finally(() => clearTimeout(timeout))
    return () => {
      cancelled = true
      ctrl.abort()
      clearTimeout(timeout)
    }
  }, [url, extraKey, attempt])

  const retry = useCallback(() => setAttempt((a) => a + 1), [])
  return { data, error, retry }
}
