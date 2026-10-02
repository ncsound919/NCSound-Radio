'use client'

/**
 * SpectrumCanvas — real-time spectrum visualizer for the Now Playing card.
 *
 * Reads frequency data straight from the SynthEngine's master-chain
 * AnalyserNode (the same audio the listener hears), so the bars react to the
 * beat, the volume slider, and the studio-preview synth itself — not to a CSS
 * keyframe. Falls back to a calm idle floor when the engine is silent.
 *
 * Amber→red gradient bars with peak-hold caps, DPR-aware, and it honors
 * prefers-reduced-motion (static frames, no rAF loop).
 */

import { useEffect, useRef } from 'react'
import { cn } from '@/lib/utils'

const BARS = 40
const PEAK_DECAY = 0.008
const BAR_GAP = 2

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

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const peaks = new Array<number>(bars).fill(0)
    let raf = 0
    let disposed = false

    const reducedMotion =
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches

    const resize = () => {
      const dpr = Math.min(2, window.devicePixelRatio || 1)
      const rect = canvas.getBoundingClientRect()
      canvas.width = Math.max(1, Math.round(rect.width * dpr))
      canvas.height = Math.max(1, Math.round(rect.height * dpr))
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    }
    resize()

    const paint = (levels: number[]) => {
      const rect = canvas.getBoundingClientRect()
      const w = rect.width
      const h = rect.height
      ctx.clearRect(0, 0, w, h)

      const grad = ctx.createLinearGradient(0, h, 0, 0)
      grad.addColorStop(0, '#f59e0b') // amber floor
      grad.addColorStop(0.55, '#f97316') // orange mids
      grad.addColorStop(1, '#ef4444') // red caps

      const bw = Math.max(1, (w - BAR_GAP * (bars - 1)) / bars)
      for (let i = 0; i < bars; i++) {
        const level = Math.min(1, Math.max(0, levels[i] ?? 0))
        const bh = Math.max(2, level * (h - 4))
        const x = i * (bw + BAR_GAP)

        ctx.globalAlpha = 0.9
        ctx.fillStyle = grad
        ctx.fillRect(x, h - bh, bw, bh)

        // peak-hold cap, decaying each frame
        if (level > peaks[i]) peaks[i] = level
        const capH = Math.max(2, peaks[i] * (h - 4))
        ctx.globalAlpha = 0.55
        ctx.fillRect(x, h - capH - 3, bw, 2)
        peaks[i] = Math.max(0, peaks[i] - PEAK_DECAY)
      }
      ctx.globalAlpha = 1
    }

    /** Calm floor: gentle sine swell so the idle card still feels alive. */
    const idleLevels = (t: number) =>
      Array.from({ length: bars }, (_, i) =>
        reducedMotion ? 0.06 + 0.02 * Math.sin(i * 0.7) : 0.05 + 0.035 * (0.5 + 0.5 * Math.sin(t + i * 0.55)),
      )

    const paintIdle = () => paint(idleLevels(Date.now() / 900))

    const readEngineAnalyser = async (): Promise<AnalyserNode | null> => {
      try {
        const mod = await import('@/lib/synth-engine')
        const engine = mod.getSynthEngine()
        // start() builds the analyser asynchronously relative to the store's
        // isPlaying flip — poll briefly until the node exists.
        for (let attempt = 0; attempt < 25 && !disposed; attempt++) {
          const a = engine.getAnalyser()
          if (a) return a
          await new Promise((r) => setTimeout(r, 100))
        }
      } catch {
        /* engine never loaded — idle mode */
      }
      return null
    }

    const loop = (analyser: AnalyserNode | null, data: Uint8Array | null) => {
      raf = requestAnimationFrame(() => loop(analyser, data))
      if (analyser && data) {
        analyser.getByteFrequencyData(data as Uint8Array<ArrayBuffer>)
        // skip the empty top octaves; weight lows a touch so the kick reads
        const usable = Math.round(data.length * 0.72)
        const per = usable / bars
        const levels = Array.from({ length: bars }, (_, i) => {
          const start = Math.floor(i * per)
          const end = Math.max(start + 1, Math.floor((i + 1) * per))
          let sum = 0
          for (let j = start; j < end; j++) sum += data[j]
          const avg = sum / (end - start) / 255
          const weight = 0.75 + (i / bars) * 0.5
          return avg * weight
        })
        paint(levels)
      } else {
        paintIdle()
      }
    }

    if (reducedMotion) {
      // static frame(s): try one real spectrum read, else the quiet floor
      void (async () => {
        const a = await readEngineAnalyser()
        if (disposed) return
        if (a) {
          const data = new Uint8Array(a.frequencyBinCount)
          a.getByteFrequencyData(data as Uint8Array<ArrayBuffer>)
          const levels = Array.from(data, (v) => v / 255)
          paint(levels.length > bars ? levels.slice(0, bars) : levels)
        } else {
          paintIdle()
        }
      })()
    } else if (active) {
      void (async () => {
        const analyser = await readEngineAnalyser()
        if (disposed || !active) return
        const data = analyser ? new Uint8Array(analyser.frequencyBinCount) : null
        loop(analyser, data)
      })()
    } else {
      raf = requestAnimationFrame(function idleLoop() {
        raf = requestAnimationFrame(idleLoop)
        paintIdle()
      })
    }

    const ro =
      typeof ResizeObserver !== 'undefined'
        ? new ResizeObserver(() => {
            resize()
          })
        : null
    ro?.observe(canvas)

    return () => {
      disposed = true
      if (raf) cancelAnimationFrame(raf)
      ro?.disconnect()
    }
  }, [active, bars])

  return (
    <canvas
      ref={canvasRef}
      role="img"
      aria-label={active ? 'Live audio spectrum — reacting to the studio preview signal' : 'Signal idle'}
      className={cn('h-full w-full', className)}
    />
  )
}
