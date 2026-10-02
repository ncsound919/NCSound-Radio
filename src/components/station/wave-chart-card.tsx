'use client'

/**
 * WaveChartCard — "The Wave Chart": the most-heard cleared tracks of the
 * trailing week, ranked straight from the PlayLog ledger with listener shout
 * heat folded in. Ranks are earned on air, not picked by hand — same audit
 * trail as the broadcast itself.
 */

import { motion } from 'framer-motion'
import { Flame, Mic, Radio, Trophy } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { ErrorLine } from '@/components/station/error-line'
import { useJson } from '@/hooks/use-json'
import type { ChartsResponse } from '@/lib/station-types'
import { cn } from '@/lib/utils'

function timeAgoShort(iso: string, serverMs: number): string {
  const min = Math.floor(Math.max(0, serverMs - new Date(iso).getTime()) / 60000)
  if (min < 1) return 'just now'
  if (min < 60) return `${min}m ago`
  const hrs = Math.floor(min / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.floor(hrs / 24)}d ago`
}

const RANK_STYLES: Record<number, string> = {
  1: 'border-primary/50 bg-gradient-to-br from-primary/25 via-primary/10 to-transparent text-primary',
  2: 'border-red-500/40 bg-gradient-to-br from-red-500/20 via-red-500/5 to-transparent text-red-300',
  3: 'border-amber-500/30 bg-gradient-to-br from-amber-500/15 to-transparent text-amber-400',
}

export function WaveChartCard() {
  const { data, error, retry } = useJson<ChartsResponse>('/api/charts')
  const rows = data?.week ?? []
  const maxSpins = rows.length ? Math.max(...rows.map((r) => r.spins7d), 1) : 1
  const serverMs = data ? new Date(data.serverTime).getTime() : Date.now()

  return (
    <Card className="hover-lift overflow-hidden border-border/60 bg-card/70">
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2 text-base font-semibold">
          <Trophy className="h-4 w-4 text-primary" aria-hidden="true" />
          The Wave Chart
          <span className="rounded-sm bg-primary/15 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-widest text-primary">
            This week
          </span>
        </CardTitle>
        <CardDescription>
          Most-heard tracks — ranked by the play-log ledger, shouts break ties
          {data ? ` · ${data.totalSpins7d.toLocaleString()} spins in 7d` : ''}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {error ? (
          <ErrorLine onRetry={retry} />
        ) : !data ? (
          <div className="space-y-2">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-14 w-full rounded-md" />
            ))}
          </div>
        ) : rows.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            Not enough spins logged yet — the chart builds itself after the first hour on air.
          </p>
        ) : (
          <ol className="max-h-96 space-y-1.5 overflow-y-auto pr-1 scrollbar-thin" aria-label="Weekly track chart">
            {rows.map((row, idx) => (
              <motion.li
                key={row.trackId}
                initial={{ opacity: 0, x: -12 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ duration: 0.3, delay: idx * 0.05, ease: 'easeOut' }}
                className={cn(
                  'group relative flex items-center gap-3 overflow-hidden rounded-md border px-2.5 py-2 transition-colors hover:border-border',
                  row.rank === 1
                    ? 'border-primary/30 bg-primary/[0.06] hover:border-primary/50'
                    : 'border-transparent hover:bg-accent/40',
                )}
              >
                {/* spins share bar — the row's "airtime" made visible */}
                <span
                  aria-hidden="true"
                  className="absolute inset-y-0 left-0 bg-gradient-to-r from-primary/15 via-primary/5 to-transparent transition-[width] duration-700 ease-out group-hover:from-primary/25"
                  style={{ width: `${Math.max(6, (row.spins7d / maxSpins) * 78)}%` }}
                />

                <span
                  aria-hidden="true"
                  className={cn(
                    'relative flex h-9 w-9 shrink-0 items-center justify-center rounded-md border font-mono text-sm font-bold',
                    RANK_STYLES[row.rank] ?? 'border-border bg-background/60 text-muted-foreground',
                  )}
                >
                  {row.rank}
                </span>

                <div className="relative min-w-0 flex-1">
                  <p className="flex items-center gap-2 truncate text-sm font-medium">
                    {row.title}
                    {row.explicit && (
                      <span
                        title="Explicit lyrics"
                        className="rounded border border-red-500/40 bg-red-500/10 px-1 text-[9px] font-bold leading-4 text-red-400"
                      >
                        E
                      </span>
                    )}
                    {row.onAirNow && (
                      <span className="inline-flex items-center gap-1 rounded-sm bg-red-500/15 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-red-400">
                        <span className="animate-onair h-1.5 w-1.5 rounded-full bg-red-500" aria-hidden="true" />
                        On air
                      </span>
                    )}
                  </p>
                  <p className="truncate text-xs text-muted-foreground">
                    {row.artist}
                    <span className="mx-1.5 text-border">·</span>
                    <span className="font-mono text-[10px]">{row.rightsId}</span>
                    {row.lastPlayedAt && (
                      <>
                        <span className="mx-1.5 text-border">·</span>
                        last spin {timeAgoShort(row.lastPlayedAt, serverMs)}
                      </>
                    )}
                  </p>
                </div>

                {row.shouts7d > 0 && (
                  <span
                    title={`${row.shouts7d} listener shout${row.shouts7d === 1 ? '' : 's'} this week`}
                    className="relative inline-flex shrink-0 items-center gap-0.5 rounded border border-red-500/30 bg-red-500/10 px-1.5 py-0.5 text-[10px] font-bold text-red-400"
                  >
                    <Flame className="h-3 w-3" aria-hidden="true" />
                    {row.shouts7d}
                  </span>
                )}
                <span
                  title={`${row.spins7d} spins this week`}
                  className="relative shrink-0 font-mono text-xs text-primary"
                >
                  {row.spins7d}
                  <span className="ml-1 hidden text-[9px] uppercase tracking-wider text-muted-foreground sm:inline">
                    spins
                  </span>
                </span>
                <Badge
                  variant="outline"
                  className="relative hidden shrink-0 border-border/70 text-[10px] text-muted-foreground md:inline-flex"
                >
                  {row.playlist}
                </Badge>
              </motion.li>
            ))}
          </ol>
        )}
        <p className="mt-3 flex items-center gap-1.5 text-[10px] leading-relaxed text-muted-foreground">
          <Mic className="h-3 w-3 shrink-0" aria-hidden="true" />
          Every counted spin passed the rights gate — the chart is an audit trail with rhythm.
          <Radio className="h-3 w-3 shrink-0" aria-hidden="true" />
        </p>
      </CardContent>
    </Card>
  )
}
