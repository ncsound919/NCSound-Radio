'use client'

/**
 * ArtistDetailDialog — the public artist profile behind the Wave Chart.
 * Opens when a listener clicks an artist anywhere on the chart (Artists of
 * the Week, Hall of Fame, or a weekly row). Every number shown is earned
 * from the play log.
 */

import { motion } from 'framer-motion'
import {
  AudioLines,
  CalendarDays,
  ChartBar,
  Disc3,
  Flame,
  Instagram,
  ListMusic,
  MapPin,
  Radio,
  ScrollText,
  Send,
  Timer,
} from 'lucide-react'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Skeleton } from '@/components/ui/skeleton'
import { ErrorLine } from '@/components/station/error-line'
import { useJson } from '@/hooks/use-json'
import type { ArtistDetailResponse } from '@/lib/station-types'
import { cn } from '@/lib/utils'

function timeAgoShort(iso: string, serverMs: number): string {
  const min = Math.floor(Math.max(0, serverMs - new Date(iso).getTime()) / 60000)
  if (min < 1) return 'just now'
  if (min < 60) return `${min}m ago`
  const hrs = Math.floor(min / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.floor(hrs / 24)}d ago`
}

/** Handle-or-URL → absolute link (roster socials may be stored either way). */
function socialUrl(kind: 'instagram' | 'soundcloud', value: string): string {
  const v = value.trim()
  if (/^https?:\/\//i.test(v)) return v
  return `https://${kind}.com/${v.replace(/^@/, '').replace(/\/$/, '')}`
}

const RANK_CHIP: Record<number, string> = {
  1: 'border-primary/50 bg-primary/15 text-primary',
  2: 'border-red-500/40 bg-red-500/10 text-red-300',
  3: 'border-amber-500/30 bg-amber-500/10 text-amber-400',
}

function StatCell({
  icon: Icon,
  label,
  value,
  tone,
}: {
  icon: typeof ChartBar
  label: string
  value: string
  tone?: string
}) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5 px-3 py-2.5">
      <span className="flex items-center gap-1 text-[9px] font-bold uppercase tracking-widest text-muted-foreground">
        <Icon className="h-3 w-3" aria-hidden="true" />
        {label}
      </span>
      <span className={cn('truncate font-mono text-sm font-bold tabular-nums', tone ?? 'text-foreground')}>
        {value}
      </span>
    </div>
  )
}

export function ArtistDetailDialog({
  artist,
  onClose,
}: {
  artist: string | null
  onClose: () => void
}) {
  const url = artist ? `/api/artists/detail?name=${encodeURIComponent(artist)}` : '/api/artists/detail?name='
  const { data, error, retry } = useJson<ArtistDetailResponse>(artist ? url : '__idle__', artist ?? '')
  const serverMs = data ? new Date(data.serverTime).getTime() : Date.now()
  const open = artist !== null
  const maxTrackSpins = data?.tracks.length ? Math.max(...data.tracks.map((t) => t.totalSpins), 1) : 1

  return (
    <Dialog open={open} onOpenChange={(next) => (!next ? onClose() : undefined)}>
      <DialogContent
        className="max-h-[85vh] gap-0 overflow-hidden border-border/70 bg-card/95 p-0 sm:max-w-lg"
        aria-describedby={undefined}
      >
        {/* top gradient wash */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 top-0 h-24 bg-gradient-to-b from-primary/15 via-primary/5 to-transparent"
        />
        <div className="relative max-h-[85vh] overflow-y-auto scrollbar-thin">
          <DialogHeader className="gap-1.5 px-5 pb-3 pt-5 text-left">
            <DialogTitle className="flex items-center gap-3 text-lg font-bold leading-tight">
              <span
                aria-hidden="true"
                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-primary/40 bg-primary/10"
              >
                <Disc3 className="h-5 w-5 text-primary" />
              </span>
              <span className="min-w-0 break-words">{data?.found ? data.artist : (artist ?? 'Artist')}</span>
            </DialogTitle>
            <DialogDescription className="text-xs leading-relaxed">
              {data?.found
                ? `On air since ${
                    data.firstPlayedAt ? new Date(data.firstPlayedAt).toLocaleDateString() : '—'
                  } · profile earned from the play log, never hand-written`
                : 'Artist profile — spins, chart peaks and on-air history.'}
            </DialogDescription>
          </DialogHeader>

          {error ? (
            <div className="px-5 pb-5">
              <ErrorLine onRetry={retry} />
            </div>
          ) : !data ? (
            <div className="space-y-3 px-5 pb-6">
              <div className="grid grid-cols-4 gap-px overflow-hidden rounded-md border border-border/60 bg-border/60">
                {[0, 1, 2, 3].map((i) => (
                  <Skeleton key={i} className="h-16 rounded-none" />
                ))}
              </div>
              {[0, 1, 2].map((i) => (
                <Skeleton key={i} className="h-10 w-full rounded-md" />
              ))}
            </div>
          ) : !data.found ? (
            <div className="border-t border-border/60 px-5 py-8 text-center">
              <ListMusic className="mx-auto h-6 w-6 text-muted-foreground/60" aria-hidden="true" />
              <p className="mt-2 text-sm font-medium">No spins yet</p>
              <p className="mx-auto mt-1 max-w-xs text-xs leading-relaxed text-muted-foreground">
                No tracks by “{data.artist}” have spun on NCSound Radio yet. Artists appear here
                automatically after their first on-air play.
              </p>
            </div>
          ) : (
            <div className="space-y-4 px-5 pb-5">
              {/* Stats strip */}
              <div className="grid grid-cols-2 gap-px overflow-hidden rounded-md border border-border/60 bg-border/60 sm:grid-cols-4">
                <StatCell
                  icon={ChartBar}
                  label="7-day spins"
                  value={data.spins7d.toLocaleString()}
                  tone="text-primary"
                />
                <StatCell
                  icon={ScrollText}
                  label="All-time"
                  value={data.totalSpins.toLocaleString()}
                />
                <StatCell
                  icon={Radio}
                  label="Air share"
                  value={`${data.sharePct}%`}
                  tone="text-red-400"
                />
                <StatCell icon={ListMusic} label="Tracks" value={String(data.trackCount)} />
              </div>

              {/* Roster + submission profile — genres, home, first seen, socials */}
              {data.profile &&
                (data.profile.genres.length > 0 ||
                  data.profile.city ||
                  data.profile.state ||
                  data.profile.firstSeenAt ||
                  data.profile.instagram ||
                  data.profile.soundcloud) && (
                  <section
                    aria-label="Artist profile"
                    className="rounded-md border border-primary/25 bg-primary/[0.06] p-3"
                  >
                    {data.profile.genres.length > 0 && (
                      <div className="flex flex-wrap items-center gap-1.5">
                        {data.profile.genres.map((g) => (
                          <span
                            key={g}
                            className="rounded-full border border-primary/30 bg-primary/10 px-2 py-0.5 text-[10px] font-semibold text-primary"
                          >
                            {g}
                          </span>
                        ))}
                      </div>
                    )}
                    <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
                      {(data.profile.city || data.profile.state) && (
                        <span className="inline-flex items-center gap-1">
                          <MapPin className="h-3 w-3 text-primary/70" aria-hidden="true" />
                          {data.profile.city}
                          {data.profile.city && data.profile.state ? ', ' : ''}
                          {data.profile.state}
                        </span>
                      )}
                      {data.profile.firstSeenAt && (
                        <span className="inline-flex items-center gap-1">
                          <CalendarDays className="h-3 w-3 text-primary/70" aria-hidden="true" />
                          First submission{' '}
                          {new Date(data.profile.firstSeenAt).toLocaleDateString('en-US', {
                            month: 'short',
                            year: 'numeric',
                          })}
                        </span>
                      )}
                      {data.profile.submissions > 0 && (
                        <span className="inline-flex items-center gap-1">
                          <Send className="h-3 w-3 text-primary/70" aria-hidden="true" />
                          {data.profile.submissions} submission
                          {data.profile.submissions === 1 ? '' : 's'} through the door
                        </span>
                      )}
                      {data.profile.instagram && (
                        <a
                          href={socialUrl('instagram', data.profile.instagram)}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 font-medium text-foreground/80 underline-offset-2 transition-colors hover:text-primary hover:underline"
                        >
                          <Instagram className="h-3 w-3" aria-hidden="true" />
                          Instagram
                        </a>
                      )}
                      {data.profile.soundcloud && (
                        <a
                          href={socialUrl('soundcloud', data.profile.soundcloud)}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 font-medium text-foreground/80 underline-offset-2 transition-colors hover:text-primary hover:underline"
                        >
                          <AudioLines className="h-3 w-3" aria-hidden="true" />
                          SoundCloud
                        </a>
                      )}
                    </div>
                  </section>
                )}

              {/* Their tracks */}
              <section aria-label="Tracks on air">
                <h4 className="mb-1.5 flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
                  <ListMusic className="h-3 w-3" aria-hidden="true" />
                  Tracks
                </h4>
                <ol className="max-h-56 space-y-1 overflow-y-auto pr-1 scrollbar-thin">
                  {data.tracks.map((t, idx) => (
                    <motion.li
                      key={t.trackId}
                      initial={{ opacity: 0, x: -8 }}
                      animate={{ opacity: 1, x: 0 }}
                      transition={{ duration: 0.25, delay: idx * 0.04, ease: 'easeOut' }}
                      className="group relative flex items-center gap-2.5 overflow-hidden rounded-md border border-transparent px-2 py-1.5 transition-colors hover:border-border/70 hover:bg-accent/40"
                    >
                      {/* all-time spins share bar */}
                      <span
                        aria-hidden="true"
                        className="absolute inset-y-0 left-0 bg-gradient-to-r from-primary/12 via-primary/5 to-transparent"
                        style={{ width: `${Math.max(5, (t.totalSpins / maxTrackSpins) * 60)}%` }}
                      />
                      {t.chartRank !== null && (
                        <span
                          title={`#${t.chartRank} on this week's Wave Chart`}
                          className={cn(
                            'relative flex h-6 w-6 shrink-0 items-center justify-center rounded border font-mono text-[10px] font-bold',
                            RANK_CHIP[t.chartRank] ?? 'border-border bg-background/60 text-muted-foreground',
                          )}
                        >
                          {t.chartRank}
                        </span>
                      )}
                      <span className="relative min-w-0 flex-1">
                        <span className="flex items-center gap-1.5">
                          <span className="truncate text-xs font-medium">{t.title}</span>
                          {t.explicit && (
                            <span
                              title="Explicit lyrics"
                              className="rounded border border-red-500/40 bg-red-500/10 px-1 text-[8px] font-bold leading-3 text-red-400"
                            >
                              E
                            </span>
                          )}
                          {t.onAirNow && (
                            <span className="inline-flex shrink-0 items-center gap-1 rounded-sm bg-red-500/15 px-1 py-0.5 text-[8px] font-bold uppercase tracking-wider text-red-400">
                              <span className="animate-onair h-1 w-1 rounded-full bg-red-500" aria-hidden="true" />
                              On air
                            </span>
                          )}
                        </span>
                        <span className="mt-0.5 flex items-center gap-1.5 text-[10px] text-muted-foreground">
                          <span className="truncate">{t.playlist}</span>
                          {t.shouts7d > 0 && (
                            <span className="inline-flex shrink-0 items-center gap-0.5 text-red-400/90">
                              <Flame className="h-2.5 w-2.5" aria-hidden="true" />
                              {t.shouts7d}
                            </span>
                          )}
                        </span>
                      </span>
                      <span className="relative shrink-0 text-right">
                        <span className="block font-mono text-xs tabular-nums text-primary">{t.spins7d}</span>
                        <span className="block font-mono text-[9px] tabular-nums text-muted-foreground">
                          {t.totalSpins.toLocaleString()} all-time
                        </span>
                      </span>
                    </motion.li>
                  ))}
                </ol>
              </section>

              {/* Recent spins timeline */}
              {data.recent.length > 0 && (
                <section aria-label="Recent on-air spins">
                  <h4 className="mb-1.5 flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
                    <Timer className="h-3 w-3" aria-hidden="true" />
                    Recent spins
                  </h4>
                  <ul className="space-y-0.5">
                    {data.recent.map((r, idx) => (
                      <li
                        key={`${r.playedAt}-${idx}`}
                        className="flex items-center gap-2 rounded px-1.5 py-0.5 text-[11px] text-muted-foreground odd:bg-accent/20"
                      >
                        <span
                          aria-hidden="true"
                          className={cn(
                            'h-1 w-1 shrink-0 rounded-full',
                            idx === 0 ? 'animate-onair bg-red-500' : 'bg-border',
                          )}
                        />
                        <span className="min-w-0 flex-1 truncate">{r.title}</span>
                        <span className="shrink-0 font-mono text-[10px] tabular-nums">
                          {timeAgoShort(r.playedAt, serverMs)}
                        </span>
                        <span className="hidden shrink-0 rounded-sm border border-border/70 px-1 font-mono text-[9px] uppercase text-muted-foreground/70 sm:inline">
                          {r.source}
                        </span>
                      </li>
                    ))}
                  </ul>
                </section>
              )}

              <p className="text-[10px] leading-relaxed text-muted-foreground/70">
                Every number is read from the same play log as the broadcast itself — no hand-picked
                numbers, no vanity stats.
              </p>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
