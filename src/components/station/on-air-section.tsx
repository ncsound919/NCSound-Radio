'use client'

import { useCallback, useEffect, useState, type ReactNode } from 'react'
import Image from 'next/image'
import { motion } from 'framer-motion'
import {
  ArrowRight,
  CalendarClock,
  Disc3,
  Gauge,
  Heart,
  History,
  ListMusic,
  Megaphone,
  MessageSquare,
  Pause,
  Play,
  ShieldCheck,
  TrendingUp,
  Upload,
  Users,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Progress } from '@/components/ui/progress'
import { Skeleton } from '@/components/ui/skeleton'
import { LiveChat } from '@/components/sections/live-chat'
import { useNowPlaying } from '@/hooks/use-nowplaying'
import { useStationPlayer } from '@/hooks/use-station-player'
import type {
  HistoryResponse,
  NowPlayingResponse,
  SponsorsResponse,
  StatsResponse,
} from '@/lib/station-types'
import { cn } from '@/lib/utils'

// ------------------------------------------------------------------ helpers

function hashString(s: string): number {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0
  return h
}

/** Deterministic art hue from the rights ID — amber/red family only (20..45). */
function hueForRightsId(rightsId: string): number {
  return 20 + (hashString(rightsId) % 26)
}

function fmtTime(sec: number): string {
  const s = Math.max(0, Math.round(sec))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

function timeAgo(playedAtMs: number, serverMs: number): string {
  const min = Math.floor(Math.max(0, serverMs - playedAtMs) / 60000)
  if (min < 1) return 'just now'
  if (min < 60) return `${min} min ago`
  const hrs = Math.floor(min / 60)
  if (hrs < 24) return `${hrs} hr${hrs === 1 ? '' : 's'} ago`
  return `${Math.floor(hrs / 24)} d ago`
}

/** One-second local ticker for smooth progress interpolation between polls. */
function useNowTicker(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(id)
  }, [intervalMs])
  return now
}

/** Interpolated on-air progress (0..1) between nowplaying polls. */
function useInterpolatedProgress(data: NowPlayingResponse | null, lastFetch: number): number {
  const now = useNowTicker()
  const duration = data?.current.duration ?? 0
  if (!data || lastFetch <= 0 || duration <= 0) return 0
  return Math.min(1, Math.max(0, data.current.progress + (now - lastFetch) / 1000 / duration))
}

/** Tiny one-shot JSON fetcher with manual retry. */
function useJson<T>(url: string, extraKey?: string) {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState(false)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let cancelled = false
    const ctrl = new AbortController()
    const timeout = setTimeout(() => ctrl.abort(), 12000)
    fetch(url, { cache: 'no-store', signal: ctrl.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        return (await res.json()) as T
      })
      .then((json) => {
        if (!cancelled) {
          setData(json)
          setError(false)
        }
      })
      .catch(() => {
        if (!cancelled) setError(true)
      })
      .finally(() => clearTimeout(timeout))
    return () => {
      cancelled = true
      ctrl.abort()
      clearTimeout(timeout)
    }
  }, [url, extraKey, attempt])

  const retry = useCallback(() => setAttempt((a) => a + 1), [])
  return { data, error, retry }
}

function FadeIn({ children, delay = 0, className }: { children: ReactNode; delay?: number; className?: string }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 14 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, delay, ease: 'easeOut' }}
      className={className}
    >
      {children}
    </motion.div>
  )
}

function OnAirPill() {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-red-500/40 bg-red-500/15 px-2.5 py-1 text-[10px] font-bold uppercase tracking-widest text-red-400">
      <span className="animate-onair h-1.5 w-1.5 rounded-full bg-red-500" aria-hidden="true" />
      On Air
    </span>
  )
}

function ErrorLine({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-md border border-border/60 bg-background/40 px-3 py-2">
      <p className="text-xs text-muted-foreground">Feed unavailable — retrying…</p>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-7 px-2 text-xs text-primary hover:text-primary"
        onClick={onRetry}
      >
        Retry
      </Button>
    </div>
  )
}

// --------------------------------------------------------------------- main

export function OnAirSection({ onNavigate }: { onNavigate: (tab: string) => void }) {
  const { data, error, lastFetch } = useNowPlaying()
  const progress = useInterpolatedProgress(data, lastFetch)

  return (
    <div className="space-y-6">
      <Hero data={data} npError={error} onNavigate={onNavigate} />

      <div className="grid gap-6 lg:grid-cols-3">
        <FadeIn delay={0.05} className="lg:col-span-2">
          <NowPlayingCard data={data} progress={progress} />
        </FadeIn>
        <FadeIn delay={0.1}>
          <UpNextCard data={data} />
        </FadeIn>
      </div>

      <FadeIn delay={0.15}>
        <RecentlyPlayedCard trackKey={data?.current.track.id} />
      </FadeIn>

      <FadeIn delay={0.2}>
        <StatsStrip />
      </FadeIn>

      <FadeIn delay={0.25}>
        <StudioLineCard />
      </FadeIn>

      <FadeIn delay={0.3}>
        <SponsorTicker onNavigate={onNavigate} />
      </FadeIn>

      <FadeIn delay={0.35}>
        <TrustNote onNavigate={onNavigate} />
      </FadeIn>
    </div>
  )
}

// --------------------------------------------------------------------- hero

function Hero({
  data,
  npError,
  onNavigate,
}: {
  data: NowPlayingResponse | null
  npError: string | null
  onNavigate: (tab: string) => void
}) {
  const isPlaying = useStationPlayer((s) => s.isPlaying)
  const toggle = useStationPlayer((s) => s.toggle)

  const chips = [
    { icon: Gauge, label: '128 kbps AAC' },
    { icon: ShieldCheck, label: 'Rights-cleared library' },
    { icon: Heart, label: 'Listener-supported' },
  ]

  return (
    <FadeIn>
      <section
        aria-label="Station introduction"
        className="relative overflow-hidden rounded-xl border border-border/60"
      >
        <Image
          src="/station-hero.jpg"
          alt="Inside the WAVC 91.3 broadcast studio"
          fill
          priority
          sizes="(max-width: 1280px) 100vw, 1280px"
          className="object-cover opacity-60"
        />
        <div
          className="absolute inset-0 bg-gradient-to-r from-background via-background/70 to-background/30"
          aria-hidden="true"
        />
        <div className="relative p-6 sm:p-10">
          <div className="flex flex-wrap items-center gap-3">
            <Image
              src="/station-logo.png"
              alt=""
              width={40}
              height={40}
              className="animate-float-slow h-10 w-10 rounded-md"
            />
            <h1 className="text-glow text-3xl font-extrabold tracking-tight sm:text-5xl">
              WAVC 91.3 FM
            </h1>
            <OnAirPill />
          </div>

          <p className="mt-4 max-w-xl text-lg text-muted-foreground">
            The Carolinas&rsquo; independent hip-hop signal.
          </p>

          <div className="mt-5 flex flex-wrap gap-2">
            {chips.map((chip) => (
              <span
                key={chip.label}
                className="inline-flex items-center gap-1.5 rounded-full border border-border/70 bg-background/60 px-3 py-1 text-xs text-muted-foreground backdrop-blur"
              >
                <chip.icon className="h-3.5 w-3.5 text-primary" aria-hidden="true" />
                {chip.label}
              </span>
            ))}
          </div>

          <div className="mt-6 flex flex-wrap items-center gap-3">
            <Button
              type="button"
              size="lg"
              onClick={toggle}
              className="h-11 px-6 font-semibold"
              aria-label={isPlaying ? 'Pause the stream' : 'Listen live'}
            >
              {isPlaying ? (
                <Pause className="fill-current" aria-hidden="true" />
              ) : (
                <Play className="fill-current" aria-hidden="true" />
              )}
              {isPlaying ? 'Pause' : 'Listen Live'}
            </Button>
            <Button
              type="button"
              size="lg"
              variant="outline"
              onClick={() => onNavigate('submit')}
              className="h-11 px-6"
            >
              <Upload aria-hidden="true" />
              Submit Your Track
            </Button>
            <Button
              type="button"
              size="lg"
              variant="ghost"
              onClick={() => onNavigate('schedule')}
              className="h-11 px-4"
            >
              <CalendarClock aria-hidden="true" />
              Schedule
            </Button>
          </div>

          <p className="mt-4 flex items-center gap-2 text-sm text-muted-foreground" aria-live="polite">
            <span className="animate-pulse h-2 w-2 rounded-full bg-red-500" aria-hidden="true" />
            {npError
              ? 'Listener feed reconnecting…'
              : data
                ? `${data.listeners.current.toLocaleString()} tuned in right now`
                : 'Scanning the dial…'}
          </p>
        </div>
      </section>
    </FadeIn>
  )
}

// -------------------------------------------------------------- now playing

function NowPlayingCard({ data, progress }: { data: NowPlayingResponse | null; progress: number }) {
  const isPlaying = useStationPlayer((s) => s.isPlaying)
  const track = data?.current.track
  const duration = data?.current.duration ?? 0
  const remaining = Math.max(0, duration - progress * duration)
  const hue = track ? hueForRightsId(track.rightsId) : 32

  return (
    <Card className="border-border/60 bg-card/70">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base font-semibold">
          <Disc3
            className={cn('h-4 w-4 text-primary', isPlaying && 'animate-vinyl')}
            aria-hidden="true"
          />
          Now Playing
        </CardTitle>
        <CardDescription>Deterministic AutoDJ rotation — rights gate enforced</CardDescription>
      </CardHeader>
      <CardContent>
        {!data || !track ? (
          <Skeleton className="aspect-video w-full rounded-lg" aria-label="Loading now playing" />
        ) : (
          <div className="relative aspect-video overflow-hidden rounded-lg border border-border/60">
            <Image
              src="/station-texture.jpg"
              alt=""
              fill
              sizes="(max-width: 1024px) 100vw, 768px"
              className="object-cover"
            />
            {/* deterministic amber/red wash keyed to the rights ID */}
            <div
              className="absolute inset-0"
              style={{ backgroundColor: `oklch(0.55 0.19 ${hue} / 0.55)` }}
              aria-hidden="true"
            />
            <div
              className="absolute inset-0 bg-gradient-to-t from-background/95 via-background/30 to-background/10"
              aria-hidden="true"
            />

            {/* metadata chips */}
            <div className="absolute left-3 top-3 flex flex-wrap gap-1.5">
              <Badge
                variant="outline"
                className="border-border/70 bg-background/70 text-[10px] backdrop-blur"
              >
                {track.playlist}
              </Badge>
              <span className="rounded border border-border/70 bg-background/70 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground backdrop-blur">
                {track.rightsId}
              </span>
              {track.bpm !== null && (
                <span className="rounded border border-border/70 bg-background/70 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground backdrop-blur">
                  {track.bpm} BPM
                </span>
              )}
              {track.explicit && (
                <span
                  title="Explicit lyrics"
                  className="rounded border border-red-500/40 bg-red-500/15 px-1.5 py-0.5 text-[10px] font-bold text-red-400"
                >
                  E
                </span>
              )}
            </div>

            {/* big EQ strip along the bottom */}
            <div
              className="pointer-events-none absolute inset-x-0 bottom-0 flex items-end justify-center gap-1 px-6 pb-1 opacity-70"
              aria-hidden="true"
            >
              {[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23].map(
                (i) => {
                  const height = 8 + ((i * 7919) % 44)
                  return (
                    <span
                      key={i}
                      className={cn('w-1 rounded-sm bg-primary/80', isPlaying && 'eq-bar')}
                      style={{
                        height: isPlaying ? `${height}px` : '6px',
                        animationDelay: `${((i % 9) * 0.09).toFixed(2)}s`,
                      }}
                    />
                  )
                }
              )}
            </div>

            {/* title overlay */}
            <div className="absolute inset-x-0 bottom-0 p-4 pb-14 sm:p-5 sm:pb-16">
              <Progress
                value={progress * 100}
                className="h-1"
                aria-label="On-air progress"
              />
              <div className="mt-2 flex items-end justify-between gap-3">
                <div className="min-w-0">
                  <h3 className="truncate text-2xl font-bold">{track.title}</h3>
                  <p className="truncate text-sm text-muted-foreground">{track.artist}</p>
                </div>
                <span className="shrink-0 font-mono text-xs text-muted-foreground">
                  -{fmtTime(remaining)}
                </span>
              </div>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

// ----------------------------------------------------------------- up next

function UpNextCard({ data }: { data: NowPlayingResponse | null }) {
  return (
    <Card className="border-border/60 bg-card/70">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base font-semibold">
          <ListMusic className="h-4 w-4 text-primary" aria-hidden="true" />
          Up Next
        </CardTitle>
        <CardDescription>AutoDJ rotation queue</CardDescription>
      </CardHeader>
      <CardContent className="space-y-1">
        {!data ? (
          <div className="space-y-2">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-12 w-full rounded-md" />
            ))}
          </div>
        ) : data.next.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">Queue is empty.</p>
        ) : (
          data.next.map((t, i) => (
            <div
              key={t.id}
              className="flex items-center gap-3 rounded-md border border-transparent px-2 py-2 transition-colors hover:border-border hover:bg-accent/40"
            >
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded border border-border bg-background/60 font-mono text-[10px] text-muted-foreground">
                {i + 1}
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{t.title}</p>
                <p className="truncate text-xs text-muted-foreground">{t.artist}</p>
              </div>
              <span className="shrink-0 font-mono text-xs text-muted-foreground">
                {fmtTime(t.durationSec)}
              </span>
              <Badge
                variant="outline"
                className="hidden shrink-0 border-border/70 text-[10px] font-medium text-muted-foreground sm:inline-flex"
              >
                {t.playlist}
              </Badge>
            </div>
          ))
        )}
      </CardContent>
    </Card>
  )
}

// --------------------------------------------------------- recently played

function RecentlyPlayedCard({ trackKey }: { trackKey?: string }) {
  const { data, error, retry } = useJson<HistoryResponse>('/api/history?limit=10', trackKey)
  const { data: np } = useNowPlaying()
  const serverMs = np ? new Date(np.serverTime).getTime() : Date.now()

  return (
    <Card className="border-border/60 bg-card/70">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base font-semibold">
          <History className="h-4 w-4 text-primary" aria-hidden="true" />
          Recently Played
        </CardTitle>
        <CardDescription>Last ten spins from the play-log ledger</CardDescription>
      </CardHeader>
      <CardContent>
        {error ? (
          <ErrorLine onRetry={retry} />
        ) : !data ? (
          <div className="space-y-2">
            {[0, 1, 2, 3, 4].map((i) => (
              <Skeleton key={i} className="h-12 w-full rounded-md" />
            ))}
          </div>
        ) : data.plays.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            No spins logged yet — the AutoDJ is warming up.
          </p>
        ) : (
          <ul className="max-h-96 space-y-1 overflow-y-auto pr-1 scrollbar-thin">
            {data.plays.map((play) => (
              <li
                key={play.id}
                className="flex items-center gap-3 rounded-md px-2 py-2 transition-colors hover:bg-accent/40"
              >
                <span
                  aria-hidden="true"
                  className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-primary/20 bg-gradient-to-br from-primary/30 via-primary/15 to-red-500/20 text-sm font-bold text-primary"
                >
                  {(play.track.title.charAt(0) || '?').toUpperCase()}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{play.track.title}</p>
                  <p className="truncate text-xs text-muted-foreground">{play.track.artist}</p>
                </div>
                <span className="hidden shrink-0 font-mono text-[10px] text-muted-foreground sm:inline">
                  {play.track.rightsId}
                </span>
                <span className="w-20 shrink-0 text-right text-[10px] text-muted-foreground">
                  {timeAgo(new Date(play.playedAt).getTime(), serverMs)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}

// -------------------------------------------------------------- live stats

function StatsStrip() {
  const { data, error, retry } = useJson<StatsResponse>('/api/stats')

  const tiles = data
    ? [
        {
          icon: Users,
          label: 'Listeners Now',
          value: data.listeners.current.toLocaleString(),
        },
        {
          icon: TrendingUp,
          label: 'Peak 24h',
          value: data.listeners.peak24h.toLocaleString(),
        },
        {
          icon: ShieldCheck,
          label: 'Cleared Tracks',
          value: `${data.library.cleared}/${data.library.tracks}`,
        },
        {
          icon: Disc3,
          label: 'Programming',
          value: `${data.library.totalHours} hrs on the wheel`,
        },
      ]
    : null

  return (
    <section aria-label="Live station stats" className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      {error ? (
        <div className="sm:col-span-2 lg:col-span-4">
          <ErrorLine onRetry={retry} />
        </div>
      ) : !tiles ? (
        [0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-24 rounded-xl" />)
      ) : (
        tiles.map((tile) => (
          <div key={tile.label} className="rounded-xl border border-border/60 bg-card/60 p-4">
            <div className="flex items-center gap-1.5 text-xs uppercase tracking-wide text-muted-foreground">
              <tile.icon className="h-3.5 w-3.5 text-primary" aria-hidden="true" />
              {tile.label}
            </div>
            <p className="mt-2 break-words text-2xl font-bold text-primary">{tile.value}</p>
          </div>
        ))
      )}
    </section>
  )
}

// -------------------------------------------------------------- studio line

function StudioLineCard() {
  return (
    <Card className="border-border/60 bg-card/70">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base font-semibold">
          <MessageSquare className="h-4 w-4 text-primary" aria-hidden="true" />
          Studio Line — listener chat
          <span className="inline-flex items-center gap-1 rounded-sm bg-red-500/15 px-1.5 py-0.5 text-[10px] font-bold uppercase text-red-400">
            <span className="animate-onair h-1.5 w-1.5 rounded-full bg-red-500" aria-hidden="true" />
            live
          </span>
        </CardTitle>
        <CardDescription>Text the studio in real time — powered by the listener relay.</CardDescription>
      </CardHeader>
      <CardContent>
        {/* soften the inner card chrome so it reads as a panel inside this card */}
        <div className="[&_[data-slot=card]]:border-border/60 [&_[data-slot=card]]:bg-background/40 [&_[data-slot=card-header]]:bg-transparent">
          <LiveChat />
        </div>
      </CardContent>
    </Card>
  )
}

// ---------------------------------------------------------- sponsor ticker

function SponsorTicker({ onNavigate }: { onNavigate: (tab: string) => void }) {
  const { data, error, retry } = useJson<SponsorsResponse>('/api/sponsors')
  const active = data ? data.sponsors.filter((s) => s.status === 'ACTIVE') : null

  return (
    <Card className="overflow-hidden border-border/60 bg-card/70">
      <CardContent className="flex items-center gap-4 p-4">
        <span className="shrink-0 border-r border-border/60 pr-4 text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
          Supporting
        </span>
        {error ? (
          <div className="flex-1">
            <ErrorLine onRetry={retry} />
          </div>
        ) : !active ? (
          <Skeleton className="h-5 w-64" />
        ) : active.length === 0 ? (
          <button
            type="button"
            onClick={() => onNavigate('sponsors')}
            className="text-xs text-muted-foreground underline-offset-4 transition-colors hover:text-primary hover:underline"
          >
            Your brand could be here →
          </button>
        ) : (
          <div className="relative flex-1 overflow-hidden" aria-label="Current sponsors">
            <div className="animate-ticker flex w-max items-center gap-10">
              {[...active, ...active].map((sponsor, i) => (
                <span key={`${sponsor.id}-${i}`} className="flex items-center gap-10">
                  <span className="whitespace-nowrap text-xs uppercase tracking-widest text-muted-foreground">
                    {sponsor.name}
                  </span>
                  <Megaphone className="h-3 w-3 shrink-0 text-primary/60" aria-hidden="true" />
                </span>
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

// -------------------------------------------------------------- trust note

function TrustNote({ onNavigate }: { onNavigate: (tab: string) => void }) {
  return (
    <section
      aria-label="Rights gate note"
      className="flex flex-col gap-4 rounded-xl border border-border/60 bg-card/60 p-4 sm:flex-row sm:items-center sm:p-5"
    >
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-primary/30 bg-primary/10">
        <ShieldCheck className="h-5 w-5 text-primary" aria-hidden="true" />
      </span>
      <p className="flex-1 text-sm leading-relaxed text-muted-foreground">
        <span className="font-semibold text-foreground">The Rights Gate</span> — every track airs
        only after its rights record reads CLEARED. Browse the public ledger.
      </p>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={() => onNavigate('rights')}
        className="text-primary hover:text-primary"
      >
        Browse the ledger
        <ArrowRight aria-hidden="true" />
      </Button>
    </section>
  )
}
