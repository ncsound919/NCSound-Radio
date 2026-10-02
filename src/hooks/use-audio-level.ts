'use client'

/**
 * useAudioLevel — drives a CSS custom property (`--audio-level`, 0..1) on the
 * given element AND on `document.documentElement` (so the player bar, or any
 * other surface, can consume the same beat without a second rAF loop).
 *
 * Zero React re-renders: the loop writes the style property directly, rAF is
 * throttled to ~30 fps, and the level is attack-fast / release-slow smoothed
 * so the hero glow breathes with the beat instead of strobing.
 *
 * No analyser (engine never started / stopped) → the variable decays to 0.
 * Honors prefers-reduced-motion by never installing the loop at all.
 */

import { useEffect, type RefObject } from 'react'
import { getLoadedEngine } from '@/hooks/use-station-player'

const WRITE_EVERY_N_FRAMES = 2
const RELEASE_SMOOTHING = 0.08
const ATTACK_SMOOTHING = 0.35

export function useAudioLevel(
  targetRef: RefObject<HTMLElement | null>,
  cssVar = '--audio-level',
  enabled = true,
): void {
  useEffect(() => {
    if (!enabled || typeof window === 'undefined') return
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return

    let raf = 0
    let frame = 0
    let level = 0
    let buffer: Uint8Array<ArrayBuffer> | null = null
    let missFrames = 0 // frames without an analyser before we zero the var

    const tick = () => {
      raf = requestAnimationFrame(tick)
      frame += 1
      if (frame % WRITE_EVERY_N_FRAMES !== 0) return

      const analyser = getLoadedEngine()?.getAnalyser() ?? null
      const el = targetRef.current
      if (!el) return

      if (!analyser) {
        // Engine not running (yet). Poll patiently, decay to rest.
        missFrames += 1
        if (missFrames > 20 && level > 0.001) {
          level *= 0.85
          el.style.setProperty(cssVar, level.toFixed(3))
          document.documentElement.style.setProperty(cssVar, level.toFixed(3))
        }
        return
      }

      missFrames = 0
      try {
        if (!buffer || buffer.length !== analyser.frequencyBinCount) {
          buffer = new Uint8Array(new ArrayBuffer(analyser.frequencyBinCount))
        }
        analyser.getByteFrequencyData(buffer)
        let sum = 0
        for (let i = 0; i < buffer.length; i += 1) sum += buffer[i]
        const norm = Math.min(1, sum / buffer.length / 140)
        const smoothing = norm > level ? ATTACK_SMOOTHING : RELEASE_SMOOTHING
        level += (norm - level) * smoothing
        const value = level.toFixed(3)
        el.style.setProperty(cssVar, value)
        document.documentElement.style.setProperty(cssVar, value)
      } catch {
        /* analyser torn down mid-frame — try again next frame */
      }
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
