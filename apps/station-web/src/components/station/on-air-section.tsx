'use client'

import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import Image from 'next/image'
import { motion } from 'framer-motion'
import {
  ArrowRight,
  CalendarClock,
  Disc3,
  Flame,
  Gauge,
  Heart,
  History,
  ListMusic,
  Megaphone,
  MessageSquare,
  MessageSquareQuote,
  Mic,
  Pause,
  Play,
  Radio,
  Share2,
  ShieldCheck,
  Sun,
  TrendingUp,
  Upload,
  Users,
} from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Progress } from '@/components/ui/progress'
import { Skeleton } from '@/components/ui/skeleton'
import { LiveChat } from '@/components/sections/live-chat'
import { RequestLine, REQUEST_PREFILL_EVENT } from '@/components/station/request-line'
import { ErrorLine } from '@/components/station/error-line'
import { MyWavesCard } from '@/components/station/my-waves-card'
import { ProgramClockRing } from '@/components/station/program-clock-ring'
import { SpectrumCanvas } from '@/components/station/spectrum-canvas'
import { WaveChartCard } from '@/components/station/wave-chart-card'
import { useFavorites } from '@/hooks/use-favorites'
import { useCountUp } from '@/hooks/use-count-up'
import { useJson } from '@/hooks/use-json'
import { useNowPlaying } from '@/hooks/use-nowplaying'
import { useStationPlayer } from '@/hooks/use-station-player'
import { useAudioLevel } from '@/hooks/use-audio-level'
import { shareNowPlaying, shareStation } from '@/lib/share'
import type {
  HistoryResponse,
  ListenersHistoryResponse,
  NowPlayingResponse,
  QueueEntry,
  SponsorsResponse,
  StatsResponse,
} from '@/lib/station-types'
import { cn } from '@/lib/utils'
import { Sparkline } from '@/components/station/sparkline'

// ------------------------------------------------------------------ helpers

function hashString(s: string): number {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0
  return h
}

/** Deterministic art hue from the rights ID — amber/red family only (20..45). */
function hueForRightsId(rightsId: string | null): number {
  // No rights record yet: use the neutral hue rather than hashing null.
  if (!rightsId) return 32
  return 20 + (hashString(rightsId) % 26)
}

function fmtTime(sec: number): string {
  const s = Math.max(0, Math.round(sec))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/**
 * Share the current spin — music gets the track shout-out (Web Share →
 * clipboard), other elements share the station. Toasts the outcome.
 */
async function shareSpin(kind: string, title: string, artist: string): Promise<void> {
  if (kind === 'MUSIC') {
    const result = await shareNowPlaying(title, artist)
    if (result === 'copied') toast.success(`“${title}” shout-out copied — pass it on.`)
    else if (result === 'failed')
      toast.error('Could not share — try copying the link from the address bar.')
  } else {
    const result = await shareStation()
    if (result === 'copied') toast.success('Stream link copied — pass it on.')
    else if (result === 'failed') toast.error('Could not share — copy ncsound.fm from the address bar.')
  }
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
  const duration = data?.current?.duration ?? 0
  if (!data || lastFetch <= 0 || duration <= 0) return 0
  return Math.min(1, Math.max(0, (data.current?.progress ?? 0) + (now - lastFetch) / 1000 / duration))
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

/**
 * On-air indicator driven by the reported mode.
 *
 * This previously rendered a pulsing red "On Air" unconditionally, including
 * when the engine was unreachable or had nothing loaded. The API returns a
 * mode precisely so the badge can tell the truth, and a station that says it is
 * on air while it is not is the worst thing this component could do.
 */
function OnAirPill({ mode }: { mode: NowPlayingResponse['mode'] | undefined }) {
  if (mode === 'live') {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full border border-red-500/40 bg-red-500/15 px-2.5 py-1 text-[10px] font-bold uppercase tracking-widest text-red-400">
        <span className="animate-onair h-1.5 w-1.5 rounded-full bg-red-500" aria-hidden="true" />
        On Air
      </span>
    )
  }
  if (mode === 'standby') {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-500/40 bg-amber-500/15 px-2.5 py-1 text-[10px] font-bold uppercase tracking-widest text-amber-400">
        <span className="h-1.5 w-1.5 rounded-full bg-amber-500" aria-hidden="true" />
        Standby
      </span>
    )
  }
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-muted px-2.5 py-1 text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
      <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground" aria-hidden="true" />
      Offline
    </span>
  )
}

// -------------------------------------------------------------- track dialog

/**
 * TrackDialog — detail sheet for any real spin (music / ID / talk). Music
 * tracks deep-link into the request line; imaging/talk link to their ledger.
 */
function TrackDialog({
  entry,
  onClose,
  onNavigate,
}: {
  entry: QueueEntry | null
  onClose: () => void
  onNavigate: (tab: string) => void
}) {
  const requestable =
    !!entry && entry.elementKind === 'MUSIC' && !['Imaging', 'Talk'].includes(entry.playlist)
  const hue = entry ? hueForRightsId(entry.rightsId) : 32
  const { ids, toggle } = useFavorites()
  const isFav = !!entry && ids.has(entry.id)

  const handleHeart = () => {
    if (!entry) return
    const added = toggle({
      id: entry.id,
      title: entry.title,
      artist: entry.artist,
      rightsId: entry.rightsId,
    })
    if (added) {
      toast.success(`Saved to My Waves — “${entry.title}”`, {
        description: 'We\'ll toast you when it hits the wheel.',
      })
    } else {
      toast(`Removed from My Waves`, { description: entry.title })
    }
  }

  const handleRequest = () => {
    if (!entry) return
    window.dispatchEvent(
      new CustomEvent(REQUEST_PREFILL_EVENT, { detail: { trackId: entry.id } }),
    )
    toast.success(`“${entry.title}” is staged in the request line — add your name and send it.`)
    onClose()
    document
      .getElementById('request-line')
      ?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  return (
    <Dialog open={!!entry} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-md gap-4">
        {entry && (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2 pr-6 text-lg">
                <Disc3 className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
                <span className="truncate">{entry.title}</span>
              </DialogTitle>
              <DialogDescription className="truncate">
                {entry.artist}
                {entry.album ? ` — ${entry.album}` : ''}
              </DialogDescription>
            </DialogHeader>

            <div
              className="relative h-24 overflow-hidden rounded-lg border border-border/60"
              style={{ backgroundColor: `oklch(0.55 0.19 ${hue} / 0.35)` }}
              aria-hidden="true"
            >
              <div className="absolute inset-0 flex items-end justify-center gap-1 px-4 pb-2 opacity-80">
                {Array.from({ length: 28 }, (_, i) => (
                  <span
                    key={i}
                    className="w-1 rounded-sm bg-background/80"
                    style={{ height: `${8 + ((i * 7919) % 48)}px` }}
                  />
                ))}
              </div>
              <span className="absolute left-3 top-3 rounded-sm bg-background/70 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-widest text-foreground">
                {entry.elementKind === 'MUSIC' ? 'Music' : entry.elementKind === 'TALK' ? 'Talk' : 'Station ID'}
              </span>
            </div>

            <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
              <div>
                <dt className="text-[10px] uppercase tracking-wider text-muted-foreground">Playlist</dt>
                <dd className="font-medium">{entry.playlist}</dd>
              </div>
              <div>
                <dt className="text-[10px] uppercase tracking-wider text-muted-foreground">Duration</dt>
                <dd className="font-mono">{fmtTime(entry.durationSec)}</dd>
              </div>
              <div>
                <dt className="text-[10px] uppercase tracking-wider text-muted-foreground">Rights ID</dt>
                <dd className="font-mono text-primary">{entry.rightsId ?? '—'}</dd>
              </div>
              <div>
                <dt className="text-[10px] uppercase tracking-wider text-muted-foreground">Explicit</dt>
                <dd className="font-medium">{entry.explicit ? 'E — held 6a–7p ET' : 'Clean'}</dd>
              </div>
              {entry.bpm !== null && (
                <div>
                  <dt className="text-[10px] uppercase tracking-wider text-muted-foreground">BPM</dt>
                  <dd className="font-mono">{entry.bpm}</dd>
                </div>
              )}
            </dl>

            <DialogFooter className="gap-2 sm:justify-between">
              <div className="flex gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={handleHeart}
                  aria-pressed={isFav}
                  aria-label={isFav ? `Remove ${entry.title} from My Waves` : `Save ${entry.title} to My Waves`}
                  className={cn(
                    'gap-1.5 transition-colors',
                    isFav && 'border-red-500/40 text-red-400 hover:border-red-500/60 hover:text-red-300',
                  )}
                >
                  <Heart
                    className={cn('h-4 w-4', isFav && 'fill-red-400 text-red-400')}
                    aria-hidden="true"
                  />
                  {isFav ? 'Saved' : 'My Waves'}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => void shareSpin(entry.elementKind, entry.title, entry.artist)}
                  aria-label={`Share ${entry.title}`}
                >
                  <Share2 aria-hidden="true" />
                  Share
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    onClose()
                    onNavigate('rights')
                  }}
                >
                  <ShieldCheck aria-hidden="true" />
                  Rights ledger
                </Button>
              </div>
              {requestable ? (
                <Button type="button" size="sm" onClick={handleRequest}>
                  <Flame aria-hidden="true" />
                  Request this track
                </Button>
              ) : (
                <span className="self-center text-xs text-muted-foreground">
                  Station content — not requestable
                </span>
              )}
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}

// -------------------------------------------------------- favorite heart btn

/**
 * FavoriteHeartButton — one heart, three surfaces (recent list, now-playing
 * overlay, track dialog). Filled red when saved; reveals on hover in the
 * recent list so the rows stay quiet.
 */
function FavoriteHeartButton({
  track,
  alwaysVisible = false,
}: {
  track: { id: string; title: string; artist: string; rightsId: string | null }
  alwaysVisible?: boolean
}) {
  const { ids, toggle } = useFavorites()
  const isFav = ids.has(track.id)
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      key={String(isFav)}
      onClick={() => {
        const added = toggle(track)
        if (added) {
          toast.success(`Saved to My Waves — “${track.title}”`, {
            description: 'We\'ll toast you when it hits the wheel.',
          })
        } else {
          toast(`Removed from My Waves`, { description: track.title })
        }
      }}
      aria-pressed={isFav}
      aria-label={isFav ? `Remove ${track.title} from My Waves` : `Save ${track.title} to My Waves`}
      className={cn(
        'h-7 w-7 shrink-0 text-muted-foreground transition-all hover:bg-red-500/10 hover:text-red-400 md:opacity-0 md:group-focus-within:opacity-100 md:group-hover:opacity-100',
        (isFav || alwaysVisible) && 'opacity-100 md:opacity-100',
      )}
    >
      <Heart
        className={cn('h-3.5 w-3.5', isFav && 'fill-red-400 text-red-400 animate-heart-pop')}
        aria-hidden="true"
      />
    </Button>
  )
}

// --------------------------------------------------------------------- main

export function OnAirSection({ onNavigate }: { onNavigate: (tab: string) => void }) {
  const { data, error, lastFetch } = useNowPlaying()
  const progress = useInterpolatedProgress(data, lastFetch)
  const [dialogEntry, setDialogEntry] = useState<QueueEntry | null>(null)

  return (
    <div className="space-y-6">
      <Hero data={data} npError={error} onNavigate={onNavigate} />

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <FadeIn delay={0.05} className="lg:col-span-2">
          <NowPlayingCard data={data} progress={progress} />
        </FadeIn>
        <FadeIn delay={0.1}>
          <UpNextCard data={data} onSelect={setDialogEntry} />
        </FadeIn>
      </div>

      <FadeIn delay={0.15}>
        <RecentlyPlayedCard trackKey={data?.current?.track?.id} onSelect={setDialogEntry} />
      </FadeIn>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <FadeIn delay={0.17} className="lg:col-span-2">
          <WaveChartCard />
        </FadeIn>
        <FadeIn delay={0.19}>
          <MyWavesCard />
        </FadeIn>
      </div>

      <FadeIn delay={0.2}>
        <RequestLine />
      </FadeIn>

      <FadeIn delay={0.22}>
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

      <TrackDialog
        entry={dialogEntry}
        onClose={() => setDialogEntry(null)}
        onNavigate={onNavigate}
      />
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

  // Reactive hero: the master-chain analyser writes --audio-level on this
  // element (~30fps, zero re-renders) and the glow layers read it via calc().
  const heroRef = useRef<HTMLElement | null>(null)
  useAudioLevel(heroRef, '--audio-level', isPlaying)

  const chips = [
    // Was hardcoded "128 kbps AAC". The live mount is MP3 at 128 kbps, and the
    // figure should come from what Icecast is actually publishing rather than
    // from a constant that happened to be half right.
    {
      icon: Gauge,
      label: data?.stream?.mounts?.[0]
        ? `${data.stream.mounts[0].bitrateKbps} kbps ${data.stream.encoder.toUpperCase()}`
        : 'bitrate unknown',
    },
    { icon: ShieldCheck, label: 'Rights-cleared library' },
    data?.daypart
      ? {
          icon: Sun,
          label: data.daypart.clean
            ? 'Clean Daypart · 6a–7p ET'
            : 'Open rotations · full library',
        }
      : { icon: Heart, label: 'Listener-supported' },
  ]

  return (
    <FadeIn>
      <section
        ref={heroRef}
        aria-label="Station introduction"
        className="relative overflow-hidden rounded-xl border border-border/60"
        style={{ '--audio-level': '0' } as CSSProperties}
      >
        {/* audio-reactive halo — breathes with the master-chain output while playing */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 -top-24 h-64"
          style={{
            background:
              'radial-gradient(60% 100% at 50% 100%, oklch(0.72 0.16 70 / 0.5) 0%, oklch(0.6 0.19 35 / 0.28) 45%, transparent 75%)',
            opacity: 'calc(0.1 + var(--audio-level, 0) * 0.85)',
            transform: 'scale(calc(1 + var(--audio-level, 0) * 0.08))',
            transformOrigin: '50% 100%',
            transition: 'opacity 90ms linear',
            filter: 'blur(6px)',
          }}
        />
        <Image
          src="/station-hero.jpg"
          alt="Inside the NCSound Radio broadcast studio"
          fill
          priority
          sizes="(max-width: 1280px) 100vw, 1280px"
          className="object-cover opacity-60"
        />
        <div
          className="absolute inset-0 bg-gradient-to-r from-background via-background/70 to-background/30"
          aria-hidden="true"
        />
        {/* broadcast grain — keeps the photo from banding on dark surfaces */}
        <div className="bg-noise absolute inset-0 opacity-[0.06]" aria-hidden="true" />
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
              NCSound Radio
            </h1>
            <OnAirPill mode={data?.mode} />
          </div>

          <p className="mt-4 max-w-xl text-lg text-muted-foreground">
            The Carolinas&rsquo; independent hip-hop signal.
          </p>

          {/* Say why the station is dark. Silence with a pulsing "On Air" or an
              unexplained blank page is how an outage turns into a mystery. */}
          {data?.mode !== 'live' && (
            <div className="mt-4 max-w-xl rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
              {data?.mode === 'standby' ? (
                <>
                  The engine is up but has nothing loaded. It is not broadcasting
                  yet.
                </>
              ) : data ? (
                <>The DJ engine is not reachable, so the station is off air.</>
              ) : (
                <>Connecting to the station feed…</>
              )}
              {data?.offlineReason && (
                <span className="ml-1 font-mono text-xs opacity-80">
                  ({data.offlineReason})
                </span>
              )}
            </div>
          )}

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
            <Button
              type="button"
              size="lg"
              variant="ghost"
              className="h-11 px-4"
              onClick={async () => {
                const result = await shareStation()
                if (result === 'copied') {
                  toast.success('Stream link copied — pass it on.')
                } else if (result === 'failed') {
                  toast.error('Could not share — copy ncsound.fm from the address bar.')
                }
              }}
            >
              <Share2 aria-hidden="true" />
              Share
            </Button>
          </div>

          <p className="mt-4 flex items-center gap-2 text-sm text-muted-foreground" aria-live="polite">
            <span className="animate-pulse h-2 w-2 rounded-full bg-red-500" aria-hidden="true" />
            {npError
              ? 'Listener feed reconnecting…'
              : data?.listeners.current == null
                ? 'Listeners unknown — engine unreachable'
                : `${data.listeners.current.toLocaleString()} tuned in right now`}
          </p>
        </div>
      </section>
    </FadeIn>
  )
}

// -------------------------------------------------------------- now playing

function NowPlayingCard({ data, progress }: { data: NowPlayingResponse | null; progress: number }) {
  const isPlaying = useStationPlayer((s) => s.isPlaying)
  const track = data?.current?.track
  const duration = data?.current?.duration ?? 0
  const remaining = Math.max(0, duration - progress * duration)
  const hue = track ? hueForRightsId(track.rightsId) : 32
  const kind = data?.element?.kind ?? 'MUSIC'
  const isSponsorSpot = kind === 'AD_SPOT' && Boolean(data?.element?.sponsorName)
  const isHousePromo = kind === 'AD_SPOT' && !data?.element?.sponsorName
  const isTalk = kind === 'TALK'
  // Use the label the route actually sends. This used to hardcode
  // "explicit lyrics held until 7:00 PM ET", a daypart policy the station does
  // not implement and cannot report.
  const daypartNote = data?.daypart?.label ?? 'Autopilot sequencing — rights gate enforced'

  return (
    <Card
      className={cn(
        'border-border/60 bg-card/70 transition-shadow duration-500',
      )}
    >
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2 text-base font-semibold">
          <Disc3
            className={cn('h-4 w-4 text-primary', isPlaying && 'animate-vinyl')}
            aria-hidden="true"
          />
          Now Playing
        </CardTitle>
        <CardDescription>{daypartNote}</CardDescription>
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
              priority
              sizes="(max-width: 1024px) 100vw, 768px"
              className="object-cover"
            />
            {/* element wash: music = deterministic hue · ID = neutral · ad = amber/red */}
            <div
              className="absolute inset-0"
              style={{
                backgroundColor: isSponsorSpot
                  ? 'oklch(0.62 0.17 40 / 0.68)'
                  : isHousePromo
                    ? 'oklch(0.35 0.03 80 / 0.82)'
                    : kind === 'STATION_ID'
                      ? 'oklch(0.42 0.02 80 / 0.78)'
                      : isTalk
                        ? 'oklch(0.5 0.12 70 / 0.6)'
                        : `oklch(0.55 0.19 ${hue} / 0.55)`,
              }}
              aria-hidden="true"
            />
            <div
              className="absolute inset-0 bg-gradient-to-t from-background/95 via-background/30 to-background/10"
              aria-hidden="true"
            />
            <div className="bg-noise absolute inset-0 opacity-[0.05]" aria-hidden="true" />

            {/* element stamp */}
            {kind !== 'MUSIC' && (
              <div className="absolute right-3 top-3 flex items-center gap-1.5">
                {isSponsorSpot ? (
                  <span className="inline-flex items-center gap-1 rounded-sm border border-red-400/50 bg-red-500/25 px-2 py-1 text-[10px] font-extrabold uppercase tracking-[0.18em] text-red-100 backdrop-blur">
                    <Megaphone className="h-3 w-3" aria-hidden="true" />
                    Ad Break
                  </span>
                ) : isHousePromo ? (
                  <span className="inline-flex items-center gap-1 rounded-sm border border-border/60 bg-background/70 px-2 py-1 text-[10px] font-extrabold uppercase tracking-[0.18em] text-muted-foreground backdrop-blur">
                    <Megaphone className="h-3 w-3" aria-hidden="true" />
                    House Promo
                  </span>
                ) : isTalk ? (
                  <span className="inline-flex items-center gap-1 rounded-sm border border-amber-400/50 bg-amber-500/25 px-2 py-1 text-[10px] font-extrabold uppercase tracking-[0.18em] text-amber-100 backdrop-blur">
                    <MessageSquareQuote className="h-3 w-3" aria-hidden="true" />
                    Spotlight
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1 rounded-sm border border-primary/50 bg-primary/20 px-2 py-1 text-[10px] font-extrabold uppercase tracking-[0.18em] text-primary backdrop-blur">
                    <Mic className="h-3 w-3" aria-hidden="true" />
                    Station ID
                  </span>
                )}
              </div>
            )}

            {/* metadata chips */}
            <div className="absolute left-3 top-3 flex flex-wrap gap-1.5">
              {kind === 'MUSIC' && (
                <>
                  <Badge
                    variant="outline"
                    className="border-border/70 bg-background/70 text-[10px] backdrop-blur"
                  >
                    {track.playlist}
                  </Badge>
                  {track.rightsId && (
                    <span className="rounded border border-border/70 bg-background/70 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground backdrop-blur">
                      {track.rightsId}
                    </span>
                  )}
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
                </>
              )}
              {kind === 'STATION_ID' && track.rightsId && (
                <span className="rounded border border-border/70 bg-background/70 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground backdrop-blur">
                  {track.rightsId}
                </span>
              )}
              {isTalk && (
                <span className="rounded border border-amber-400/50 bg-background/70 px-1.5 py-0.5 text-[10px] font-semibold text-amber-500 backdrop-blur">
                  Produced in-house · talk segment
                </span>
              )}
              {isSponsorSpot && (
                <span className="rounded border border-border/70 bg-background/70 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground backdrop-blur">
                  ADSPOT · proof-of-play logged
                </span>
              )}
            </div>

            {/* big spectrum strip along the bottom — REAL audio: driven by the
                studio-preview synth's master-chain analyser, not a keyframe */}
            <div
              className="pointer-events-none absolute inset-x-0 bottom-0 h-12 px-6 pb-1 opacity-80 sm:h-14"
              aria-hidden="true"
            >
              {/* The station being on air, not this browser playing audio. */}
      <SpectrumCanvas onAir={data?.mode === 'live'} bars={40} />
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
                  {kind === 'MUSIC' ? (
                    <>
                      <h3 className="truncate text-2xl font-bold">{track.title}</h3>
                      <p className="truncate text-sm text-muted-foreground">{track.artist}</p>
                    </>
                  ) : isSponsorSpot ? (
                    <>
                      <h3 className="truncate text-2xl font-bold">
                        {data?.element?.sponsorName}
                      </h3>
                      <p className="truncate text-sm text-muted-foreground">
                        {data?.element?.creativeName} — paid sponsor spot
                      </p>
                    </>
                  ) : isHousePromo ? (
                    <>
                      <h3 className="truncate text-2xl font-bold">House Promo</h3>
                      <p className="truncate text-sm text-muted-foreground">
                        {data?.element?.creativeName ?? 'Unsold inventory — your brand could be here'}
                      </p>
                    </>
                  ) : isTalk ? (
                    <>
                      <h3 className="truncate text-xl font-bold">Spotlight</h3>
                      <p className="truncate text-sm text-muted-foreground">{track.title}</p>
                    </>
                  ) : (
                    <>
                      <h3 className="truncate text-xl font-bold">{track.title}</h3>
                      <p className="truncate text-sm text-muted-foreground">{track.artist}</p>
                    </>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  {kind === 'MUSIC' && <FavoriteHeartButton track={track} alwaysVisible />}
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    onClick={() => void shareSpin(kind, track.title, track.artist)}
                    aria-label={
                      kind === 'MUSIC'
                        ? `Share “${track.title}” by ${track.artist}`
                        : 'Share the station'
                    }
                    title={kind === 'MUSIC' ? 'Share this spin' : 'Share the station'}
                    className="h-7 w-7 shrink-0 text-muted-foreground transition-all hover:bg-primary/10 hover:text-primary"
                  >
                    <Share2 className="h-3.5 w-3.5" aria-hidden="true" />
                  </Button>
                  <span className="font-mono text-xs text-muted-foreground">
                    -{fmtTime(remaining)}
                  </span>
                </div>
              </div>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

// ----------------------------------------------------------------- up next

function UpNextCard({
  data,
  onSelect,
}: {
  data: NowPlayingResponse | null
  onSelect: (entry: QueueEntry) => void
}) {
  const duration = data?.current?.duration ?? 0
  const remaining = data?.current?.remaining ?? 0
  const toNextPct = duration > 0 ? Math.min(100, Math.max(0, ((duration - remaining) / duration) * 100)) : 0
  const cueing = remaining <= 0
  const elProgress = duration > 0 ? Math.min(1, Math.max(0, (duration - remaining) / duration)) : 0

  return (
    <Card className="border-border/60 bg-card/70">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base font-semibold">
          <ListMusic className="h-4 w-4 text-primary" aria-hidden="true" />
          Up Next
        </CardTitle>
        <CardDescription>
          Autopilot queue. The ring is the current spin&rsquo;s progress, not a
          music/IDs/ad-break program clock — the station schedules no IDs or ad
          breaks.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {/* ring + countdown for the spin in progress */}
        <div className="flex items-center gap-3 rounded-md border border-border/50 bg-background/40 p-3">
          {data && Array.isArray(data.wheel) && data.wheel.length > 0 ? (
            <ProgramClockRing
              wheel={data.wheel}
              cycleIndex={data.cycleIndex ?? 0}
              progress={elProgress}
              size={76}
            />
          ) : null}
          <div className="min-w-0 flex-1">
            <div className="flex items-center justify-between text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              <span>{cueing ? 'Cueing up next…' : 'Next spin in'}</span>
              <span
                className={cn(
                  'font-mono',
                  cueing ? 'animate-pulse text-red-400' : 'text-primary',
                )}
              >
                ~{fmtTime(remaining)}
              </span>
            </div>
            <Progress
              value={toNextPct}
              className={cn('mt-1.5 h-1', cueing && 'animate-pulse')}
              aria-label="Time until the next element"
            />
            <p className="mt-1.5 truncate text-[10px] text-muted-foreground">
              {data?.current
              ? `This spin is ${Math.round(data.current.progress * 100)}% through · ${fmtTime(remaining)} left`
              : 'Waiting on the engine…'}
            </p>
          </div>
        </div>

        {!data ? (
          <div className="space-y-2">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-12 w-full rounded-md" />
            ))}
          </div>
        ) : data.next.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">Queue is empty.</p>
        ) : (
          <div className="space-y-1">
            {data.next.map((t, i) => {
              const heat = data.heat?.[t.id] ?? 0
              const requesters = data.requestedBy?.[t.id] ?? []
              const isId = t.elementKind === 'STATION_ID'
              const isAd = t.elementKind === 'AD_SPOT'
              const isTalk = t.elementKind === 'TALK'
              const isPseudo = isAd || t.id.startsWith('adspot-') || t.id.startsWith('fallback-')
              const RowTag = isPseudo ? 'div' : 'button'
              return (
                <RowTag
                  key={`${t.id}-${i}`}
                  {...(isPseudo
                    ? {}
                    : {
                        type: 'button' as const,
                        onClick: () => onSelect(t),
                        'aria-label': `Details for ${t.title}`,
                      })}
                  className={cn(
                    'flex w-full items-start gap-3 rounded-md border border-transparent px-2 py-2 text-left transition-colors hover:border-border hover:bg-accent/40',
                    isAd && 'bg-red-500/[0.04]',
                    (isId || isTalk) && 'border-dashed border-border/60 bg-background/30',
                  )}
                >
                  <span
                    className={cn(
                      'flex h-6 w-6 shrink-0 items-center justify-center rounded border font-mono text-[10px]',
                      isAd
                        ? 'border-red-500/40 bg-red-500/10 text-red-400'
                        : isId
                          ? 'border-primary/40 bg-primary/10 text-primary'
                          : isTalk
                            ? 'border-amber-500/40 bg-amber-500/10 text-amber-500'
                            : 'border-border bg-background/60 text-muted-foreground',
                    )}
                  >
                    {isAd ? (
                      <Megaphone className="h-3 w-3" aria-hidden="true" />
                    ) : isId ? (
                      <Mic className="h-3 w-3" aria-hidden="true" />
                    ) : isTalk ? (
                      <MessageSquareQuote className="h-3 w-3" aria-hidden="true" />
                    ) : (
                      i + 1
                    )}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p
                      className={cn(
                        'truncate text-sm font-medium',
                        isAd && 'text-red-300',
                      )}
                    >
                      {t.title}
                    </p>
                    <p className="truncate text-xs text-muted-foreground">{t.artist}</p>
                    {t.elementKind === 'MUSIC' && requesters.length > 0 && (
                      <p className="mt-0.5 truncate text-[10px] text-amber-500/90">
                        shouted by {requesters.map((n) => `@${n}`).join(', ')}
                      </p>
                    )}
                  </div>
                  {heat > 0 && (
                    <span
                      title={`${heat} listener request${heat === 1 ? '' : 's'} this week — hot tracks jump the wheel`}
                      className="inline-flex shrink-0 items-center gap-0.5 rounded border border-red-500/30 bg-red-500/10 px-1 py-0.5 text-[10px] font-bold text-red-400"
                    >
                      <Flame className="h-3 w-3" aria-hidden="true" />
                      {heat}
                    </span>
                  )}
                  <span className="shrink-0 font-mono text-xs text-muted-foreground">
                    {fmtTime(t.durationSec)}
                  </span>
                  <Badge
                    variant="outline"
                    className={cn(
                      'hidden shrink-0 border-border/70 text-[10px] font-medium text-muted-foreground sm:inline-flex',
                      isAd && 'border-red-500/30 text-red-400',
                      isTalk && 'border-amber-500/30 text-amber-500',
                    )}
                  >
                    {isAd
                      ? t.sponsorName
                        ? 'Sponsor Spot'
                        : 'House Promo'
                      : isTalk
                        ? 'Spotlight'
                        : t.playlist}
                  </Badge>
                </RowTag>
              )
            })}
          </div>
        )}
        <p className="text-[10px] leading-relaxed text-muted-foreground">
          Listener shouts bump the hottest tracks up the wheel — station IDs, spotlight segments
          and ad breaks air between blocks, per the program clock.
        </p>
      </CardContent>
    </Card>
  )
}

// --------------------------------------------------------- recently played

function RecentlyPlayedCard({
  trackKey,
  onSelect,
}: {
  trackKey?: string
  onSelect: (entry: QueueEntry) => void
}) {
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
            {data.plays.map((play, idx) => (
              <li
                key={play.id}
                className={cn(
                  'group flex items-center gap-3 rounded-md px-2 py-2 transition-colors hover:bg-accent/40',
                  idx === 0 &&
                    'border-l-2 border-primary bg-gradient-to-r from-primary/10 to-transparent hover:from-primary/15'
                )}
              >
                <button
                  type="button"
                  onClick={() =>
                    onSelect({
                      ...play.track,
                      elementKind: 'MUSIC',
                      sponsorName: null,
                    })
                  }
                  aria-label={`Details for ${play.track.title}`}
                  className="flex min-w-0 flex-1 items-center gap-3 rounded-md text-left"
                >
                  <span
                    aria-hidden="true"
                    className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-primary/20 bg-gradient-to-br from-primary/30 via-primary/15 to-red-500/20 text-sm font-bold text-primary transition-transform group-hover:scale-105"
                  >
                    {(play.track.title.charAt(0) || '?').toUpperCase()}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">
                      {play.track.title}
                      {idx === 0 && (
                        <span className="ml-2 rounded-sm bg-primary/15 px-1 py-0.5 align-middle text-[9px] font-bold uppercase tracking-wider text-primary">
                          Last spin
                        </span>
                      )}
                    </p>
                    <p className="truncate text-xs text-muted-foreground">{play.track.artist}</p>
                  </div>
                </button>
                <FavoriteHeartButton track={play.track} />
                <Badge
                  variant="outline"
                  className="hidden shrink-0 border-border/70 text-[10px] text-muted-foreground md:inline-flex"
                >
                  {play.track.playlist}
                </Badge>
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

/**
 * Stat display that distinguishes "zero" from "not measured".
 *
 * The default format was Math.round(n), which silently turns null into 0 - so
 * a station whose engine was down displayed a confident "0 listeners" instead
 * of admitting it did not know. An em dash is the honest rendering.
 */
function AnimatedStat({
  value,
  format = (n: number) => Math.round(n).toLocaleString(),
}: {
  value: number | null
  format?: (n: number) => string
}) {
  if (value == null) return <>—</>
  const animated = useCountUp(value)
  return <>{format(animated)}</>
}

function StatsStrip() {
  const { data, error, retry } = useJson<StatsResponse>('/api/stats')
  const { data: listenerHistory } = useJson<ListenersHistoryResponse>('/api/listeners/history')
  const trend = listenerHistory ? listenerHistory.points.map((p) => p.v) : []

  // Describe the window honestly instead of assuming a full day.
  const trendLabel = !listenerHistory
    ? 'connecting…'
    : listenerHistory.points.length === 0
      ? 'no samples yet'
      : listenerHistory.partial
        ? `${listenerHistory.points.length} sample${listenerHistory.points.length === 1 ? '' : 's'} since ${listenerHistory.recordedSince ? new Date(listenerHistory.recordedSince).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }) : 'start'}`
        : 'last 24h'

  const tiles = data
    ? [
        {
          icon: Users,
          label: 'Listeners Now',
          value: <AnimatedStat value={data.listeners.current} />,
          // The series is real Icecast samples and only covers the life of the
          // ingest process. Labelling a two-point series "last 24h" made a
          // handful of samples look like a day of measurement.
          sub: trendLabel,
          spark: true,
        },
        {
          icon: TrendingUp,
          label: 'Peak Recorded',
          value: <AnimatedStat value={data.listeners.peak24h} />,
          sub: 'Icecast high-water mark',
          spark: false,
        },
        {
          icon: ShieldCheck,
          label: 'Cleared Tracks',
          value: (
            <>
              <AnimatedStat value={data.library.cleared} />/{data.library.tracks}
            </>
          ),
          sub: 'every spin rights-checked',
          spark: false,
        },
        {
          icon: Disc3,
          label: 'Programming',
          value: <AnimatedStat value={data.library.totalHours} format={(n) => `${n.toFixed(1)} hrs`} />,
          sub: 'on the AutoDJ wheel',
          spark: false,
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
          <div
            key={tile.label}
            className="card-glow flex flex-col rounded-xl border border-border/60 bg-card/60 p-4 transition-shadow"
          >
            <div className="flex items-center gap-1.5 text-xs uppercase tracking-wide text-muted-foreground">
              <tile.icon className="h-3.5 w-3.5 text-primary" aria-hidden="true" />
              {tile.label}
            </div>
            <p className="mt-2 break-words text-2xl font-bold text-primary">{tile.value}</p>
            <div className="mt-auto border-t border-border/40 pt-2">
              {tile.spark ? (
                trend.length > 1 ? (
                  <Sparkline
                    values={trend}
                    width={220}
                    height={36}
                    className="h-9 w-full"
                    ariaLabel={`Listener samples: ${trendLabel}`}
                  />
                ) : (
                  // A skeleton here was a terminal state: with fewer than two
                  // real samples the tile shimmered forever, implying data was
                  // still arriving when in fact none had been recorded yet.
                  <p className="py-2 text-[10px] uppercase tracking-wide text-muted-foreground/70">
                    {trendLabel}
                  </p>
                )
              ) : null}
              <p className="mt-1 text-[10px] text-muted-foreground">{tile.sub}</p>
            </div>
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
          <div className="relative min-w-0 flex-1 overflow-hidden" aria-label="Current sponsors">
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
