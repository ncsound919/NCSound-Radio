'use client'

/**
 * ListenBackDialog — the program log of a past show occurrence. What actually
 * aired, rebuilt from the two audited ledgers (PlayLog + ad_plays): songs,
 * station IDs, spotlight segments and sold sponsor spots in broadcast order.
 */

import { useMemo, useState } from 'react'
import { motion } from 'framer-motion'
import {
  CalendarDays,
  Disc3,
  History,
  Megaphone,
  MessageSquareQuote,
  Mic,
  Radio,
} from 'lucide-react'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { ErrorLine } from '@/components/station/error-line'
import { useJson } from '@/hooks/use-json'
import type { ListenBackEntry, ListenBackResponse, ShowDTO } from '@/lib/station-types'
import { cn } from '@/lib/utils'

const ET = 'America/New_York'
const WEEKDAY_INDEX: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** Wall-clock parts for the station timezone (client-side Intl — mirrors broadcast.ts). */
function etParts(date: Date) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: ET,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  })
  const parts: Record<string, string> = {}
  for (const p of fmt.formatToParts(date)) parts[p.type] = p.value
  return {
    y: Number.parseInt(parts.year ?? '1970', 10),
    m: Number.parseInt(parts.month ?? '1', 10),
    d: Number.parseInt(parts.day ?? '1', 10),
    dow: WEEKDAY_INDEX[parts.weekday ?? 'Sun'] ?? 0,
    hour: Number.parseInt(parts.hour ?? '0', 10) % 24,
    minute: Number.parseInt(parts.minute ?? '0', 10),
  }
}

function etOffsetMinutes(date: Date): number {
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone: ET, timeZoneName: 'longOffset' })
  const name = fmt.formatToParts(date).find((p) => p.type === 'timeZoneName')?.value ?? 'GMT-05:00'
  const m = /GMT([+-])(\d{1,2})(?::(\d{2}))?/.exec(name)
  if (!m) return -300
  const sign = m[1] === '-' ? -1 : 1
  return sign * (Number.parseInt(m[2], 10) * 60 + (m[3] ? Number.parseInt(m[3], 10) : 0))
}

/**
 * The last `count` FULLY-ENDED occurrences of this show, as ET YYYY-MM-DD
 * strings. Walks back calendar-day by calendar-day over ET dates.
 */
function pastOccurrences(show: ShowDTO, count = 3): string[] {
  const out: string[] = []
  const today = etParts(new Date())
  const todayUtc = Date.UTC(today.y, today.m - 1, today.d)
  for (let back = 0; back < 29 && out.length < count; back++) {
    const noonUtc = todayUtc - back * 86_400_000 + 12 * 3_600_000
    const p = etParts(new Date(noonUtc))
    if (p.dow !== show.dayOfWeek) continue
    const off = etOffsetMinutes(new Date(noonUtc))
    const endMin = show.startHour * 60 + show.startMinute + show.durationMin
    const endMs = Date.UTC(p.y, p.m - 1, p.d) + endMin * 60_000 - off * 60_000
    if (endMs <= Date.now()) {
      out.push(`${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`)
    }
  }
  return out
}

function occurrenceLabel(dateStr: string): string {
  const [y, m, d] = dateStr.split('-').map((v) => Number.parseInt(v, 10))
  const dow = new Date(Date.UTC(y, m - 1, d, 12)).getUTCDay()
  const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  return `${DOW[dow]}, ${MONTHS[m - 1]} ${d}`
}

function fmtClock(minuteOfDay: number): string {
  const h24 = Math.floor(minuteOfDay / 60) % 24
  const mm = String(minuteOfDay % 60).padStart(2, '0')
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12
  return `${h12}:${mm} ${h24 < 12 ? 'AM' : 'PM'}`
}

function entryTime(iso: string): string {
  const p = etParts(new Date(iso))
  return fmtClock(p.hour * 60 + p.minute)
}

const KIND_STYLE: Record<ListenBackEntry['kind'], { icon: typeof Disc3; chip: string; label: string }> = {
  MUSIC: { icon: Disc3, chip: 'border-primary/30 bg-primary/10 text-primary', label: 'Music' },
  STATION_ID: { icon: Mic, chip: 'border-border bg-background/70 text-muted-foreground', label: 'Station ID' },
  TALK: { icon: MessageSquareQuote, chip: 'border-amber-500/40 bg-amber-500/10 text-amber-500', label: 'Spotlight' },
  AD_SPOT: { icon: Megaphone, chip: 'border-red-500/40 bg-red-500/10 text-red-400', label: 'Ad spot' },
}

export function ListenBackDialog({ show, onClose }: { show: ShowDTO | null; onClose: () => void }) {
  const occurrences = useMemo(() => (show ? pastOccurrences(show, 3) : []), [show])
  // Picked date (null = default to the most recent). Derived, no effect:
  // a stale pick that is no longer offered falls back to occurrences[0].
  const [picked, setPicked] = useState<string | null>(null)
  const selected = picked && occurrences.includes(picked) ? picked : (occurrences[0] ?? '')

  const url =
    show && selected ? `/api/shows/listenback?slug=${encodeURIComponent(show.slug)}&date=${selected}` : '__idle__'
  const { data, error, retry } = useJson<ListenBackResponse>(url, selected)

  const startMin = show ? show.startHour * 60 + show.startMinute : 0
  const endMin = show ? startMin + show.durationMin : 0

  return (
    <Dialog open={!!show} onOpenChange={(next) => !next && onClose()}>
      <DialogContent
        className="max-h-[85vh] gap-0 overflow-hidden border-border/70 bg-card/95 p-0 sm:max-w-lg"
        aria-describedby={undefined}
      >
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
                <History className="h-5 w-5 text-primary" />
              </span>
              <span className="min-w-0 break-words">Listen back — {show?.name ?? 'Show'}</span>
            </DialogTitle>
            <DialogDescription className="text-xs leading-relaxed">
              {show
                ? `with ${show.host} · ${fmtClock(startMin)} → ${fmtClock(endMin)} ET — what actually aired, from the ledger`
                : 'Program log'}
            </DialogDescription>
          </DialogHeader>

          {show && (
            <div className="space-y-3 px-5 pb-5">
              {/* occurrence picker */}
              {occurrences.length > 0 ? (
                <Select value={selected} onValueChange={setPicked}>
                  <SelectTrigger className="h-9 w-full" aria-label="Pick a past date">
                    <SelectValue placeholder="Pick a past date" />
                  </SelectTrigger>
                  <SelectContent>
                    {occurrences.map((d) => (
                      <SelectItem key={d} value={d}>
                        {occurrenceLabel(d)}
                        {d === occurrences[0] ? ' — most recent' : ''}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <p className="rounded-md border border-dashed border-border/70 bg-background/40 px-3 py-2.5 text-center text-xs text-muted-foreground">
                  No fully-ended occurrence of this show in the last month — the ledger only keeps
                  what actually aired.
                </p>
              )}

              {error ? (
                <ErrorLine onRetry={retry} />
              ) : !data ? (
                occurrences.length > 0 && (
                  <div className="space-y-2">
                    {[0, 1, 2, 3, 4].map((i) => (
                      <Skeleton key={i} className="h-9 w-full rounded-md" />
                    ))}
                  </div>
                )
              ) : (
                <>
                  {/* counts strip */}
                  <div className="flex flex-wrap items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider">
                    <span className="rounded-sm border border-primary/30 bg-primary/10 px-1.5 py-0.5 text-primary">
                      {data.counts.music} songs
                    </span>
                    <span className="rounded-sm border border-border/70 bg-background/60 px-1.5 py-0.5 text-muted-foreground">
                      {data.counts.ids} IDs
                    </span>
                    {data.counts.talk > 0 && (
                      <span className="rounded-sm border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-amber-500">
                        {data.counts.talk} spotlight
                      </span>
                    )}
                    {data.counts.ads > 0 && (
                      <span className="rounded-sm border border-red-500/40 bg-red-500/10 px-1.5 py-0.5 text-red-400">
                        {data.counts.ads} sponsor spots
                      </span>
                    )}
                    <span className="ml-auto inline-flex items-center gap-1 normal-case tracking-normal text-muted-foreground">
                      <CalendarDays className="h-3 w-3" aria-hidden="true" />
                      {occurrenceLabel(data.date)}
                    </span>
                  </div>

                  {/* program log */}
                  {data.entries.length === 0 ? (
                    <div className="border-t border-border/60 py-8 text-center">
                      <Radio className="mx-auto h-6 w-6 text-muted-foreground/60" aria-hidden="true" />
                      <p className="mt-2 text-sm font-medium">A quiet window on the ledger</p>
                      <p className="mx-auto mt-1 max-w-xs text-xs leading-relaxed text-muted-foreground">
                        No spins were logged during this occurrence — the play-log fills as the
                        station broadcasts.
                      </p>
                    </div>
                  ) : (
                    <ol className="max-h-[46vh] space-y-0.5 overflow-y-auto pr-1 scrollbar-thin">
                      {data.entries.map((e, idx) => {
                        const k = KIND_STYLE[e.kind]
                        const Icon = k.icon
                        return (
                          <motion.li
                            key={`${e.at}-${idx}`}
                            initial={{ opacity: 0, x: -6 }}
                            animate={{ opacity: 1, x: 0 }}
                            transition={{ duration: 0.2, delay: Math.min(idx * 0.015, 0.4), ease: 'easeOut' }}
                            className={cn(
                              'flex items-center gap-2.5 rounded-md px-2 py-1.5 transition-colors hover:bg-accent/40',
                              idx % 2 === 1 && 'bg-accent/20',
                            )}
                          >
                            <span className="w-14 shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground">
                              {entryTime(e.at)}
                            </span>
                            <span
                              title={k.label}
                              className={cn(
                                'flex h-6 w-6 shrink-0 items-center justify-center rounded border',
                                k.chip,
                              )}
                            >
                              <Icon className="h-3 w-3" aria-hidden="true" />
                            </span>
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-xs font-medium">{e.title}</span>
                              <span className="block truncate text-[10px] text-muted-foreground">
                                {e.kind === 'AD_SPOT'
                                  ? `${e.artist} — sold spot (proof-of-play logged)`
                                  : e.artist}
                              </span>
                            </span>
                            {e.source && (
                              <span
                                className={cn(
                                  'hidden shrink-0 rounded-sm border px-1 py-0.5 font-mono text-[9px] uppercase sm:inline',
                                  e.source === 'LIVE DJ'
                                    ? 'border-red-500/40 text-red-400'
                                    : 'border-border/70 text-muted-foreground/70',
                                )}
                              >
                                {e.source}
                              </span>
                            )}
                          </motion.li>
                        )
                      })}
                    </ol>
                  )}
                  <p className="text-[10px] leading-relaxed text-muted-foreground/70">
                    Rebuilt from the same two ledgers the station runs on — the play-log for songs,
                    IDs and segments, the ad ledger for sold spots. House promos ride the break but
                    keep no receipt.
                  </p>
                </>
              )}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
