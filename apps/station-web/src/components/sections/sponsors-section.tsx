'use client'

import { useCallback, useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import {
  Megaphone,
  ScrollText,
  Check,
  RefreshCw,
  AlertCircle,
  Radio,
  Star,
  Music2,
} from 'lucide-react'
import { toast } from 'sonner'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { Progress } from '@/components/ui/progress'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import type { AdPlaysResponse, SponsorsResponse } from '@/lib/station-types'

const TIER_LABELS: Record<string, string> = {
  ON_AIR_SPOT: 'On-Air Spots',
  SHOW_SPONSOR: 'Show Sponsor',
  DAYPART_SPONSOR: 'Daypart Sponsor',
}

const STATUS_DOT: Record<string, string> = {
  ACTIVE: 'bg-emerald-400',
  PENDING: 'bg-amber-400',
  ENDED: 'bg-zinc-500',
}

function fmtRate(cents: number): string {
  return `$${Math.round(cents / 100).toLocaleString('en-US')}/mo`
}

function fmtTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  })
}

export function SponsorsSection() {
  const [data, setData] = useState<SponsorsResponse | null>(null)
  const [adplays, setAdplays] = useState<AdPlaysResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [syncing, setSyncing] = useState(false)

  const refresh = useCallback(async () => {
    try {
      setError(null)
      const [spRes, adRes] = await Promise.all([
        fetch('/api/sponsors', { cache: 'no-store' }),
        fetch('/api/adplays?limit=25', { cache: 'no-store' }),
      ])
      if (!spRes.ok) throw new Error(`Sponsor request failed (${spRes.status})`)
      setData((await spRes.json()) as SponsorsResponse)
      if (adRes.ok) setAdplays((await adRes.json()) as AdPlaysResponse)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load sponsor data')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  async function runAdSync() {
    setSyncing(true)
    try {
      const res = await fetch('/api/ops/ad-sync', { method: 'POST' })
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

  const packages = data?.packages ?? []
  const sponsors = (data?.sponsors ?? []).filter((s) => s.status === 'ACTIVE')

  return (
    <motion.section
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25, ease: 'easeOut' }}
      aria-labelledby="sponsors-heading"
      className="space-y-6"
    >
      {/* ---- Section header ---- */}
      <div className="flex items-start gap-3">
        <div className="rounded-lg bg-primary/10 p-2 text-primary">
          <Megaphone className="h-5 w-5" aria-hidden />
        </div>
        <div>
          <h2 id="sponsors-heading" className="text-xl font-bold tracking-tight">
            Sponsor the Wave
          </h2>
          <p className="text-sm text-muted-foreground">
            Underwrite independent Carolina hip-hop — every spot logged, every dollar auditable.
          </p>
        </div>
      </div>

      {/* ---- Loading ---- */}
      {loading && (
        <div className="space-y-6">
          <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-56 w-full" />
            ))}
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
              aria-label="Retry loading sponsors"
            >
              <RefreshCw className="mr-2 h-4 w-4" aria-hidden /> Retry
            </Button>
          </CardContent>
        </Card>
      )}

      {!loading && !error && (
        <>
          {/* ---- Packages ---- */}
          <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
            {packages.map((pkg, i) => (
              <Card
                key={pkg.id}
                className={`relative flex flex-col ${i === 1 ? 'box-glow border-amber-500/40' : ''}`}
              >
                {i === 1 && (
                  <Badge className="absolute -top-2.5 left-1/2 -translate-x-1/2 border border-amber-500/40 bg-amber-500 text-[10px] font-bold text-amber-950">
                    <Star className="mr-1 h-3 w-3" aria-hidden /> MOST POPULAR
                  </Badge>
                )}
                <CardHeader className="pb-2">
                  <CardTitle className="text-base">{pkg.name}</CardTitle>
                  <p className="text-3xl font-extrabold text-primary">{pkg.price}</p>
                </CardHeader>
                <CardContent className="flex flex-1 flex-col gap-3">
                  <Badge
                    variant="outline"
                    className="w-fit border-border bg-card/60 text-xs text-muted-foreground"
                  >
                    <Radio className="mr-1.5 h-3 w-3 text-primary" aria-hidden />
                    {pkg.spotsPerDay} spots/day
                  </Badge>
                  <ul className="flex-1 space-y-2 text-sm text-muted-foreground">
                    {pkg.perks.map((perk) => (
                      <li key={perk} className="flex items-start gap-2">
                        <Check className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" aria-hidden />
                        {perk}
                      </li>
                    ))}
                  </ul>
                  <a
                    href={`mailto:studio@ncsound.fm?subject=${encodeURIComponent(`Sponsorship: ${pkg.name}`)}`}
                    className="inline-flex h-9 items-center justify-center whitespace-nowrap rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    aria-label={`Book the ${pkg.name} package`}
                  >
                    Book this package
                  </a>
                </CardContent>
              </Card>
            ))}
          </div>

          {/* ---- Active sponsors ---- */}
          <div>
            <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              Active sponsors
            </h3>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
              {sponsors.length === 0 && (
                <Card className="border-dashed md:col-span-3">
                  <CardContent className="p-6 text-center text-sm text-muted-foreground">
                    No active sponsors yet — be the first on the wave.
                  </CardContent>
                </Card>
              )}
              {sponsors.map((s) => (
                <Card key={s.id} className="gap-3">
                  <CardHeader className="pb-0">
                    <div className="flex items-start justify-between gap-2">
                      <CardTitle className="text-base leading-tight">{s.name}</CardTitle>
                      <span
                        className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${STATUS_DOT[s.status] ?? 'bg-zinc-500'}`}
                        title={s.status}
                        aria-label={`Sponsor status: ${s.status}`}
                      />
                    </div>
                    <div className="flex flex-wrap items-center gap-2 pt-1 text-xs text-muted-foreground">
                      <Badge
                        variant="outline"
                        className="border-amber-500/30 bg-amber-500/10 text-amber-400"
                      >
                        {TIER_LABELS[s.tier] ?? s.tier}
                      </Badge>
                      <span className="font-semibold text-foreground">{fmtRate(s.monthlyRate)}</span>
                      <span>· since {new Date(s.startAt).getFullYear()}</span>
                    </div>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    {s.campaigns.length === 0 && (
                      <p className="text-xs text-muted-foreground">No campaigns yet.</p>
                    )}
                    {s.campaigns.map((c) => (
                      <div
                        key={c.id}
                        className="rounded-lg border border-border bg-card/40 p-3"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <p className="truncate text-xs font-semibold" title={c.name}>
                            <Music2 className="mr-1 inline h-3 w-3 text-primary" aria-hidden />
                            {c.name}
                          </p>
                          {!c.active && (
                            <Badge
                              variant="outline"
                              className="border-border text-[10px] text-muted-foreground"
                            >
                              paused
                            </Badge>
                          )}
                        </div>
                        <p className="mt-0.5 truncate font-mono text-[10px] text-muted-foreground" title={c.creativeName}>
                          {c.creativeName}
                        </p>
                        <Progress
                          value={Math.min(100, (c.playsToday / Math.max(1, c.spotsPerDay)) * 100)}
                          className="mt-2 h-1.5"
                          aria-label={`${c.playsToday} of ${c.spotsPerDay} spots played today`}
                        />
                        <p className="mt-1.5 text-[10px] text-muted-foreground">
                          {c.playsToday}/{c.spotsPerDay} spots today · {c.playsTotal} total plays
                        </p>
                      </div>
                    ))}
                  </CardContent>
                </Card>
              ))}
            </div>
          </div>

          {/* ---- Proof-of-play ledger ---- */}
          <Card>
            <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3 pb-3">
              <CardTitle className="flex items-center gap-2 text-base">
                <div className="rounded-md bg-primary/10 p-1.5 text-primary">
                  <ScrollText className="h-4 w-4" aria-hidden />
                </div>
                Proof-of-Play Ledger
              </CardTitle>
              <div className="flex flex-wrap items-center gap-2">
                <Badge
                  variant="outline"
                  className="border-emerald-500/30 bg-emerald-500/10 font-mono text-xs text-emerald-400"
                >
                  {adplays?.last7Days ?? 0} plays · last 7 days
                </Badge>
                <Button onClick={() => void runAdSync()} disabled={syncing} className="h-9">
                  <RefreshCw className={`mr-2 h-4 w-4 ${syncing ? 'animate-spin' : ''}`} aria-hidden />
                  {syncing ? 'Syncing…' : 'Run nightly sync now'}
                </Button>
              </div>
            </CardHeader>
            <CardContent>
              <div className="max-h-96 overflow-y-auto scrollbar-thin rounded-lg border">
                <Table>
                  <TableHeader className="sticky top-0 z-10 bg-card/95 backdrop-blur-sm">
                    <TableRow>
                      <TableHead className="text-xs">Time</TableHead>
                      <TableHead className="text-xs">Campaign</TableHead>
                      <TableHead className="hidden text-xs sm:table-cell">Sponsor</TableHead>
                      <TableHead className="hidden text-xs md:table-cell">Creative</TableHead>
                      <TableHead className="text-right text-xs">Source</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(adplays?.plays ?? []).length === 0 && (
                      <TableRow>
                        <TableCell
                          colSpan={5}
                          className="h-24 text-center text-sm text-muted-foreground"
                        >
                          No ad plays logged yet — run the nightly sync.
                        </TableCell>
                      </TableRow>
                    )}
                    {(adplays?.plays ?? []).map((p) => (
                      <TableRow key={p.id} className="text-xs sm:text-sm">
                        <TableCell className="whitespace-nowrap font-mono text-xs">
                          {fmtTime(p.playedAt)}
                        </TableCell>
                        <TableCell className="max-w-[220px] truncate font-medium" title={p.campaignName}>
                          {p.campaignName}
                        </TableCell>
                        <TableCell className="hidden max-w-[180px] truncate text-muted-foreground sm:table-cell" title={p.sponsorName}>
                          {p.sponsorName}
                        </TableCell>
                        <TableCell className="hidden max-w-[200px] truncate font-mono text-[10px] text-muted-foreground md:table-cell" title={p.campaignName}>
                          {p.campaignName}
                        </TableCell>
                        <TableCell className="text-right">
                          <Badge
                            variant="outline"
                            className="font-mono text-[9px] text-muted-foreground"
                          >
                            azuracast-history
                          </Badge>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </CardContent>
          </Card>
        </>
      )}
    </motion.section>
  )
}
