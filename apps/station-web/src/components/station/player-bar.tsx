'use client'

import { useEffect, useRef, useState } from 'react'
import {
  Mic,
  Megaphone,
  MessageSquareQuote,
  Moon,
  Pause,
  Play,
  Radio,
  Share2,
  SignalHigh,
  SignalLow,
  Timer,
  Volume2,
  VolumeX,
} from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Progress } from '@/components/ui/progress'
import { Slider } from '@/components/ui/slider'
import { useNowPlaying } from '@/hooks/use-nowplaying'
import { useStationPlayer, type StreamQuality } from '@/hooks/use-station-player'
import { shareNowPlaying, shareStation } from '@/lib/share'
import { cn } from '@/lib/utils'

function fmtTime(sec: number): string {
  const s = Math.max(0, Math.round(sec))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

function fmtSleepCountdown(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
    : `${m}:${String(sec).padStart(2, '0')}`
}

export function PlayerBar() {
  const { data, lastFetch } = useNowPlaying()
  const isPlaying = useStationPlayer((s) => s.isPlaying)
  const volume = useStationPlayer((s) => s.volume)
  const previewSynth = useStationPlayer((s) => s.previewSynth)
  const quality = useStationPlayer((s) => s.quality)
  const setQuality = useStationPlayer((s) => s.setQuality)
  const toggle = useStationPlayer((s) => s.toggle)
  const setVolume = useStationPlayer((s) => s.setVolume)
  const sleepEndsAt = useStationPlayer((s) => s.sleepEndsAt)
  const sleepMode = useStationPlayer((s) => s.sleepMode)
  const setSleepTimer = useStationPlayer((s) => s.setSleepTimer)
  const setSleepEndOfTrack = useStationPlayer((s) => s.setSleepEndOfTrack)
  const expireSleep = useStationPlayer((s) => s.expireSleep)
  const checkTrackEndSleep = useStationPlayer((s) => s.checkTrackEndSleep)
  const sleepArmed = sleepMode === 'end-of-track' || sleepEndsAt !== null

  // Local one-second ticker so the progress bar moves smoothly between polls.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])

  const lastVolumeRef = useRef(0.8)
  const muted = volume === 0

  const current = data?.current
  const elementKind = data?.element?.kind ?? 'MUSIC'
  const duration = current?.duration ?? 0
  const progress =
    current && lastFetch > 0 && duration > 0
      ? Math.min(1, Math.max(0, current.progress + (now - lastFetch) / 1000 / duration))
      : 0
  const elapsed = progress * duration
  const remaining = Math.max(0, duration - elapsed)

  const track = current?.track
  const upNext = data?.next?.[0]
  const liveShow = data?.liveShow ?? null

  // Sleep-timer countdown + expiry (driven off the same 1s ticker as the progress bar).
  const sleepRemainingMs = sleepEndsAt ? Math.max(0, sleepEndsAt - now) : 0
  useEffect(() => {
    if (!sleepEndsAt || now < sleepEndsAt) return
    expireSleep()
    toast('Sleep timer — good night.', {
      description: 'The stream faded out on schedule. Tune back in anytime.',
    })
  }, [now, sleepEndsAt, expireSleep])

  // End-of-track sleep mode: watch the on-air spin's remaining time each tick;
  // the store decides when the fade begins (just before the gap).
  useEffect(() => {
    if (sleepMode !== 'end-of-track' || !isPlaying || !current) return
    checkTrackEndSleep(remaining)
  }, [now, sleepMode, isPlaying, current, remaining, checkTrackEndSleep])

  const handleSetSleep = (minutes: number | null) => {
    setSleepTimer(minutes)
    if (minutes === null) {
      toast('Sleep timer off.')
    } else {
      const at = new Date(Date.now() + minutes * 60_000).toLocaleTimeString([], {
        hour: 'numeric',
        minute: '2-digit',
      })
      toast(`Sleep timer set — fading out at ${at}.`, {
        description: `${minutes} minutes of waves left, then quiet.`,
      })
    }
  }

  const handleSleepEndOfTrack = () => {
    setSleepEndOfTrack()
    toast('Sleep timer — after this track.', {
      description: 'The stream will fade when this spin ends, right on the gap.',
    })
  }

  const handleMute = () => {
    if (muted) {
      setVolume(lastVolumeRef.current || 0.8)
    } else {
      lastVolumeRef.current = volume
      setVolume(0)
    }
  }

  const handleShare = async () => {
    // Music on air → share the track itself; imaging/ad/talk → share the station.
    const isMusic = elementKind === 'MUSIC' && !!track
    const result = isMusic
      ? await shareNowPlaying(track!.title, track!.artist)
      : await shareStation()
    if (result === 'copied') {
      toast.success(
        isMusic
          ? `“${track!.title}” shout-out copied — pass it on.`
          : 'Stream link copied — pass it on.',
      )
    } else if (result === 'failed') {
      toast.error('Could not share — copy ncsound.fm from the address bar.')
    }
  }

  // OS media controls (lock screen / media keys): advertise the on-air track
  // and wire the hardware play/pause buttons to the station store.
  useEffect(() => {
    if (typeof navigator === 'undefined' || !('mediaSession' in navigator) || !track) return
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: track.title,
        artist: track.artist,
        album: 'NCSound Radio — NCSound Radio',
        artwork: [{ src: '/station-logo.png', sizes: '1024x1024', type: 'image/png' }],
      })
    } catch {
      /* media session is best-effort */
    }
  }, [track])

  useEffect(() => {
    if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return
    try {
      navigator.mediaSession.playbackState = isPlaying ? 'playing' : 'paused'
      navigator.mediaSession.setActionHandler('play', () => {
        const s = useStationPlayer.getState()
        if (!s.isPlaying) s.toggle()
      })
      navigator.mediaSession.setActionHandler('pause', () => {
        const s = useStationPlayer.getState()
        if (s.isPlaying) s.toggle()
      })
    } catch {
      /* media session is best-effort */
    }
  }, [isPlaying])

  return (
    <section
      role="region"
      aria-label="Station player"
      className="fixed inset-x-0 bottom-0 z-50 border-t border-border/60 bg-background/90 pb-[env(safe-area-inset-bottom)] backdrop-blur"
    >
      <div className="mx-auto flex max-w-7xl items-center gap-3 px-4 py-2.5">
        {/* Play / Pause */}
        <Button
          type="button"
          size="lg"
          onClick={toggle}
          aria-label={isPlaying ? 'Pause stream' : 'Play stream'}
          className="h-10 w-10 shrink-0 rounded-full p-0"
        >
          {isPlaying ? (
            <Pause className="h-4 w-4 fill-current" aria-hidden="true" />
          ) : (
            <Play className="h-4 w-4 translate-x-[1px] fill-current" aria-hidden="true" />
          )}
        </Button>

        {/* Track block */}
        <div className="min-w-0 flex-1">
          {track ? (
            <>
              <p className="truncate text-sm font-medium leading-tight">
                {liveShow ? (
                  <span className="inline-flex items-center gap-1.5">
                    <span className="truncate">
                      {liveShow.kind === 'LIVE' ? 'LIVE — ' : ''}
                      {liveShow.name}
                    </span>
                    <span className="hidden shrink-0 text-xs font-normal text-muted-foreground sm:inline">
                      {liveShow.minutesLeft > 0 ? `· ${liveShow.minutesLeft}m left` : null}
                    </span>
                  </span>
                ) : elementKind === 'AD_SPOT' && data?.element?.sponsorName ? (
                  `AD — ${data.element.sponsorName}`
                ) : (
                  track.title
                )}
              </p>
              <p className="truncate text-xs leading-tight text-muted-foreground">
                {liveShow
                  ? `${liveShow.kind === 'LIVE' ? 'with' : 'hosted by'} ${liveShow.host}`
                  : elementKind === 'AD_SPOT'
                    ? (data?.element?.creativeName ?? track.artist)
                    : track.artist}
              </p>
              <div className="mt-1 flex items-center gap-1.5">
                {liveShow && (
                  <span
                    title={
                      liveShow.kind === 'LIVE'
                        ? 'Live show on the program grid'
                        : 'Scheduled show — AutoDJ continues underneath'
                    }
                    className={cn(
                      'inline-flex items-center gap-1 rounded border px-1.5 text-[10px] font-bold uppercase tracking-wider',
                      liveShow.kind === 'LIVE'
                        ? 'border-red-500/40 bg-red-500/10 text-red-400'
                        : 'border-primary/40 bg-primary/10 text-primary',
                    )}
                  >
                    <Radio className="h-2.5 w-2.5" aria-hidden="true" />
                    {liveShow.kind === 'LIVE' ? 'Live Show' : 'On Air'}
                  </span>
                )}
                {elementKind === 'STATION_ID' && (
                  <span
                    title="Station imaging — legal identification"
                    className="inline-flex items-center gap-1 rounded border border-primary/40 bg-primary/10 px-1.5 text-[10px] font-bold uppercase tracking-wider text-primary"
                  >
                    <Mic className="h-2.5 w-2.5" aria-hidden="true" />
                    Station ID
                  </span>
                )}
                {elementKind === 'AD_SPOT' && (
                  <span
                    title={
                      data?.element?.campaignName
                        ? `Sponsor spot — ${data.element.campaignName}`
                        : 'Unsold inventory — house promo'
                    }
                    className="inline-flex items-center gap-1 rounded border border-red-500/40 bg-red-500/10 px-1.5 text-[10px] font-bold uppercase tracking-wider text-red-400"
                  >
                    <Megaphone className="h-2.5 w-2.5" aria-hidden="true" />
                    {data?.element?.sponsorName ? 'Sponsored' : 'Promo'}
                  </span>
                )}
                {elementKind === 'TALK' && (
                  <span
                    title="Produced talk / spotlight segment"
                    className="inline-flex items-center gap-1 rounded border border-amber-500/40 bg-amber-500/10 px-1.5 text-[10px] font-bold uppercase tracking-wider text-amber-500"
                  >
                    <MessageSquareQuote className="h-2.5 w-2.5" aria-hidden="true" />
                    Spotlight
                  </span>
                )}
                {elementKind === 'MUSIC' && (
                  <span className="inline-flex max-w-28 items-center truncate rounded border border-border/80 px-1.5 text-[10px] font-medium text-muted-foreground">
                    {track.playlist}
                  </span>
                )}
                {elementKind === 'MUSIC' && (
                  <span
                    title="Rights ledger ID"
                    className="rounded border border-border px-1 font-mono text-[10px] leading-4 text-muted-foreground"
                  >
                    {track.rightsId}
                  </span>
                )}
                {track.explicit && (
                  <span
                    title="Explicit lyrics"
                    className="rounded border border-red-500/40 bg-red-500/10 px-1 text-[10px] font-bold leading-4 text-red-400"
                  >
                    E
                  </span>
                )}
              </div>
            </>
          ) : (
            <>
              <p className="truncate text-sm font-medium leading-tight text-muted-foreground">
                Tuning the signal…
              </p>
              <p className="truncate text-xs leading-tight text-muted-foreground">
                NCSound Radio — NCSound Radio
              </p>
            </>
          )}
        </div>

        {/* Progress (hidden on very small screens) */}
        <div className="hidden w-40 shrink-0 flex-col gap-1 sm:flex">
          <Progress value={progress * 100} className="h-1.5" aria-label="Track progress" />
          <div className="flex items-center justify-between font-mono text-[10px] text-muted-foreground">
            <span>{current ? fmtTime(elapsed) : '--:--'}</span>
            <span>-{current ? fmtTime(remaining) : '--:--'}</span>
          </div>
        </div>

        {/* Equalizer — individual bars keep their CSS dance animation while the
            whole block breathes (scaleY) with the real broadcast level via the
            --audio-level var the hero's analyser loop publishes globally. */}
        <div
          className="flex h-4 shrink-0 items-end gap-[3px] will-change-transform"
          aria-hidden="true"
          style={
            isPlaying
              ? {
                  transform: 'scaleY(calc(0.55 + var(--audio-level, 0) * 0.6))',
                  transformOrigin: 'bottom',
                }
              : undefined
          }
        >
          {[0, 1, 2, 3, 4].map((i) => (
            <span
              key={i}
              className={cn('w-1 rounded-sm', isPlaying ? 'eq-bar h-4 bg-primary/80' : 'h-1 bg-primary/40')}
              style={isPlaying ? { animationDelay: `${(i * 0.13).toFixed(2)}s` } : undefined}
            />
          ))}
        </div>

        {/* Volume */}
        <div className="hidden items-center gap-1 sm:flex">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            onClick={handleMute}
            aria-label={muted ? 'Unmute' : 'Mute'}
          >
            {muted ? (
              <VolumeX className="h-4 w-4" aria-hidden="true" />
            ) : (
              <Volume2 className="h-4 w-4" aria-hidden="true" />
            )}
          </Button>
          <Slider
            value={[Math.round(volume * 100)]}
            onValueChange={(v) => setVolume((v[0] ?? 0) / 100)}
            max={100}
            step={1}
            aria-label="Volume"
            className="w-20"
          />
        </div>

        {/* Sleep timer */}
        <div className="flex shrink-0 items-center">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className={cn(
                  'h-8 w-8 shrink-0',
                  sleepArmed && 'text-primary hover:text-primary',
                )}
                aria-label={sleepArmed ? 'Sleep timer — active' : 'Sleep timer'}
                title="Sleep timer"
              >
                {sleepArmed ? (
                  <Timer className="h-4 w-4" aria-hidden="true" />
                ) : (
                  <Moon className="h-4 w-4" aria-hidden="true" />
                )}
              </Button>
            </DropdownMenuTrigger>
            {sleepEndsAt ? (
                <span
                  role="timer"
                  aria-label="Sleep timer countdown"
                  title="Sleep timer — click to change"
                  className="hidden h-5 cursor-pointer select-none items-center rounded-sm border border-primary/40 bg-primary/10 px-1.5 font-mono text-[10px] font-bold tabular-nums text-primary sm:inline-flex"
                >
                  {fmtSleepCountdown(sleepRemainingMs)}
                </span>
              ) : (
                sleepMode === 'end-of-track' && (
                  <span
                    role="timer"
                    aria-label={
                      current && isPlaying
                        ? `Sleep timer — after this track, about ${fmtTime(remaining)} left`
                        : 'Sleep timer — after this track'
                    }
                    title="Sleep timer — fades when this spin ends"
                    className="hidden h-5 cursor-pointer select-none items-center gap-1 rounded-sm border border-primary/40 bg-primary/10 px-1.5 text-[10px] font-bold uppercase tracking-wide text-primary sm:inline-flex"
                  >
                    track end
                    {current && isPlaying && (
                      <span className="font-mono tabular-nums normal-case tracking-normal">
                        {fmtTime(remaining)}
                      </span>
                    )}
                  </span>
                )
              )}
            <DropdownMenuContent align="end" className="w-52">
              <DropdownMenuLabel className="flex items-center gap-2 text-xs">
                <Moon className="h-3.5 w-3.5 text-primary" aria-hidden="true" />
                Sleep timer
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              {sleepEndsAt && (
                <div
                  className="px-2 pb-1.5 font-mono text-xs tabular-nums text-primary"
                  role="timer"
                  aria-live="off"
                >
                  Fading out in {fmtSleepCountdown(sleepRemainingMs)}
                </div>
              )}
              {sleepMode === 'end-of-track' && (
                <div
                  className="px-2 pb-1.5 text-xs font-semibold text-primary"
                  role="status"
                >
                  Fading at the end of this spin.
                  {current && isPlaying && (
                    <span className="ml-1 font-mono tabular-nums">
                      {fmtTime(remaining)} left
                    </span>
                  )}
                </div>
              )}
              {[15, 30, 45, 60, 90].map((m) => (
                <DropdownMenuItem
                  key={m}
                  onClick={() => handleSetSleep(m)}
                  className="justify-between text-xs"
                >
                  <span>{m} minutes</span>
                  <span className="text-[10px] text-muted-foreground">
                    {m >= 60
                      ? `${Math.floor(m / 60)}h ${m % 60 ? `${m % 60}m` : ''}`.trim()
                      : `${m}m`}
                  </span>
                </DropdownMenuItem>
              ))}
              <DropdownMenuItem
                onClick={handleSleepEndOfTrack}
                disabled={!isPlaying}
                className="justify-between text-xs"
              >
                <span>End of current track</span>
                <span className="text-[10px] text-muted-foreground">this spin</span>
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onClick={() => handleSetSleep(null)}
                disabled={!sleepArmed}
                className="text-xs text-muted-foreground"
              >
                Turn off
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        {/* Share — the on-air track when music is spinning, the station otherwise */}
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="hidden h-8 w-8 md:inline-flex"
          onClick={handleShare}
          aria-label={
            elementKind === 'MUSIC' && track
              ? `Share “${track.title}” by ${track.artist}`
              : 'Share the station'
          }
          title={
            elementKind === 'MUSIC' && track
              ? `Share “${track.title}” by ${track.artist}`
              : 'Share the station'
          }
        >
          <Share2 className="h-4 w-4" aria-hidden="true" />
        </Button>

        {/* Studio preview badge */}
        {isPlaying && previewSynth && (
          <span
            title="Synth stand-in — connect AZURACAST_STREAM_URL for the live feed"
            className="hidden shrink-0 items-center gap-1 rounded border border-primary/40 bg-primary/10 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-primary lg:inline-flex"
          >
            Studio Preview
          </span>
        )}

        {/* Stream mount switcher — Mount 1 / Mount 2 from the stack plan */}
        <div
          role="group"
          aria-label="Stream quality"
          className="hidden shrink-0 items-center rounded-md border border-border/80 p-0.5 xl:flex"
        >
          {(
            [
              { id: 'hi' as StreamQuality, label: '128k', icon: SignalHigh, title: 'Mount 1 — 128 kbps AAC (full quality)' },
              { id: 'mobile' as StreamQuality, label: '64k', icon: SignalLow, title: 'Mount 2 — 64 kbps HE-AAC (data saver)' },
            ]
          ).map(({ id, label, icon: Icon, title }) => (
            <button
              key={id}
              type="button"
              title={title}
              aria-pressed={quality === id}
              onClick={() => setQuality(id)}
              className={cn(
                'flex h-6 items-center gap-1 rounded px-1.5 text-[10px] font-semibold transition-colors',
                quality === id
                  ? 'bg-primary/20 text-primary'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              <Icon className="h-3 w-3" aria-hidden="true" />
              {label}
            </button>
          ))}
        </div>

        {/* Broadcast state. This said LIVE unconditionally; it now reflects the
            reported mode so the transport bar cannot claim a live feed while
            the engine is down. */}
        <span className="flex shrink-0 items-center gap-1.5" aria-label="Broadcast state">
          {data?.mode === 'live' ? (
            <>
              <span className="animate-onair h-2 w-2 rounded-full bg-red-500" aria-hidden="true" />
              <span className="text-xs font-bold text-red-500">LIVE</span>
            </>
          ) : (
            <>
              <span className="h-2 w-2 rounded-full bg-muted-foreground" aria-hidden="true" />
              <span className="text-xs font-bold text-muted-foreground">
                {data?.mode === 'standby' ? 'STANDBY' : 'OFF AIR'}
              </span>
            </>
          )}
        </span>

        {/* Up next */}
        {upNext && (
          <span className="hidden max-w-44 shrink-0 truncate text-xs text-muted-foreground md:block">
            Next: {upNext.title} — {upNext.artist}
          </span>
        )}
      </div>
    </section>
  )
}
