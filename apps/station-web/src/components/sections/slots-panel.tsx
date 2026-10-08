'use client'

import { useCallback, useEffect, useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { toast } from 'sonner'
import { KeyRound, Radio, RefreshCw, Trash2, Copy, ShieldCheck } from 'lucide-react'

/**
 * Shows & slots (roadmap C5).
 *
 * The operator's roster of hosts and guest DJs: each show's next air window is
 * shown, and one button mints a credential bound to that window. The token is
 * displayed once — the station never stores it — and is pasted into the invite
 * link the holder opens on the guest door.
 *
 * The slot window and the "may go live" default are decided server-side
 * (`api/ops/slots`, `lib/slots`); this panel only presents them, so a change to
 * the slot rules does not have to be made twice.
 */

type SlotInfo = { notBefore: string; notAfter: string; label: string; open: boolean }

type RosterShow = {
  id: string
  name: string
  host: string
  kind: 'LIVE' | 'PLAYLIST'
  active: boolean
  slot: SlotInfo
}

type SessionRow = {
  id: string
  role: 'host' | 'guest'
  label: string
  canLive: boolean
  notBefore: string | null
  notAfter: string | null
  createdAt: string
  expiresAt: string
}

type Roster = {
  now: string
  shows: RosterShow[]
  sessions: SessionRow[]
  engine: { reachable: boolean; error: string | null }
}

type Minted = { token: string; label: string; role: string; slot: string }

const GUEST_URL = (process.env.NEXT_PUBLIC_GUEST_CONSOLE_URL ?? '').replace(/\/+$/, '')

function inviteLink(token: string): string | null {
  return GUEST_URL ? `${GUEST_URL}/#invite=${token}` : null
}

function fmtWhen(iso: string | null): string {
  if (!iso) return 'no bound'
  return new Date(iso).toLocaleString('en-US', {
    timeZone: 'America/New_York',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

export function SlotsPanel({ unlocked }: { unlocked: boolean }) {
  const [roster, setRoster] = useState<Roster | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [roleById, setRoleById] = useState<Record<string, 'host' | 'guest'>>({})
  const [canLiveById, setCanLiveById] = useState<Record<string, boolean>>({})
  const [busyId, setBusyId] = useState<string | null>(null)
  const [minted, setMinted] = useState<Minted | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/ops/slots', { cache: 'no-store' })
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null
        setError(body?.error ?? `Could not load the roster (${res.status}).`)
        return
      }
      setRoster((await res.json()) as Roster)
    } catch {
      setError('Could not reach the station app.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (unlocked) void load()
  }, [unlocked, load])

  async function mint(show: RosterShow) {
    if (busyId) return
    setBusyId(show.id)
    setMinted(null)
    try {
      const res = await fetch('/api/ops/slots', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          showId: show.id,
          role: roleById[show.id] ?? 'host',
          canLive: canLiveById[show.id] ?? show.kind === 'LIVE',
        }),
      })
      const body = (await res.json().catch(() => null)) as
        | { ok?: boolean; token?: string; session?: SessionRow; error?: string; slot?: { label?: string } }
        | null
      if (!res.ok || !body?.ok || !body.token || !body.session) {
        toast.error(body?.error ?? `Mint failed (${res.status}).`)
        return
      }
      setMinted({
        token: body.token,
        label: body.session.label,
        role: body.session.role,
        slot: body.slot?.label ?? show.slot.label,
      })
      toast.success(`Minted a ${body.session.role} credential for ${show.name}.`)
      void load()
    } catch {
      toast.error('Could not reach the station app.')
    } finally {
      setBusyId(null)
    }
  }

  async function revoke(session: SessionRow) {
    if (busyId) return
    setBusyId(session.id)
    try {
      const res = await fetch('/api/ops/slots/revoke', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: session.id }),
      })
      const body = (await res.json().catch(() => null)) as
        | { ok?: boolean; killedLive?: boolean; error?: string }
        | null
      if (!res.ok || !body?.ok) {
        toast.error(body?.error ?? `Revoke failed (${res.status}).`)
        return
      }
      toast.success(body.killedLive ? 'Revoked — and dropped them off the air.' : 'Revoked.')
      void load()
    } catch {
      toast.error('Could not reach the station app.')
    } finally {
      setBusyId(null)
    }
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <span className="rounded-md bg-primary/10 p-1.5 text-primary">
            <KeyRound className="h-4 w-4" aria-hidden />
          </span>
          Shows &amp; slots
          {roster && (
            <Badge variant="outline" className="ml-auto font-mono text-xs">
              {roster.sessions.length} live credential{roster.sessions.length === 1 ? '' : 's'}
            </Badge>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {!unlocked && (
          <p className="text-muted-foreground">Sign in to the control room to mint host and guest credentials.</p>
        )}

        {unlocked && loading && !roster && <Skeleton className="h-32 w-full" />}

        {unlocked && error && (
          <div className="flex items-center gap-3">
            <p className="text-muted-foreground">{error}</p>
            <Button variant="outline" size="sm" onClick={() => void load()}>
              <RefreshCw className="mr-1.5 h-4 w-4" aria-hidden /> Retry
            </Button>
          </div>
        )}

        {unlocked && roster && !roster.engine.reachable && (
          <p className="rounded-md border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-xs text-amber-200/90">
            The engine is unreachable, so credentials cannot be minted right now. {roster.engine.error ?? ''}
          </p>
        )}

        {unlocked && minted && (
          <div className="rounded-md border border-emerald-500/30 bg-emerald-500/5 p-3">
            <p className="flex items-center gap-1.5 text-xs font-semibold text-emerald-400">
              <ShieldCheck className="h-4 w-4" aria-hidden /> Credential minted — shown once
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              {minted.role} · {minted.label} · {minted.slot}
            </p>
            <div className="mt-2 flex items-center gap-2">
              <code className="min-w-0 flex-1 truncate rounded bg-muted/60 px-2 py-1 font-mono text-[11px]">
                {minted.token}
              </code>
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  void navigator.clipboard?.writeText(inviteLink(minted.token) ?? minted.token)
                  toast.success('Copied.')
                }}
              >
                <Copy className="mr-1.5 h-3.5 w-3.5" aria-hidden /> Copy
              </Button>
            </div>
            <p className="mt-1.5 text-[11px] text-muted-foreground">
              {inviteLink(minted.token)
                ? 'Copied as an invite link — send it to the holder. It works only inside the slot.'
                : 'Set NEXT_PUBLIC_GUEST_CONSOLE_URL to copy a ready invite link instead of the raw token.'}
            </p>
          </div>
        )}

        {unlocked && roster && (
          <div className="space-y-3">
            {roster.shows.length === 0 && (
              <p className="text-muted-foreground">No shows in the schedule yet.</p>
            )}
            {roster.shows.map((show) => {
              const role = roleById[show.id] ?? 'host'
              const canLive = canLiveById[show.id] ?? show.kind === 'LIVE'
              return (
                <div key={show.id} className="flex flex-wrap items-center gap-3 rounded-lg border bg-card/60 p-3">
                  <div className="min-w-0 flex-1">
                    <p className="flex items-center gap-2 font-medium">
                      <Radio className="h-3.5 w-3.5 text-primary" aria-hidden />
                      {show.name}
                      <span className="text-xs text-muted-foreground">· {show.host}</span>
                      {!show.active && <Badge variant="outline" className="text-[10px]">inactive</Badge>}
                    </p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {show.slot.label}
                      {show.slot.open && <span className="ml-2 text-emerald-400">on now</span>}
                    </p>
                  </div>
                  <label className="flex items-center gap-1.5 text-xs">
                    <span className="text-muted-foreground">role</span>
                    <select
                      className="h-8 rounded-md border bg-background px-2 text-xs"
                      value={role}
                      onChange={(e) => setRoleById((m) => ({ ...m, [show.id]: e.target.value as 'host' | 'guest' }))}
                    >
                      <option value="host">host</option>
                      <option value="guest">guest</option>
                    </select>
                  </label>
                  <label className="flex items-center gap-1.5 text-xs">
                    <input
                      type="checkbox"
                      checked={canLive}
                      onChange={(e) => setCanLiveById((m) => ({ ...m, [show.id]: e.target.checked }))}
                    />
                    may go live
                  </label>
                  <Button size="sm" disabled={busyId === show.id} onClick={() => void mint(show)}>
                    {busyId === show.id ? 'Minting…' : 'Mint for next slot'}
                  </Button>
                </div>
              )
            })}
          </div>
        )}

        {unlocked && roster && roster.sessions.length > 0 && (
          <div className="space-y-2 pt-1">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Live credentials</p>
            {roster.sessions.map((s) => (
              <div key={s.id} className="flex flex-wrap items-center gap-3 rounded-lg border bg-card/60 p-2.5 text-xs">
                <Badge variant="outline" className="font-mono">{s.role}</Badge>
                <span className="min-w-0 flex-1 truncate">{s.label}</span>
                <span className="text-muted-foreground">
                  {s.canLive ? 'live' : 'no live'} · {fmtWhen(s.notBefore)}–{fmtWhen(s.notAfter)}
                </span>
                <Button
                  size="sm"
                  variant="destructive"
                  className="h-7 px-2 text-xs"
                  disabled={busyId === s.id}
                  onClick={() => void revoke(s)}
                >
                  <Trash2 className="mr-1 h-3.5 w-3.5" aria-hidden /> Revoke
                </Button>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
