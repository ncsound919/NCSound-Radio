'use client'

/**
 * useAudioLevel — drives a CSS custom property (`--audio-level`, 0..1) on the
 * given element AND on `document.documentElement` so any surface can react to
 * the same signal without a second loop.
 *
 * The source is the engine's master-bus spectrum, polled with the rest of the
 * now-playing feed. It cannot come from the stream itself: Icecast sends no
 * CORS headers, so routing the cross-origin audio through a Web Audio
 * AnalyserNode produces silence. Measuring at the engine is both real and
 * unaffected by CORS.
 *
 * Because the spectrum arrives every few seconds rather than every frame, the
 * value is held and released smoothly instead of snapping, so surfaces breathe
 * rather than step. Zero React re-renders: the loop writes the style property
 * directly.
 *
 * No data yet (station offline) → the variable decays to rest, which is the
 * honest state for a station that is not transmitting.
 */

import { useEffect, useRef, type RefObject } from 'react'
import { useNowPlaying } from '@/hooks/use-nowplaying'

const WRITE_EVERY_N_FRAMES = 2
const RELEASE_SMOOTHING = 0.08
const ATTACK_SMOOTHING = 0.35

/** Mean of the engine's spectrum bins, 0..1. */
function levelFromSpectrum(spectrum: number[] | undefined): number | null {
  if (!spectrum || spectrum.length === 0) return null
  let sum = 0
  for (let i = 0; i < spectrum.length; i += 1) sum += spectrum[i]
  // Bin values are 0..255; scale so a loud master reads near 1.
  return Math.min(1, sum / spectrum.length / 150)
}

export function useAudioLevel(
  targetRef: RefObject<HTMLElement | null>,
  cssVar = '--audio-level',
  enabled = true,
): void {
  const { data } = useNowPlaying()
  const target = levelFromSpectrum(data?.engine?.spectrum)

  // Keep the latest reading in a ref so the rAF loop never closes over a stale
  // value without re-subscribing on every poll.
  const targetRef2 = useRef<number | null>(null)
  targetRef2.current = target

  useEffect(() => {
    if (!enabled || typeof window === 'undefined') return
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return

    let raf = 0
    let frame = 0
    let level = 0

    const write = (el: HTMLElement | null, value: number) => {
      const v = value.toFixed(3)
      el?.style.setProperty(cssVar, v)
      document.documentElement.style.setProperty(cssVar, v)
    }

    const tick = () => {
      raf = requestAnimationFrame(tick)
      frame += 1
      if (frame % WRITE_EVERY_N_FRAMES !== 0) return

      const el = targetRef.current
      if (!el) return

      const wanted = targetRef2.current
      if (wanted == null) {
        // Station offline or not reporting a level: decay to rest.
        if (level > 0.001) {
          level *= 0.85
          write(el, level)
        }
        return
      }

      const smoothing = wanted > level ? ATTACK_SMOOTHING : RELEASE_SMOOTHING
      level += (wanted - level) * smoothing
      write(el, level)
    }

    raf = requestAnimationFrame(tick)
    return () => {
      cancelAnimationFrame(raf)
      // Leave the surfaces at rest when the loop unmounts.
      try {
        targetRef.current?.style.setProperty(cssVar, '0')
        document.documentElement.style.setProperty(cssVar, '0')
      } catch {
        /* element gone */
      }
    }
  }, [targetRef, cssVar, enabled])
}