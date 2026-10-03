'use client'

import { useCallback, useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import {
  SlidersHorizontal,
  Gauge,
  Activity,
  ClipboardCheck,
  Mail,
  FileAudio,
  FileCheck,
  CheckCircle2,
  XCircle,
  RefreshCw,
  AlertCircle,
  Lock,
  LockOpen,
  Clock3,
  KeyRound,
} from 'lucide-react'
import { toast } from 'sonner'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useOpsPin } from '@/hooks/use-ops-pin'
import { cn } from '@/lib/utils'
import type { StatsResponse, SubmissionDTO } from '@/lib/station-types'

const QUEUE_STATUSES = ['PENDING', 'IN_REVIEW', 'APPROVED', 'DECLINED'] as const
type QueueStatus = (typeof QUEUE_STATUSES)[number]

const STATUS_TAB_CLASSES: Record<QueueStatus, string> = {
  PENDING: 'data-[state=active]:text-amber-400',
  IN_REVIEW: 'data-[state=active]:text-amber-400',
  APPROVED: 'data-[state=active]:text-emerald-400',
  DECLINED: 'data-[state=active]:text-red-400',
}

function fmtSize(bytes: number | null): string {
  if (bytes == null) return 'unknown size'
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`
  return `${Math.max(1, Math.round(bytes / 1000))} KB`
}

function fmtDate(iso: string | null): string {
  if (!iso) return 'no date'
  return new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })
}

function ExplicitE() {
  return (
    <span
      title="Explicit lyrics"
      aria-label="Explicit lyrics"
      className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-[3px] bg-red-500/90 text-[9px] font-black leading-none text-white"
    >
      E
    </span>
  )
}

/**
 * Format a measurement that may not have been taken.
 *
 * String(null) renders the literal word "null" in a stat tile, and Math.round
 * (null) renders a confident 0. Both read as data. A dash reads as absence,
 * which is what it is when the engine is unreachable.
 */
function fmtCount(n: number | null | undefined): string {
  return n == null ? '—' : n.toLocaleString('en-US')
}

function fmtDuration(sec: number | null | undefined): string {
  if (sec == null || sec <= 0) return '—'
  const s = Math.floor(sec)
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  if (d > 0) return `${d}d ${h}h`
  if (h > 0) return `${h}h ${m}m`
  return `${m}m ${s % 60}s`
}

/**
 * One health row. Green means measured-healthy, red means measured-unhealthy,
 * and neither is shown for a value nobody has measured.
 */
function StatusRow({
  label,
  ok,
  okText,
  badText,
}: {
  label: string
  ok: boolean
  okText: string
  badText: string
}) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-muted-foreground">{label}</span>
      <span
        className={`inline-flex items-center gap-1.5 font-semibold ${
          ok ? 'text-emerald-400' : 'text-amber-400'
        }`}
      >
        <span
          className={`h-1.5 w-1.5 rounded-full ${ok ? 'bg-emerald-400' : 'bg-amber-400'}`}
          aria-hidden
        />
        {ok ? okText : badText}
      </span>
    </div>
  )
}

export function OpsSection() {
  const [stats, setStats] = useState<StatsResponse | null>(null)
  const [submissions, setSubmissions] = useState<SubmissionDTO[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [tab, setTab] = useState<QueueStatus>('PENDING')
  const [notesMap, setNotesMap] = useState<Record<string, string>>({})
  const [busyId, setBusyId] = useState<string | null>(null)
  const [syncing, setSyncing] = useState(false)
  const [checks, setChecks] = useState<boolean[]>([])
  const { unlocked, unlock, lock, authHeaders } = useOpsPin()
  const [pinInput, setPinInput] = useState('')
  const [pinBusy, setPinBusy] = useState(false)

  async function handleUnlock() {
    if (!pinInput.trim() || pinBusy) return
    setPinBusy(true)
    const ok = await unlock(pinInput.trim())
    setPinBusy(false)
    if (ok) {
      setPinInput('')
      toast.success('Control room unlocked — the desk is yours.')
    } else {
      toast.error('Wrong PIN — that key does not open this door (demo: 0913).')
    }
  }

  const refresh = useCallback(async () => {
    try {
      setError(null)
      const [statsRes, subRes] = await Promise.all([
        fetch('/api/stats', { cache: 'no-store' }),
        fetch('/api/submissions', { cache: 'no-store' }),
      ])
      if (!statsRes.ok) throw new Error(`Stats request failed (${statsRes.status})`)
      setStats((await statsRes.json()) as StatsResponse)
      if (subRes.ok) {
        const json = (await subRes.json()) as { submissions: SubmissionDTO[] }
        setSubmissions(json.submissions)
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load ops data')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // ---- Pre-launch checklist: read localStorage on mount ----
  useEffect(() => {
    try {
      const raw = localStorage.getItem('ncsound-prelaunch')
      if (raw) {
        const parsed: unknown = JSON.parse(raw)
        if (Array.isArray(parsed)) {
          setChecks(parsed.map((v) => v === true))
        }
      }
    } catch {
      /* corrupted storage — start fresh */
    }
  }, [])

  // Align checklist length with stats.checklist once stats arrive
  useEffect(() => {
    if (!stats) return
    setChecks((prev) => stats.checklist.map((_, i) => prev[i] ?? false))
  }, [stats])

  function toggleCheck(idx: number) {
    setChecks((prev) => {
      const next = [...prev]
      next[idx] = !next[idx]
      try {
        localStorage.setItem('ncsound-prelaunch', JSON.stringify(next))
      } catch {
        /* storage unavailable — keep in-memory only */
      }
      return next
    })
  }

  async function review(s: SubmissionDTO, status: Extract<QueueStatus, 'APPROVED' | 'DECLINED' | 'IN_REVIEW'>) {
    setBusyId(s.id)
    try {
      const res = await fetch(`/api/submissions/${encodeURIComponent(s.id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ status, reviewNotes: notesMap[s.id] ?? undefined }),
      })
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null
        toast.error(body?.error ?? `Could not update submission (${res.status})`)
        return
      }
      const json = (await res.json()) as { submission: SubmissionDTO }
      if (status === 'APPROVED') {
        toast.success(`Cleared — rights record ${json.submission.rightsId ?? 'issued'} issued`)
      } else if (status === 'DECLINED') {
        toast.error(`Declined — "${s.trackTitle}" blocked at the gate`)
      } else {
        toast.success(`"${s.trackTitle}" marked IN_REVIEW`)
      }
      await refresh()
    } catch {
      toast.error('Network error — review action not saved.')
    } finally {
      setBusyId(null)
    }
  }

  async function runAdSync() {
    if (!unlocked) {
      toast.info('Control room locked — unlock below with the station PIN (demo: 0913).')
      return
    }
    setSyncing(true)
    try {
      const res = await fetch('/api/ops/ad-sync', {
        method: 'POST',
        headers: authHeaders(),
      })
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null
        toast.error(body?.error ?? `Ad sync failed (${res.status})`)
        return
      }
      const json = (await res.json()) as { inserted: number }
      toast.success(`Synced ${json.inserted} new ad plays from AzuraCast history`)
      await refresh()
    } catch {
      toast.error('Network error — ad sync did not run.')
    } finally {
      setSyncing(false)
    }
  }

  const counts: Record<QueueStatus, number> = {
    PENDING: 0,
    IN_REVIEW: 0,
    APPROVED: 0,
    DECLINED: 0,
  }
  for (const s of submissions) {
    if (counts[s.status] !== undefined) counts[s.status]++
  }
  const queue = submissions.filter((s) => s.status === tab)
  const doneCount = checks.filter(Boolean).length
  const checklist = stats?.checklist ?? []

  return (
    <motion.section
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25, ease: 'easeOut' }}
      aria-labelledby="ops-heading"
      className="space-y-6"
    >
      {/* ---- Section header ---- */}
      <div className="flex flex-wrap items-start gap-3">
        <div className="rounded-lg bg-primary/10 p-2 text-primary">
          <SlidersHorizontal className="h-5 w-5" aria-hidden />
        </div>
        <div>
          <h2 id="ops-heading" className="text-xl font-bold tracking-tight">
            Station Ops
          </h2>
          <p className="text-sm text-muted-foreground">
            The control room — review submissions, watch the numbers, run the jobs.
          </p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <Badge
            variant="outline"
            className={cn(
              unlocked
                ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400'
                : 'border-amber-500/30 bg-amber-500/10 text-amber-400',
            )}
            aria-live="polite"
          >
            {unlocked ? (
              <>
                <LockOpen className="mr-1 h-3 w-3" aria-hidden /> Unlocked
              </>
            ) : (
              <>
                <Lock className="mr-1 h-3 w-3" aria-hidden /> Locked
              </>
            )}
          </Badge>
          {unlocked && (
            <Button
              variant="ghost"
              size="sm"
              className="h-8 text-xs text-muted-foreground hover:text-foreground"
              onClick={() => {
                lock()
                toast.info('Control room locked — mutating actions are disabled.')
              }}
            >
              <Lock className="mr-1.5 h-3.5 w-3.5" aria-hidden /> Lock
            </Button>
          )}
        </div>
      </div>

      {/* ---- Loading ---- */}
      {loading && (
        <div className="space-y-6">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-20 w-full" />
            ))}
          </div>
          <Skeleton className="h-80 w-full" />
        </div>
      )}

      {/* ---- Error ---- */}
      {!loading && error && (
        <Card className="border-destructive/40">
          <CardContent className="flex flex-col items-center gap-3 p-8 text-center">
            <AlertCircle className="h-8 w-8 text-red-400" aria-hidden />
            <p className="text-sm text-muted-foreground">{error}</p>
            <Button
              variant="outline"
              className="h-9 min-w-28"
              onClick={() => {
                setLoading(true)
                void refresh()
              }}
              aria-label="Retry loading ops data"
            >
              <RefreshCw className="mr-2 h-4 w-4" aria-hidden /> Retry
            </Button>
          </CardContent>
        </Card>
      )}

      {!loading && !error && stats && (
        <>
          {/* ---- Stat tiles ---- */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            {[
              { label: 'Listeners Now', value: fmtCount(stats.listeners.current) },
              { label: 'Peak 24h', value: fmtCount(stats.listeners.peak24h) },
              {
                label: 'Monthly MRR',
                value: `$${stats.sponsors.monthlyMRR.toLocaleString('en-US')}`,
              },
              { label: 'Cleared tracks', value: String(stats.library.cleared) },
              { label: 'Pending submissions', value: String(stats.submissions.pending) },
              { label: 'Ad plays 7d', value: String(stats.adplays.last7Days) },
            ].map((tile) => (
              <div key={tile.label} className="rounded-lg border bg-card/60 p-3">
                <p className="text-xl font-bold">{tile.value}</p>
                <p className="mt-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                  {tile.label}
                </p>
              </div>
            ))}
          </div>

          <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
            {/* ---- Review queue ---- */}
            <Card className="lg:col-span-2">
              <CardHeader className="pb-3">
                <CardTitle className="text-base">Submissions review queue</CardTitle>
                {unlocked && (
                  <Tabs
                    value={tab}
                    onValueChange={(v) => setTab(v as QueueStatus)}
                    className="mt-2"
                  >
                    <TabsList className="h-9 w-full flex-wrap justify-start">
                      {QUEUE_STATUSES.map((s) => (
                        <TabsTrigger
                          key={s}
                          value={s}
                          className={`h-8 px-2.5 text-xs ${STATUS_TAB_CLASSES[s]}`}
                        >
                          {s.replace('_', ' ')} ({counts[s]})
                        </TabsTrigger>
                      ))}
                    </TabsList>
                  </Tabs>
                )}
              </CardHeader>
              <CardContent>
                {!unlocked ? (
                  <div className="flex flex-col items-center gap-3 rounded-lg border border-amber-500/25 bg-gradient-to-b from-amber-500/10 to-transparent px-6 py-8 text-center">
                    <span className="flex h-12 w-12 items-center justify-center rounded-full border border-amber-500/40 bg-amber-500/15 text-amber-400 shadow-[0_0_30px_-8px_rgba(245,158,11,0.6)]">
                      <Lock className="h-5 w-5" aria-hidden />
                    </span>
                    <div>
                      <p className="text-sm font-bold">Control room locked</p>
                      <p className="mx-auto mt-1 max-w-sm text-xs text-muted-foreground">
                        Review actions, gate decisions and ad sync require the station PIN. The
                        dashboards stay public — the desk itself does not.
                      </p>
                    </div>
                    <form
                      className="flex w-full max-w-xs items-center gap-2"
                      onSubmit={(e) => {
                        e.preventDefault()
                        void handleUnlock()
                      }}
                    >
                      <Input
                        type="password"
                        inputMode="numeric"
                        autoComplete="off"
                        value={pinInput}
                        onChange={(e) => setPinInput(e.target.value)}
                        placeholder="Station PIN"
                        className="h-9 flex-1 text-center font-mono tracking-[0.4em]"
                        aria-label="Station PIN"
                        maxLength={16}
                      />
                      <Button
                        type="submit"
                        size="sm"
                        className="h-9"
                        disabled={pinBusy || !pinInput.trim()}
                      >
                        <KeyRound className="mr-1.5 h-4 w-4" aria-hidden /> Unlock
                      </Button>
                    </form>
                    <p className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground/70">
                      Demo PIN 0913 · clears when the tab closes
                    </p>
                  </div>
                ) : (
                <div className="max-h-96 space-y-3 overflow-y-auto scrollbar-thin pr-1">
                  {queue.length === 0 && (
                    <p className="py-8 text-center text-sm text-muted-foreground">
                      Nothing in {tab.replace('_', ' ')} — the queue is clean.
                    </p>
                  )}
                  {queue.map((s) => (
                    <div
                      key={s.id}
                      className="rounded-lg border border-border bg-card/40 p-4"
                      aria-label={`Submission from ${s.artistName}`}
                    >
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="text-sm font-bold">
                          &ldquo;{s.trackTitle}&rdquo; — {s.artistName}
                        </p>
                        <Badge
                          variant="outline"
                          className="border-amber-500/30 bg-amber-500/10 text-[10px] text-amber-400"
                        >
                          {s.genre}
                        </Badge>
                        {s.explicit && <ExplicitE />}
                        {(s.city || s.state) && (
                          <span className="text-xs text-muted-foreground">
                            {s.city ?? '—'}
                            {s.city && s.state ? ', ' : ''}
                            {s.state ?? ''}
                          </span>
                        )}
                      </div>
                      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                        <span className="inline-flex items-center gap-1">
                          <Mail className="h-3 w-3" aria-hidden /> {s.email}
                        </span>
                        {s.fileName && (
                          <span className="inline-flex items-center gap-1 font-mono text-[10px]">
                            <FileAudio className="h-3 w-3 text-primary" aria-hidden />
                            {s.fileName} · {fmtSize(s.fileSize)}
                          </span>
                        )}
                        <span className="inline-flex items-center gap-1">
                          <FileCheck className="h-3 w-3 text-emerald-400" aria-hidden />
                          {s.agreementVersion} · {fmtDate(s.agreementAcceptedAt)} · IP{' '}
                          {s.agreementIp ?? 'unknown'}
                        </span>
                      </div>
                      {s.notes && (
                        <p className="mt-2 border-l-2 border-border pl-2 text-xs italic text-muted-foreground">
                          {s.notes}
                        </p>
                      )}
                      <div className="mt-3 space-y-2">
                        <Textarea
                          value={notesMap[s.id] ?? ''}
                          onChange={(e) =>
                            setNotesMap((prev) => ({ ...prev, [s.id]: e.target.value }))
                          }
                          placeholder="Review notes — samples checked, owner verified, etc."
                          rows={2}
                          className="text-xs"
                          aria-label={`Review notes for ${s.trackTitle}`}
                        />
                        <div className="flex flex-wrap gap-2">
                          <Button
                            size="sm"
                            className="h-9 border border-emerald-500/30 bg-emerald-500/15 text-emerald-300 hover:bg-emerald-500/25"
                            disabled={busyId === s.id}
                            onClick={() => void review(s, 'APPROVED')}
                          >
                            <CheckCircle2 className="mr-1.5 h-4 w-4" aria-hidden />
                            Approve &amp; Clear
                          </Button>
                          <Button
                            size="sm"
                            className="h-9 border border-red-500/30 bg-red-500/15 text-red-400 hover:bg-red-500/25"
                            disabled={busyId === s.id}
                            onClick={() => void review(s, 'DECLINED')}
                          >
                            <XCircle className="mr-1.5 h-4 w-4" aria-hidden />
                            Decline
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-9"
                            disabled={busyId === s.id}
                            onClick={() => void review(s, 'IN_REVIEW')}
                          >
                            Mark In Review
                          </Button>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
                )}
              </CardContent>
            </Card>

            {/* ---- Right column stack ---- */}
            <div className="space-y-6">
              {/* Bandwidth projection */}
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="flex items-center gap-2 text-base">
                    <div className="rounded-md bg-primary/10 p-1.5 text-primary">
                      <Gauge className="h-4 w-4" aria-hidden />
                    </div>
                    Bandwidth projection
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-2">
                  <p className="text-sm text-muted-foreground">
                    <span className="font-semibold text-foreground">
                      {fmtCount(stats.listeners.current)}
                    </span>{' '}
                    listeners right now
                  </p>
                  <p className="rounded-md bg-muted/50 px-2 py-1.5 font-mono text-[10px] text-muted-foreground">
                    listeners × 0.058 GB/hr × 24h × 0.15 duty
                  </p>
                  <p className="text-3xl font-extrabold text-primary">
                    {stats.bandwidth.projectedGBDay ?? '—'}{' '}
                    <span className="text-base font-bold text-muted-foreground">GB/day</span>
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {stats.stream?.mounts?.[0]?.bitrateKbps ?? stats.bandwidth.kbps} kbps · ~
                    58 MB per listener-hour
                  </p>
                </CardContent>
              </Card>

              {/* System status */}
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="flex items-center gap-2 text-base">
                    <div className="rounded-md bg-primary/10 p-1.5 text-primary">
                      <Activity className="h-4 w-4" aria-hidden />
                    </div>
                    System status
                  </CardTitle>
                </CardHeader>
<CardContent className="space-y-2.5 text-xs">
                  {/* Every row below is read from the engine or Icecast. These
                      used to be literal emerald "OK" badges plus a fabricated
                      "99.9% 30d" SLA, which reported health the station had not
                      measured. A row whose value is unknown says so. */}
                  <StatusRow
                    label={
                      stats.stream?.mounts?.[0]?.mount
                        ? `Icecast mount ${stats.stream.mounts[0].mount} - ${stats.stream.mounts[0].bitrateKbps} kbps`
                        : 'Icecast stream'
                    }
                    ok={stats.stream?.reachable === true}
                    okText="ON AIR"
                    badText={stats.stream?.reachable ? 'OFF AIR' : 'unreachable'}
                  />
                  <StatusRow
                    label="AutoDJ rotation"
                    ok={stats.engine.reachable && stats.engine.state === 'playing'}
                    okText={stats.engine.state}
                    badText={stats.engine.reachable ? stats.engine.state : 'engine unreachable'}
                  />
                  <StatusRow
                    label="Crate loaded"
                    ok={stats.engine.crateSize > 0}
                    okText={`${stats.engine.crateSize} tracks`}
                    badText="empty"
                  />
                  <div className="flex items-center justify-between gap-2">
                    <span className="inline-flex items-center gap-1 text-muted-foreground">
                      <Lock className="h-3 w-3" aria-hidden /> Rights gate
                    </span>
                    <span className="inline-flex items-center gap-1.5 font-semibold text-amber-400">
                      <span className="h-1.5 w-1.5 rounded-full bg-amber-400" aria-hidden />{' '}
                      {stats.library.pendingRights > 0
                        ? `${stats.library.pendingRights} PENDING`
                        : 'CLEAR'}
                    </span>
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-muted-foreground">Engine uptime</span>
                    <span className="inline-flex items-center gap-1.5 font-semibold">
                      <Clock3 className="h-3 w-3" aria-hidden />{' '}
                      {fmtDuration(stats.engine.uptimeSec)}
                    </span>
                  </div>
                  {stats.engine.lastError && (
                    <div className="rounded-md bg-destructive/10 px-2 py-1.5 font-mono text-[10px] text-destructive">
                      {stats.engine.lastError}
                    </div>
                  )}
                  <Button
                    onClick={() => void runAdSync()}
                    disabled={syncing}
                    className="mt-1 h-9 w-full"
                    variant="outline"
                  >
                    <RefreshCw
                      className={`mr-2 h-4 w-4 ${syncing ? 'animate-spin' : ''}`}
                      aria-hidden
                    />
                    {syncing
                      ? 'Running ad sync…'
                      : unlocked
                        ? 'Run ad sync'
                        : 'Unlock to run the nightly sync'}
                  </Button>
                </CardContent>
              </Card>

              {/* Pre-launch checklist */}
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="flex items-center justify-between gap-2 text-base">
                    <span className="flex items-center gap-2">
                      <span className="rounded-md bg-primary/10 p-1.5 text-primary">
                        <ClipboardCheck className="h-4 w-4" aria-hidden />
                      </span>
                      Pre-launch checklist
                    </span>
                    <Badge
                      variant="outline"
                      className="border-border bg-card/60 font-mono text-xs"
                    >
                      {doneCount}/{checklist.length}
                    </Badge>
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="space-y-2.5">
                    {checklist.length === 0 && (
                      <p className="text-xs text-muted-foreground">Checklist unavailable.</p>
                    )}
                    {checklist.map((item, i) => (
                      <label
                        key={item}
                        className="flex cursor-pointer items-start gap-2.5 text-xs leading-snug"
                      >
                        <Checkbox
                          checked={checks[i] ?? false}
                          onCheckedChange={() => toggleCheck(i)}
                          className="mt-0.5"
                          aria-label={item}
                        />
                        <span className={checks[i] ? 'text-muted-foreground line-through' : ''}>
                          {item}
                        </span>
                      </label>
                    ))}
                  </div>
                </CardContent>
              </Card>
            </div>
          </div>
        </>
      )}
    </motion.section>
  )
}
