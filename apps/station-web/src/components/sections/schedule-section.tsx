'use client'

import { useCallback, useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import {
  CalendarClock,
  Mic,
  ListMusic,
  Clock,
  Repeat,
  ChevronRight,
  AlertCircle,
  RefreshCw,
  History,
} from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { ListenBackDialog } from '@/components/station/listen-back-dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import type { ScheduleResponse, ShowDTO } from '@/lib/station-types'

const DAY_NAMES = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const

const DAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const

/** Static accent tint map — only amber/red/orange/yellow/zinc, never blue. */
const ACCENT_CARD: Record<string, string> = {
  amber: 'border-amber-500/40 bg-amber-500/10',
  red: 'border-red-500/40 bg-red-500/10',
  orange: 'border-orange-500/40 bg-orange-500/10',
  yellow: 'border-yellow-500/40 bg-yellow-500/10',
  zinc: 'border-zinc-500/40 bg-zinc-500/10',
}

function accentClasses(accent: string): string {
  return ACCENT_CARD[accent] ?? 'border-border bg-card/60'
}

function fmtTime(hour: number, minute: number): string {
  const h12 = hour % 12 === 0 ? 12 : hour % 12
  const ampm = hour < 12 ? 'AM' : 'PM'
  const mm = String(minute).padStart(2, '0')
  return `${h12}:${mm} ${ampm}`
}

function ExplicitBadge() {
  return (
    <span
      title="Explicit — airplay restricted outside ad windows"
      className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-[3px] bg-red-500/90 text-[9px] font-black leading-none text-white"
      aria-label="Explicit"
    >
      E
    </span>
  )
}

function ShowCard({
  show,
  isCurrent,
  onListenBack,
}: {
  show: ShowDTO
  isCurrent: boolean
  onListenBack: (show: ShowDTO) => void
}) {
  return (
    <div
      className={`rounded-lg border p-2 transition-colors ${
        isCurrent ? 'ring-2 ring-red-500/60' : ''
      } ${accentClasses(show.accent)}`}
    >
      <div className="flex items-start justify-between gap-1">
        <p className="truncate text-xs font-semibold leading-tight" title={show.name}>
          {show.name}
        </p>
        <span className="flex shrink-0 items-center gap-1">
          {show.kind === 'LIVE' ? (
            <Mic className="h-3 w-3 text-red-400" aria-label="Live show" />
          ) : (
            <ListMusic className="h-3 w-3 text-amber-400" aria-label="Playlist show" />
          )}
          {show.explicit && <ExplicitBadge />}
        </span>
      </div>
      <p className="mt-0.5 truncate text-[10px] text-muted-foreground" title={show.host}>
        {show.host}
      </p>
      <p className="mt-0.5 font-mono text-[10px] text-foreground/80">
        {fmtTime(show.startHour, show.startMinute)} · {show.durationMin}m
      </p>
      <div className="mt-1 flex items-center justify-between gap-1">
        {isCurrent ? (
          <span className="inline-flex items-center gap-1 rounded-full border border-red-500/40 bg-red-500/15 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-red-400">
            <span className="h-1.5 w-1.5 rounded-full bg-red-500 animate-onair" />
            On Air Now
          </span>
        ) : (
          <span aria-hidden="true" />
        )}
        <button
          type="button"
          onClick={() => onListenBack(show)}
          title="Open the program log of a past airing"
          className="inline-flex items-center gap-1 rounded-sm border border-border/60 bg-background/50 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-muted-foreground transition-colors hover:border-primary/40 hover:text-primary"
        >
          <History className="h-2.5 w-2.5" aria-hidden />
          Log
        </button>
      </div>
    </div>
  )
}

export function ScheduleSection({ onNavigate }: { onNavigate?: (tab: string) => void }) {
  const [data, setData] = useState<ScheduleResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selectedDay, setSelectedDay] = useState<string>('')
  const [listenShow, setListenShow] = useState<ShowDTO | null>(null)

  const refresh = useCallback(async () => {
    try {
      setError(null)
      const res = await fetch('/api/schedule', { cache: 'no-store' })
      if (!res.ok) throw new Error(`Schedule request failed (${res.status})`)
      const json: ScheduleResponse = await res.json()
      setData(json)
      setSelectedDay((prev) => (prev === '' ? String(json.now.dayOfWeek) : prev))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load schedule')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
    // auto-updates: re-poll every 60s so "now"/current show stay fresh
    const id = setInterval(() => void refresh(), 60_000)
    return () => clearInterval(id)
  }, [refresh])

  const shows = data?.shows ?? []
  const today = data?.now.dayOfWeek ?? 0
  const currentShowId = data?.currentShowId ?? null
  const currentShow = shows.find((s) => s.id === currentShowId) ?? null
  const selected = selectedDay === '' ? today : Number(selectedDay)
  const mobileShows = shows
    .filter((s) => s.dayOfWeek === selected)
    .sort((a, b) => a.startHour - b.startHour || a.startMinute - b.startMinute)

  return (
    <motion.section
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25, ease: 'easeOut' }}
      aria-labelledby="schedule-heading"
      className="space-y-6"
    >
      {/* ---- Section header ---- */}
      <div className="flex items-start gap-3">
        <div className="rounded-lg bg-primary/10 p-2 text-primary">
          <CalendarClock className="h-5 w-5" aria-hidden />
        </div>
        <div>
          <h2 id="schedule-heading" className="text-xl font-bold tracking-tight">
            Weekly Schedule
          </h2>
          <p className="text-sm text-muted-foreground">
            All times Eastern (America/New_York) — auto-updates
          </p>
        </div>
      </div>

      {/* ---- Chips row: now label, on-air pill, legend ---- */}
      {!loading && !error && data && (
        <div className="flex flex-wrap items-center gap-2">
          <Badge
            variant="outline"
            className="border-border bg-card/60 font-mono text-xs text-foreground/80"
          >
            <Clock className="mr-1 h-3 w-3" aria-hidden />
            {data.now.label}
          </Badge>
          {currentShow ? (
            <button
              type="button"
              onClick={() => onNavigate?.('on-air')}
              title="See what's spinning on the On Air panel"
              className="inline-flex items-center rounded-md transition-transform hover:scale-[1.03] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
            >
              <Badge className="border border-red-500/40 bg-red-500/15 text-xs font-semibold text-red-400 hover:bg-red-500/15">
                <span className="mr-1.5 h-1.5 w-1.5 rounded-full bg-red-500 animate-onair" aria-hidden />
                ON AIR NOW · {currentShow.name}
                <ChevronRight className="ml-1 h-3 w-3" aria-hidden />
              </Badge>
            </button>
          ) : (
            <Badge
              variant="outline"
              className="border-border bg-card/60 text-xs text-muted-foreground"
            >
              AutoDJ rotation — no live show right now
            </Badge>
          )}
          <span className="ml-auto flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
            <Badge variant="outline" className="border-red-500/30 bg-red-500/10 text-red-400">
              <Mic className="mr-1 h-3 w-3" aria-hidden /> LIVE
            </Badge>
            <Badge variant="outline" className="border-amber-500/30 bg-amber-500/10 text-amber-400">
              <ListMusic className="mr-1 h-3 w-3" aria-hidden /> PLAYLIST
            </Badge>
            <span className="inline-flex items-center gap-1">
              <ExplicitBadge /> explicit
            </span>
          </span>
        </div>
      )}

      {/* ---- Loading skeletons ---- */}
      {loading && (
        <div className="grid grid-cols-7 gap-2">
          {Array.from({ length: 7 }).map((_, i) => (
            <div key={i} className="space-y-2">
              <Skeleton className="h-6 w-full" />
              <Skeleton className="h-16 w-full" />
              <Skeleton className="h-16 w-full" />
            </div>
          ))}
        </div>
      )}

      {/* ---- Error state ---- */}
      {!loading && error && (
        <Card className="border-destructive/40">
          <CardContent className="flex flex-col items-center gap-3 p-8 text-center">
            <AlertCircle className="h-8 w-8 text-red-400" aria-hidden />
            <p className="text-sm text-muted-foreground">{error}</p>
            <Button
              onClick={() => void refresh()}
              variant="outline"
              className="h-9 min-w-28"
              aria-label="Retry loading schedule"
            >
              <RefreshCw className="mr-2 h-4 w-4" aria-hidden /> Retry
            </Button>
          </CardContent>
        </Card>
      )}

      {/* ---- Data ---- */}
      {!loading && !error && data && (
        <>
          {/* Desktop: 7-column week grid */}
          <div className="hidden gap-2 lg:grid lg:grid-cols-7" role="table" aria-label="Weekly schedule grid">
            {DAY_SHORT.map((short, day) => {
              const dayShows = shows
                .filter((s) => s.dayOfWeek === day)
                .sort((a, b) => a.startHour - b.startHour || a.startMinute - b.startMinute)
              const isToday = day === today
              return (
                <div key={short} className="flex min-h-56 flex-col gap-1.5">
                  <div
                    className={`pb-1 text-center text-xs font-semibold ${
                      isToday
                        ? 'text-primary font-bold underline decoration-amber-400 decoration-2 underline-offset-4'
                        : 'text-muted-foreground'
                    }`}
                  >
                    {short}
                  </div>
                  {dayShows.length === 0 && (
                    <div className="rounded-lg border border-dashed border-border/70 p-2 text-center text-[10px] text-muted-foreground/60">
                      AutoDJ
                    </div>
                  )}
                  {dayShows.map((show) => (
                    <ShowCard
                      key={show.id}
                      show={show}
                      isCurrent={show.id === currentShowId}
                      onListenBack={setListenShow}
                    />
                  ))}
                </div>
              )
            })}
          </div>

          {/* Mobile / tablet: day picker + roomier list */}
          <div className="space-y-3 lg:hidden">
            <Select value={String(selected)} onValueChange={(v) => setSelectedDay(v)}>
              <SelectTrigger className="h-10 w-full sm:w-56" aria-label="Pick a day">
                <SelectValue placeholder="Pick a day" />
              </SelectTrigger>
              <SelectContent>
                {DAY_NAMES.map((name, day) => (
                  <SelectItem key={name} value={String(day)}>
                    {name}
                    {day === today ? ' — today' : ''}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <div className="space-y-2">
              {mobileShows.length === 0 && (
                <Card className="border-dashed">
                  <CardContent className="p-4 text-center text-sm text-muted-foreground">
                    No scheduled shows — the AutoDJ rotation holds the day.
                  </CardContent>
                </Card>
              )}
              {mobileShows.map((show) => (
                <Card
                  key={show.id}
                  className={`p-0 ${show.id === currentShowId ? 'ring-2 ring-red-500/60' : ''} ${accentClasses(show.accent)}`}
                >
                  <CardContent className="flex items-center justify-between gap-3 p-4">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold">{show.name}</p>
                      <p className="truncate text-xs text-muted-foreground">{show.host}</p>
                      <p className="mt-0.5 font-mono text-xs text-foreground/80">
                        {DAY_SHORT[show.dayOfWeek]} {fmtTime(show.startHour, show.startMinute)} ·{' '}
                        {show.durationMin}m
                      </p>
                      {show.id === currentShowId && (
                        <span className="mt-1.5 inline-flex items-center gap-1 rounded-full border border-red-500/40 bg-red-500/15 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-red-400">
                          <span className="h-1.5 w-1.5 rounded-full bg-red-500 animate-onair" aria-hidden />
                          On Air Now
                        </span>
                      )}
                    </div>
                    <div className="flex shrink-0 flex-col items-end gap-1.5">
                      {show.kind === 'LIVE' ? (
                        <Badge variant="outline" className="border-red-500/30 bg-red-500/10 text-red-400">
                          <Mic className="mr-1 h-3 w-3" aria-hidden /> LIVE
                        </Badge>
                      ) : (
                        <Badge
                          variant="outline"
                          className="border-amber-500/30 bg-amber-500/10 text-amber-400"
                        >
                          <ListMusic className="mr-1 h-3 w-3" aria-hidden /> PLAYLIST
                        </Badge>
                      )}
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="h-7 gap-1.5 px-2 text-[11px]"
                        onClick={() => setListenShow(show)}
                        aria-label={`Open the program log for ${show.name}`}
                      >
                        <History className="h-3 w-3" aria-hidden />
                        Listen back
                      </Button>
                      {show.explicit && <ExplicitBadge />}
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          </div>

          {/* ---- Hourly clock ---- */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-base">
                <div className="rounded-md bg-primary/10 p-1.5 text-primary">
                  <Repeat className="h-4 w-4" aria-hidden />
                </div>
                Hourly Clock
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex flex-wrap items-center gap-1.5">
                {[
                  'Music (3-4 tracks)',
                  'Station ID',
                  'Talk / Spotlight (3-5 min)',
                  'Music',
                  'Ad break (1-2 min)',
                ].map((step, i, arr) => (
                  <div key={step} className="flex items-center gap-1.5">
                    <span className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-card/60 px-2.5 py-1.5 text-xs">
                      <Clock className="h-3.5 w-3.5 text-primary" aria-hidden />
                      {step}
                    </span>
                    {i < arr.length - 1 && (
                      <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                    )}
                  </div>
                ))}
              </div>
              <p className="text-xs leading-relaxed text-muted-foreground">
                <span className="font-semibold text-foreground/80">Clean Daypart runs 6a–7p ET</span>{' '}
                — explicit tracks are held out of the AutoDJ wheel until 7:00 PM. The Fallback
                playlist guarantees zero dead air.
              </p>
            </CardContent>
          </Card>
        </>
      )}

      <ListenBackDialog show={listenShow} onClose={() => setListenShow(null)} />
    </motion.section>
  )
}
