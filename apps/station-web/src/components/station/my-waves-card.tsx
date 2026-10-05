'use client'

/**
 * MyWavesCard — the listener's locally-kept favorites ("My Waves").
 * Hearts saved in this browser appear here with a live "On air now" pulse when
 * the AutoDJ lands on one of them (plus a one-shot toast per spin), a quick
 * request prefill, and an unheart. No account, no server round-trip.
 */

import { useEffect, useRef } from 'react'
import { motion } from 'framer-motion'
import { Flame, Heart, HeartOff, Radio, Waves } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { useFavorites, type FavoriteTrack } from '@/hooks/use-favorites'
import { useNowPlaying } from '@/hooks/use-nowplaying'
import { useStationPlayer } from '@/hooks/use-station-player'
import { REQUEST_PREFILL_EVENT } from '@/components/station/request-line'
import { cn } from '@/lib/utils'

export function MyWavesCard() {
  const { favorites, toggle } = useFavorites()
  const { data } = useNowPlaying()
  const isPlaying = useStationPlayer((s) => s.isPlaying)

  const currentTrack = data?.current?.track
  const currentId = currentTrack?.id
  const currentElementKind = data?.element?.kind ?? 'MUSIC'
  const currentRequestedBy = currentId ? (data?.requestedBy?.[currentId] ?? []) : []
  const heat = currentId ? (data?.heat?.[currentId] ?? 0) : 0

  // one-shot "your favorite is on air" toast per spin, only while tuned in
  const announcedRef = useRef<string | null>(null)
  useEffect(() => {
    if (!currentId || !isPlaying || currentElementKind !== 'MUSIC') return
    const hit = favorites.some((f) => f.id === currentId)
    if (hit && announcedRef.current !== currentId) {
      announcedRef.current = currentId
      toast.success(`My Waves — “${currentTrack?.title ?? ''}” is on air right now`, {
        description: `${currentTrack?.artist ?? ''} · one from your heart list, spinning live.`,
      })
    }
    if (!hit && announcedRef.current === currentId) {
      announcedRef.current = null
    }
  }, [currentId, currentElementKind, isPlaying, favorites, currentTrack])

  const handleRequest = (fav: FavoriteTrack) => {
    window.dispatchEvent(new CustomEvent(REQUEST_PREFILL_EVENT, { detail: { trackId: fav.id } }))
    toast.success(`“${fav.title}” is staged in the request line — add your name and send it.`)
    document.getElementById('request-line')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  const onAirNow = (fav: FavoriteTrack): boolean =>
    currentElementKind === 'MUSIC' && currentId === fav.id

  return (
    <Card
      className={cn(
        'hover-lift border-border/60 bg-card/70 transition-colors',
        favorites.length > 0 && onAirNowChip(favorites, currentId, currentElementKind) && 'border-red-500/40',
      )}
    >
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2 text-base font-semibold">
          <Heart
            className={cn('h-4 w-4', favorites.length > 0 ? 'fill-red-400/80 text-red-400' : 'text-primary')}
            aria-hidden="true"
          />
          My Waves
          {favorites.length > 0 && (
            <span className="rounded-sm bg-red-500/15 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-widest text-red-400">
              {favorites.length} saved
            </span>
          )}
        </CardTitle>
        <CardDescription>
          Your heart list — kept in this browser only, no account needed.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {favorites.length === 0 ? (
          <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border/60 bg-background/30 px-4 py-7 text-center">
            <Waves className="h-5 w-5 text-primary/60" aria-hidden="true" />
            <p className="text-sm text-muted-foreground">
              Tap the heart on any spin to build your station memory.
            </p>
            <p className="text-[11px] text-muted-foreground/70">
              We&apos;ll toast you the moment one of your favorites hits the wheel.
            </p>
          </div>
        ) : (
          <ul className="max-h-72 space-y-1.5 overflow-y-auto pr-1 scrollbar-thin" aria-label="Your favorite tracks">
            {favorites.map((fav, idx) => {
              const onAir = onAirNow(fav)
              return (
                <motion.li
                  key={fav.id}
                  layout
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.25, delay: Math.min(idx * 0.04, 0.3) }}
                  className={cn(
                    'group flex items-center gap-3 rounded-md border px-2.5 py-2 transition-colors',
                    onAir
                      ? 'border-red-500/40 bg-red-500/[0.07]'
                      : 'border-transparent hover:border-border hover:bg-accent/40',
                  )}
                >
                  <span
                    aria-hidden="true"
                    className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-red-500/20 bg-gradient-to-br from-red-500/25 via-primary/15 to-transparent"
                  >
                    <Heart className="h-4 w-4 fill-red-400/80 text-red-400" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="flex items-center gap-2 truncate text-sm font-medium">
                      {fav.title}
                      {onAir && (
                        <span className="inline-flex items-center gap-1 rounded-sm bg-red-500/20 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-red-300">
                          <span className="animate-onair h-1.5 w-1.5 rounded-full bg-red-500" aria-hidden="true" />
                          On air now
                        </span>
                      )}
                    </p>
                    <p className="truncate text-xs text-muted-foreground">
                      {fav.artist}
                      {fav.rightsId && (
                        <>
                          <span className="mx-1.5 text-border">·</span>
                          <span className="font-mono text-[10px]">{fav.rightsId}</span>
                        </>
                      )}
                      {onAir && heat > 0 && (
                        <span className="ml-1.5 inline-flex items-center gap-0.5 text-[10px] text-red-400">
                          <Flame className="h-3 w-3" aria-hidden="true" />
                          {heat} this week
                        </span>
                      )}
                    </p>
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className={cn(
                      'h-7 shrink-0 gap-1 px-2 text-[11px] text-primary hover:text-primary',
                      onAir && 'animate-pulse',
                    )}
                    onClick={() => handleRequest(fav)}
                    aria-label={`Request ${fav.title}`}
                  >
                    <Radio className="h-3 w-3" aria-hidden="true" />
                    Shout
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 shrink-0 text-muted-foreground opacity-60 transition-all hover:text-red-400 group-hover:opacity-100"
                    onClick={() => {
                      toggle(fav)
                      toast('Removed from My Waves', {
                        description: `${fav.title} — ${fav.artist}`,
                      })
                    }}
                    aria-label={`Remove ${fav.title} from favorites`}
                  >
                    <HeartOff className="h-3.5 w-3.5" aria-hidden="true" />
                  </Button>
                </motion.li>
              )
            })}
          </ul>
        )}
        {favorites.length > 0 && currentRequestedBy.length > 0 && onAirNowChip(favorites, currentId, currentElementKind) && (
          <p className="mt-2 text-[10px] text-amber-500/90">
            shouted by {currentRequestedBy.map((n) => `@${n}`).join(', ')}
          </p>
        )}
      </CardContent>
    </Card>
  )
}

function onAirNowChip(
  favorites: FavoriteTrack[],
  currentId: string | undefined,
  elementKind: string,
): boolean {
  return elementKind === 'MUSIC' && !!currentId && favorites.some((f) => f.id === currentId)
}
