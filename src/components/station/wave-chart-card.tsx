'use client'

/**
 * WaveChartCard — "The Wave Chart": the most-heard cleared tracks of the
 * trailing week, ranked straight from the PlayLog ledger with listener shout
 * heat folded in. Ranks are earned on air, not picked by hand — same audit
 * trail as the broadcast itself.
 */

import { motion } from 'framer-motion'
import { Crown, Flame, Mic, Radio, TrendingUp, Trophy, Users } from 'lucide-react'
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

/** Week-over-week movement chip: ▲ climbed · ▼ fell · NEW entered the chart. */
function MoverChip({ rank, prevRank }: { rank: number; prevRank: number | null }) {
  if (prevRank === null) {
    return (
      <span
        title="New on the chart — it was not ranking in the previous window"
        className="relative inline-flex shrink-0 items-center rounded border border-primary/40 bg-primary/10 px-1 py-0.5 text-[9px] font-extrabold uppercase tracking-wider text-primary"
      >
        New
      </span>
    )
  }
  const delta = prevRank - rank
  if (delta === 0) return null
  const up = delta > 0
  return (
    <span
      title={`Was #${prevRank} in the previous window`}
      className={cn(
        'relative inline-flex shrink-0 items-center gap-0.5 rounded border px-1 py-0.5 font-mono text-[9px] font-bold leading-3',
        up
          ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-400'
          : 'border-red-500/30 bg-red-500/5 text-red-400/90',
      )}
    >
      {up ? '▲' : '▼'}
      {Math.abs(delta)}
    </span>
  )
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
          <>
            {data.mover && (
              <motion.div
                initial={{ opacity: 0, y: -8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.35, ease: 'easeOut' }}
                className="mb-2.5 flex items-center gap-2.5 rounded-md border border-emerald-500/25 bg-gradient-to-r from-emerald-500/10 via-primary/[0.06] to-transparent px-3 py-2"
                role="status"
              >
                <span
                  className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-emerald-500/40 bg-emerald-500/15"
                  aria-hidden="true"
                >
                  <TrendingUp className="h-3.5 w-3.5 text-emerald-400" />
                </span>
                <p className="min-w-0 text-xs leading-tight">
                  <span className="font-bold uppercase tracking-wider text-emerald-400">
                    Biggest mover
                  </span>{' '}
                  <span className="font-semibold text-foreground">
                    {data.mover.title} — {data.mover.artist}
                  </span>{' '}
                  <span className="font-mono text-emerald-400/90">▲{data.mover.delta}</span>
                  <span className="text-muted-foreground">
                    {' '}· now #{data.mover.rank} on the chart
                  </span>
                </p>
              </motion.div>
            )}
            <ol
              className="max-h-96 space-y-1.5 overflow-y-auto pr-1 scrollbar-thin"
              aria-label="Weekly track chart"
            >
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

                <MoverChip rank={row.rank} prevRank={row.prevRank} />

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

            {/* ---- Hall of Fame + Artists of the Week ---- */}
            {(data.allTime.length > 0 || data.topArtists.length > 0) && (
              <div className="mt-4 grid gap-4 border-t border-border/60 pt-4 md:grid-cols-2">
                {data.allTime.length > 0 && (
                  <div>
                    <h4 className="mb-2 flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
                      <Crown className="h-3.5 w-3.5 text-primary" aria-hidden="true" />
                      Hall of Fame
                      <span className="font-medium normal-case tracking-normal text-muted-foreground/70">
                        · most spins since launch
                      </span>
                    </h4>
                    <ol className="space-y-1" aria-label="All-time most played tracks">
                      {data.allTime.map((e, idx) => (
                        <motion.li
                          key={e.trackId}
                          initial={{ opacity: 0, x: -8 }}
                          animate={{ opacity: 1, x: 0 }}
                          transition={{ duration: 0.3, delay: 0.25 + idx * 0.05, ease: 'easeOut' }}
                          className="flex items-center gap-2 rounded px-1.5 py-1 transition-colors hover:bg-accent/40"
                        >
                          <span
                            aria-hidden="true"
                            className={cn(
                              'flex h-5 w-5 shrink-0 items-center justify-center rounded-sm border font-mono text-[10px] font-bold',
                              e.rank === 1
                                ? 'border-primary/50 bg-primary/15 text-primary'
                                : 'border-border bg-background/60 text-muted-foreground',
                            )}
                          >
                            {e.rank}
                          </span>
                          <span className="min-w-0 flex-1 truncate text-xs">
                            <span className="font-medium">{e.title}</span>
                            <span className="text-muted-foreground"> — {e.artist}</span>
                          </span>
                          <span
                            title={`First spun ${e.firstPlayedAt ? new Date(e.firstPlayedAt).toLocaleDateString() : 'unknown'}`}
                            className="shrink-0 font-mono text-[10px] text-primary"
                          >
                            {e.totalSpins.toLocaleString()}
                          </span>
                        </motion.li>
                      ))}
                    </ol>
                  </div>
                )}
                {data.topArtists.length > 0 && (
                  <div>
                    <h4 className="mb-2 flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
                      <Users className="h-3.5 w-3.5 text-red-400" aria-hidden="true" />
                      Artists of the Week
                      <span className="font-medium normal-case tracking-normal text-muted-foreground/70">
                        · {data.musicSpins7d.toLocaleString()} music spins
                      </span>
                    </h4>
                    <ol className="space-y-1" aria-label="Top artists this week">
                      {data.topArtists.map((a, idx) => (
                        <motion.li
                          key={a.artist}
                          initial={{ opacity: 0, x: -8 }}
                          animate={{ opacity: 1, x: 0 }}
                          transition={{ duration: 0.3, delay: 0.25 + idx * 0.05, ease: 'easeOut' }}
                          className="group/a relative flex items-center gap-2 overflow-hidden rounded px-1.5 py-1 transition-colors hover:bg-accent/40"
                        >
                          <span
                            aria-hidden="true"
                            className="absolute inset-y-0 left-0 bg-gradient-to-r from-red-500/10 to-transparent transition-[width] duration-700 ease-out"
                            style={{ width: `${Math.max(4, a.sharePct)}%` }}
                          />
                          <span className="relative min-w-0 flex-1 truncate text-xs">
                            <span className="font-medium">{a.artist}</span>
                            <span className="text-muted-foreground">
                              {' '}· {a.trackCount} track{a.trackCount === 1 ? '' : 's'}
                            </span>
                          </span>
                          <span
                            title={`Top spin: ${a.topTrackTitle}`}
                            className="relative hidden max-w-28 truncate text-[10px] text-muted-foreground/80 sm:inline"
                          >
                            {a.topTrackTitle}
                          </span>
                          <span className="relative shrink-0 font-mono text-[10px] text-red-400/90">
                            {a.sharePct}%
                          </span>
                        </motion.li>
                      ))}
                    </ol>
                  </div>
                )}
              </div>
            )}
          </>
        )}
        <p className="mt-3 flex items-center gap-1.5 text-[10px] leading-relaxed text-muted-foreground">
          <Mic className="h-3 w-3 shrink-0" aria-hidden="true" />
          Every counted spin passed the rights gate — the chart is an audit trail with rhythm.
          <Radio className="h-3 w-3 shrink-0" aria-hidden="true" />
        </p>
        <p className="mt-1 text-[10px] leading-relaxed text-muted-foreground/70">
          Movement compares against the previous seven days (ending 24h ago), read from the same
          ledger — nothing is hand-picked.
        </p>
      </CardContent>
    </Card>
  )
}
