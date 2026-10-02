'use client'

import { useEffect, useRef, useState } from 'react'
import { Pause, Play, SignalHigh, SignalLow, Volume2, VolumeX } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { Slider } from '@/components/ui/slider'
import { useNowPlaying } from '@/hooks/use-nowplaying'
import { useStationPlayer, type StreamQuality } from '@/hooks/use-station-player'
import { cn } from '@/lib/utils'

function fmtTime(sec: number): string {
  const s = Math.max(0, Math.round(sec))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
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

  // Local one-second ticker so the progress bar moves smoothly between polls.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])

  const lastVolumeRef = useRef(0.8)
  const muted = volume === 0

  const current = data?.current
  const duration = current?.duration ?? 0
  const progress =
    current && lastFetch > 0 && duration > 0
      ? Math.min(1, Math.max(0, current.progress + (now - lastFetch) / 1000 / duration))
      : 0
  const elapsed = progress * duration
  const remaining = Math.max(0, duration - elapsed)

  const track = current?.track
  const upNext = data?.next?.[0]

  const handleMute = () => {
    if (muted) {
      setVolume(lastVolumeRef.current || 0.8)
    } else {
      lastVolumeRef.current = volume
      setVolume(0)
    }
  }

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
              <p className="truncate text-sm font-medium leading-tight">{track.title}</p>
              <p className="truncate text-xs leading-tight text-muted-foreground">{track.artist}</p>
              <div className="mt-1 flex items-center gap-1.5">
                <span className="inline-flex max-w-28 items-center truncate rounded border border-border/80 px-1.5 text-[10px] font-medium text-muted-foreground">
                  {track.playlist}
                </span>
                <span
                  title="Rights ledger ID"
                  className="rounded border border-border px-1 font-mono text-[10px] leading-4 text-muted-foreground"
                >
                  {track.rightsId}
                </span>
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
                WAVC 91.3 — Carolina Waves
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

        {/* Equalizer */}
        <div className="flex h-4 shrink-0 items-end gap-[3px]" aria-hidden="true">
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

        {/* LIVE */}
        <span className="flex shrink-0 items-center gap-1.5" aria-label="Live broadcast">
          <span className="animate-onair h-2 w-2 rounded-full bg-red-500" aria-hidden="true" />
          <span className="text-xs font-bold text-red-500">LIVE</span>
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
