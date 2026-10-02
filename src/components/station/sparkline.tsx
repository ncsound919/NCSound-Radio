'use client'

import { useMemo } from 'react'

/**
 * Lightweight SVG sparkline for listener-count trends.
 * Amber gradient area + 2px line, no axes — pure signal.
 */
export function Sparkline({
  values,
  width = 160,
  height = 40,
  className,
  ariaLabel,
}: {
  values: number[]
  width?: number
  height?: number
  className?: string
  ariaLabel?: string
}) {
  const gradId = useMemo(
    () => `spark-${Math.random().toString(36).slice(2, 8)}`,
    [],
  )

  const { linePath, areaPath, lastY } = useMemo(() => {
    if (values.length < 2) {
      return { linePath: '', areaPath: '', lastY: height / 2 }
    }
    const min = Math.min(...values)
    const max = Math.max(...values)
    const span = max - min || 1
    const pad = 2
    const usableH = height - pad * 2
    const stepX = width / (values.length - 1)

    const pts = values.map((v, i) => {
      const x = i * stepX
      const y = pad + usableH - ((v - min) / span) * usableH
      return [x, y] as const
    })

    const line = pts
      .map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`)
      .join(' ')
    const area = `${line} L${width},${height} L0,${height} Z`

    return { linePath: line, areaPath: area, lastY: pts[pts.length - 1][1] }
  }, [values, width, height])

  if (!linePath) {
    return (
      <svg
        role="img"
        aria-label={ariaLabel ?? 'Sparkline'}
        viewBox={`0 0 ${width} ${height}`}
        className={className}
      />
    )
  }

  return (
    <svg
      role="img"
      aria-label={ariaLabel ?? 'Sparkline'}
      viewBox={`0 0 ${width} ${height}`}
      className={className}
      preserveAspectRatio="none"
    >
      <defs>
        <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="oklch(0.77 0.16 70)" stopOpacity="0.35" />
          <stop offset="100%" stopColor="oklch(0.77 0.16 70)" stopOpacity="0.02" />
        </linearGradient>
      </defs>
      <path d={areaPath} fill={`url(#${gradId})`} />
      <path
        d={linePath}
        fill="none"
        stroke="oklch(0.77 0.16 70)"
        strokeWidth="1.75"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      <circle cx={width - 1} cy={lastY} r="2.4" fill="oklch(0.77 0.16 70)" />
    </svg>
  )
}
