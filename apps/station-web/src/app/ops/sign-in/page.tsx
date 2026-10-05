'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Lock } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

/**
 * GET /ops/sign-in — the way in.
 *
 * Separate from the control room itself so that "you are not signed in" is a
 * distinct page rather than an empty dashboard. The old design put a PIN box
 * in the middle of the ops screen, so a locked station and a station with
 * nothing to review looked the same.
 */
export default function OpsSignInPage() {
  const router = useRouter()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      })
      const body = (await res.json().catch(() => null)) as { error?: string } | null
      if (!res.ok) {
        setError(body?.error ?? `Sign-in failed (${res.status})`)
        return
      }
      // A full refresh so the server component re-checks the cookie before
      // rendering anything internal.
      router.replace('/ops')
      router.refresh()
    } catch {
      setError('Could not reach the station app.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-sm rounded-xl border border-border bg-card/60 p-8 text-center shadow-xl">
        <span className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full border border-primary/30 bg-primary/10 text-primary">
          <Lock className="h-5 w-5" aria-hidden />
        </span>
        <h1 className="text-lg font-bold tracking-tight">Control room</h1>
        <p className="mt-1 text-xs text-muted-foreground">
          Internal only. Listener features do not live here.
        </p>

        <form className="mt-6 flex flex-col gap-3" onSubmit={submit}>
          <Input
            type="text"
            autoComplete="username"
            autoFocus
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="Username"
            aria-label="Admin username"
            className="text-center font-mono"
          />
          <Input
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Password"
            aria-label="Password"
            className="text-center font-mono"
          />
          <Button type="submit" disabled={busy || !username.trim() || !password}>
            {busy ? 'Checking…' : 'Sign in'}
          </Button>
        </form>

        {error && (
          <p className="mt-3 text-xs text-destructive" role="alert">
            {error}
          </p>
        )}

        <p className="mt-6 text-[11px] leading-relaxed text-muted-foreground/80">
          No account yet? Create one once with{' '}
          <code className="font-mono">scripts/set-admin-password.ts</code>.
        </p>
      </div>
    </main>
  )
}
