'use client'

import { useCallback, useEffect, useState } from 'react'

/**
 * The control-room session.
 *
 * Replaces `use-ops-pin`, which kept the PIN in `sessionStorage` and resent it
 * as an `x-ops-pin` header on every mutating call. That had two problems: the
 * secret was readable by any script on the page, and it travelled on every
 * request where it could be captured in a proxy log.
 *
 * Now the browser holds nothing. The cookie is HttpOnly and SameSite=Strict, so
 * the client can see *that* it is signed in but can never read the credential.
 *
 * `configured: false` means no admin exists yet. That is a setup state, not an
 * auth failure, and the UI says which script to run rather than asking for a
 * password that cannot work.
 */
export type AdminSessionState = {
  loading: boolean
  configured: boolean
  authenticated: boolean
  user: string | null
}

export function useAdminSession() {
  const [state, setState] = useState<AdminSessionState>({
    loading: true,
    configured: false,
    authenticated: false,
    user: null,
  })

  const refresh = useCallback(async () => {
    try {
      const res = await fetch('/api/auth/session', { cache: 'no-store' })
      if (!res.ok) throw new Error(String(res.status))
      const body = (await res.json()) as {
        configured?: boolean
        authenticated?: boolean
        user?: string | null
      }
      setState({
        loading: false,
        configured: body.configured === true,
        authenticated: body.authenticated === true,
        user: body.user ?? null,
      })
    } catch {
      setState({ loading: false, configured: false, authenticated: false, user: null })
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const signIn = useCallback(
    async (username: string, password: string): Promise<{ ok: boolean; error?: string }> => {
      try {
        const res = await fetch('/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username, password }),
        })
        const body = (await res.json().catch(() => null)) as { error?: string } | null
        if (!res.ok) {
          return { ok: false, error: body?.error ?? `Sign-in failed (${res.status})` }
        }
        await refresh()
        return { ok: true }
      } catch {
        return { ok: false, error: 'Could not reach the station app.' }
      }
    },
    [refresh],
  )

  const signOut = useCallback(async () => {
    try {
      await fetch('/api/auth/logout', { method: 'POST' })
    } finally {
      // Local state is cleared regardless: a failed request must never leave
      // the UI showing a signed-in control room.
      await refresh()
    }
  }, [refresh])

  return { ...state, refresh, signIn, signOut }
}
