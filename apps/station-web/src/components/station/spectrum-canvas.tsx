'use client'

/**
 * SpectrumCanvas — spectrum visualiser for the Now Playing card.
 *
 * The bars come from the engine's master-bus analyser, polled with the rest of
 * the now-playing feed. They used to be read from a SynthEngine AnalyserNode
 * in the browser, which meant the visualiser animated a generated loop that was
 * never broadcast. Measuring at the engine shows the actual on-air signal.
 *
 * It cannot read the stream directly: Icecast sends no CORS headers, so a
 * cross-origin <audio> routed through Web Audio yields silence.
 *
 * The feed arrives every few seconds rather than every frame, so the displayed
 * bars ease toward each reading and hold between updates. That reads as a live
 * meter rather than a 40-bar stepper. When the station is off air the canvas
 * settles to a quiet floor, because that is the state of the signal.
 *
 * Amber→red gradient bars with peak-hold caps, DPR-aware, and it honours
 * prefers-reduced-motion (static frame, no rAF loop).
 */

import { useEffect, useRef } from 'react'
import { cn } from '@/lib/utils'
import { useNowPlaying } from '@/hooks/use-nowplaying'

const BARS = 40
const PEAK_DECAY = 0.008
const BAR_GAP = 2
/** How quickly the display eases toward a new reading, per frame. */
const EASE = 0.18

export function SpectrumCanvas({
  active,
  className,
  bars = BARS,
}: {
  active: boolean
  className?: string
  bars?: number
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const { data } = useNowPlaying()
  const spectrum = data?.engine?.spectrum

  // Hold the latest reading in a ref so the loop does not re-subscribe on
  // every poll.
  const spectrumRef = useRef<number[] | null>(null)
  spectrumRef.current = spectrum && spectrum.length > 0 ? spectrum : null

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const peaks = new Array<number>(bars).fill(0)
    const shown = new Array<number>(bars).fill(0)
    let raf = 0
    let disposed = false

    const reducedMotion =
      typeof window !== 'undefined' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches

    const resize = () => {
      const dpr = Math.min(2, window.devicePixelRatio || 1)
      const rect = canvas.getBoundingClientRect()
      canvas.width = Math.max(1, Math.floor(rect.width * dpr))
      canvas.height = Math.max(1, Math.floor(rect.height * dpr))
    }
    resize()

    const paint = (levels: number[]) => {
      const w = canvas.width
      const h = canvas.height
      ctx.clearRect(0, 0, w, h)
      const gap = BAR_GAP
      const bw = Math.max(1, (w - gap * (bars - 1)) / bars)
      for (let i = 0; i < bars; i += 1) {
        const v = Math.min(1, Math.max(0.015, levels[i] ?? 0))
        const bh = v * h
        const x = i * (bw + gap)
        const grad = ctx.createLinearGradient(0, h, 0, h - bh)
        grad.addColorStop(0, 'oklch(0.72 0.17 70 / 0.85)')
        grad.addColorStop(1, 'oklch(0.58 0.21 35 / 0.95)')
        ctx.fillStyle = grad
        ctx.fillRect(x, h - bh, bw, bh)

        const p = peaks[i] ?? 0
        peaks[i] = v > p ? v : Math.max(0, p - PEAK_DECAY)
        const py = h - Math.max(2, peaks[i] * h) - 1
        ctx.fillStyle = 'oklch(0.85 0.15 80 / 0.9)'
        ctx.fillRect(x, py, bw, 2)
      }
    }

    /** Fold the engine's spectrum bins into the bar layout. */
    const levelsFrom = (spectrum: number[]): number[] =>
      Array.from({ length: bars }, (_, i) => {
        const start = Math.floor((i * spectrum.length) / bars)
        const end = Math.max(start + 1, Math.floor(((i + 1) * spectrum.length) / bars))
        let sum = 0
        for (let j = start; j < end && j < spectrum.length; j += 1) sum += spectrum[j]
        const avg = sum / (end - start) / 255
        // Weight lows a touch so the kick reads, as the old analyser path did.
        return avg * (0.75 + (i / bars) * 0.5)
      })

    const idleLevels = (t: number) =>
      Array.from({ length: bars }, (_, i) =>
        reducedMotion ? 0.06 + 0.02 * Math.sin(i * 0.7) : 0.05 + 0.035 * (0.5 + 0.5 * Math.sin(t + i * 0.55)),
      )

    const loop = () => {
      raf = requestAnimationFrame(loop)
      const s = spectrumRef.current
      const target = s ? levelsFrom(s) : active ? idleLevels(Date.now() / 900) : new Array(bars).fill(0.02)
      for (let i = 0; i < bars; i += 1) {
        shown[i] += ((target[i] ?? 0) - (shown[i] ?? 0)) * EASE
      }
      paint(shown)
    }

    if (reducedMotion) {
      const s = spectrumRef.current
      paint(s ? levelsFrom(s) : idleLevels(0))
    } else {
      raf = requestAnimationFrame(loop)
    }

    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(resize) : null
    ro?.observe(canvas)

    return () => {
      disposed = true
      if (raf) cancelAnimationFrame(raf)
      ro?.disconnect()
      void disposed
    }
  }, [active, bars])

  return (
    <canvas
      ref={canvasRef}
      role="img"
      aria-label={
        active ? 'Live master-bus spectrum of the station output' : 'Signal idle — station not on air'
      }
      className={cn('h-full w-full', className)}
    />
  )
}