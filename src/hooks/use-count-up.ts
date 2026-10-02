'use client'

/**
 * useCountUp — animates a number from its previous value to the new one
 * (requestAnimationFrame, ~500 ms ease-out). Respects prefers-reduced-motion
 * by snapping straight to the target. Used by the stats tiles so live numbers
 * "tick" like a broadcast console instead of hard-swapping.
 */

import { useEffect, useRef, useState } from 'react'

export function useCountUp(target: number, durationMs = 500): number {
  const [value, setValue] = useState(target)
  const fromRef = useRef(target)
  const rafRef = useRef(0)

  useEffect(() => {
    const from = fromRef.current
    if (from === target) return

    const reducedMotion =
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches

    // reduced motion animates over 0 ms — one rAF frame snaps to the target,
    // which also keeps setState out of the effect body
    const duration = reducedMotion ? 0 : durationMs

    const start = performance.now()
    const tick = (now: number) => {
      const t = duration === 0 ? 1 : Math.min(1, (now - start) / duration)
      const eased = 1 - Math.pow(1 - t, 3)
      setValue(from + (target - from) * eased)
      if (t < 1) {
        rafRef.current = requestAnimationFrame(tick)
      } else {
        fromRef.current = target
      }
    }
    rafRef.current = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(rafRef.current)
  }, [target, durationMs])

  return value
}
