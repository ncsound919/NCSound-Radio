'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { motion } from 'framer-motion'
import {
  ShieldCheck,
  Lock,
  Search,
  AlertCircle,
  RefreshCw,
  MoreHorizontal,
} from 'lucide-react'
import { toast } from 'sonner'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import type { RightsDTO, StatsResponse } from '@/lib/station-types'

type RightsStatus = RightsDTO['status']

/** status → badge classes (emerald=ok, amber=waiting, red=blocked) */
const STATUS_CLASSES: Record<string, string> = {
  CLEARED: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30',
  APPROVED: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30',
  PENDING: 'bg-amber-500/15 text-amber-400 border-amber-500/30',
  IN_REVIEW: 'bg-amber-500/15 text-amber-400 border-amber-500/30',
  BLOCKED: 'bg-red-500/15 text-red-400 border-red-500/30',
  DECLINED: 'bg-red-500/15 text-red-400 border-red-500/30',
  UNCLEARED: 'bg-red-500/15 text-red-400 border-red-500/30',
}

function statusBadge(status: string) {
  return (
    <Badge
      variant="outline"
      className={`whitespace-nowrap ${STATUS_CLASSES[status] ?? 'border-border text-muted-foreground'}`}
    >
      {status}
    </Badge>
  )
}

function ExplicitE() {
  return (
    <span
      title="Explicit"
      aria-label="Explicit"
      className="inline-flex h-4 w-4 items-center justify-center rounded-[3px] bg-red-500/90 text-[9px] font-black leading-none text-white"
    >
      E
    </span>
  )
}

function fmtDate(iso: string | null): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })
}

const STATUSES: RightsStatus[] = ['PENDING', 'IN_REVIEW', 'CLEARED', 'BLOCKED']

export function RightsSection() {
  const [rights, setRights] = useState<RightsDTO[] | null>(null)
  const [stats, setStats] = useState<StatsResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState<string>('ALL')
  const [updatingId, setUpdatingId] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      setError(null)
      const [rightsRes, statsRes] = await Promise.all([
        fetch('/api/rights', { cache: 'no-store' }),
        fetch('/api/stats', { cache: 'no-store' }),
      ])
      if (!rightsRes.ok) throw new Error(`Rights request failed (${rightsRes.status})`)
      const rightsJson = (await rightsRes.json()) as { rights: RightsDTO[] }
      setRights(rightsJson.rights)
      if (statsRes.ok) {
        setStats((await statsRes.json()) as StatsResponse)
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load the rights ledger')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  async function updateStatus(id: string, status: RightsStatus) {
    setUpdatingId(id)
    try {
      const res = await fetch(`/api/rights/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
      })
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null
        toast.error(body?.error ?? `Could not update ${id} (${res.status})`)
        return
      }
      toast.success(`${id} → ${status}`)
      await refresh()
    } catch {
      toast.error('Network error — rights record not updated.')
    } finally {
      setUpdatingId(null)
    }
  }

  const filtered = useMemo(() => {
    const rows = rights ?? []
    const q = query.trim().toLowerCase()
    return rows.filter((r) => {
      if (statusFilter !== 'ALL' && r.status !== statusFilter) return false
      if (!q) return true
      return (
        r.trackTitle.toLowerCase().includes(q) ||
        r.artistName.toLowerCase().includes(q) ||
        r.id.toLowerCase().includes(q)
      )
    })
  }, [rights, query, statusFilter])

  const lib = stats?.library

  return (
    <motion.section
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25, ease: 'easeOut' }}
      aria-labelledby="rights-heading"
      className="space-y-6"
    >
      {/* ---- Section header ---- */}
      <div className="flex items-start gap-3">
        <div className="rounded-lg bg-primary/10 p-2 text-primary">
          <ShieldCheck className="h-5 w-5" aria-hidden />
        </div>
        <div>
          <h2 id="rights-heading" className="text-xl font-bold tracking-tight">
            The Rights Ledger
          </h2>
          <p className="text-sm text-muted-foreground">
            The public audit trail — no CLEARED record, no broadcast.
          </p>
        </div>
      </div>

      {/* ---- Gate banner ---- */}
      <div className="flex items-center gap-3 rounded-xl border border-red-500/30 bg-red-500/10 p-4">
        <Lock className="h-5 w-5 shrink-0 text-red-400" aria-hidden />
        <p className="text-sm">
          <span className="font-bold text-red-400">RIGHTS GATE: ENFORCED</span>{' '}
          <span className="text-muted-foreground">
            — Tracks reach AutoDJ only with status CLEARED. Blocking a record instantly pulls it
            from rotation eligibility.
          </span>
        </p>
      </div>

      {/* ---- Stats chips ---- */}
      {lib && (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <Badge variant="outline" className="border-emerald-500/30 bg-emerald-500/15 text-emerald-400">
            {lib.cleared} cleared
          </Badge>
          <Badge variant="outline" className="border-amber-500/30 bg-amber-500/15 text-amber-400">
            {lib.pendingRights} in review · pending
          </Badge>
          <Badge variant="outline" className="border-red-500/30 bg-red-500/15 text-red-400">
            {lib.blocked} blocked
          </Badge>
          <span className="text-muted-foreground">
            {lib.tracks} library tracks · {lib.totalHours}h of audio
          </span>
        </div>
      )}

      {/* ---- Loading ---- */}
      {loading && (
        <div className="space-y-3">
          <div className="flex gap-3">
            <Skeleton className="h-10 w-full max-w-sm" />
            <Skeleton className="h-10 w-44" />
          </div>
          <Skeleton className="h-72 w-full" />
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
              aria-label="Retry loading rights ledger"
            >
              <RefreshCw className="mr-2 h-4 w-4" aria-hidden /> Retry
            </Button>
          </CardContent>
        </Card>
      )}

      {/* ---- Ledger ---- */}
      {!loading && !error && (
        <div className="space-y-3">
          {/* controls */}
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
            <div className="relative w-full sm:max-w-sm">
              <Search
                className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
                aria-hidden
              />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search track, artist, or R-ID…"
                className="h-10 pl-9"
                aria-label="Search rights records"
              />
            </div>
            <Select value={statusFilter} onValueChange={setStatusFilter}>
              <SelectTrigger className="h-10 w-full sm:w-44" aria-label="Filter by status">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">All statuses</SelectItem>
                {STATUSES.map((s) => (
                  <SelectItem key={s} value={s}>
                    {s}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <span className="text-xs text-muted-foreground sm:ml-auto">
              {filtered.length} of {rights?.length ?? 0} records
            </span>
          </div>

          {/* table */}
          <div className="max-h-96 overflow-y-auto scrollbar-thin rounded-lg border">
            <Table>
              <TableHeader className="sticky top-0 z-10 bg-card/95 backdrop-blur-sm">
                <TableRow>
                  <TableHead className="text-xs">Rights ID</TableHead>
                  <TableHead className="text-xs">Track</TableHead>
                  <TableHead className="text-xs">Artist</TableHead>
                  <TableHead className="hidden text-xs md:table-cell">Owner</TableHead>
                  <TableHead className="text-xs">Sample</TableHead>
                  <TableHead className="text-xs">Explicit</TableHead>
                  <TableHead className="text-xs">Status</TableHead>
                  <TableHead className="hidden text-xs sm:table-cell">Cleared</TableHead>
                  <TableHead className="hidden text-xs lg:table-cell">Proof</TableHead>
                  <TableHead className="text-right text-xs">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={10} className="h-24 text-center text-sm text-muted-foreground">
                      No rights records match this filter.
                    </TableCell>
                  </TableRow>
                )}
                {filtered.map((r) => (
                  <TableRow key={r.id} className="text-xs sm:text-sm">
                    <TableCell className="font-mono text-xs text-primary">{r.id}</TableCell>
                    <TableCell className="max-w-[180px] truncate font-medium" title={r.trackTitle}>
                      {r.trackTitle}
                    </TableCell>
                    <TableCell className="max-w-[140px] truncate" title={r.artistName}>
                      {r.artistName}
                    </TableCell>
                    <TableCell className="hidden max-w-[160px] truncate text-muted-foreground md:table-cell" title={r.owner}>
                      {r.owner}
                    </TableCell>
                    <TableCell>{statusBadge(r.sampleStatus)}</TableCell>
                    <TableCell>{r.explicitFlag ? <ExplicitE /> : <span>—</span>}</TableCell>
                    <TableCell>{statusBadge(r.status)}</TableCell>
                    <TableCell className="hidden whitespace-nowrap font-mono text-[11px] text-muted-foreground sm:table-cell">
                      {fmtDate(r.clearedAt)}
                    </TableCell>
                    <TableCell className="hidden max-w-[160px] truncate text-[10px] text-muted-foreground lg:table-cell" title={r.ownerProof ?? ''}>
                      {r.ownerProof ?? '—'}
                    </TableCell>
                    <TableCell className="text-right">
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            variant="outline"
                            size="sm"
                            className="h-8 gap-1 px-2 text-xs"
                            disabled={updatingId === r.id}
                            aria-label={`Update status for ${r.id}`}
                          >
                            <MoreHorizontal className="h-3.5 w-3.5" aria-hidden />
                            Update
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuLabel className="text-xs">
                            Set gate status
                          </DropdownMenuLabel>
                          <DropdownMenuSeparator />
                          {STATUSES.map((s) => (
                            <DropdownMenuItem
                              key={s}
                              disabled={s === r.status || updatingId === r.id}
                              onClick={() => void updateStatus(r.id, s)}
                            >
                              {statusBadge(s)}
                            </DropdownMenuItem>
                          ))}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </div>
      )}
    </motion.section>
  )
}
