'use client'

import type { WheelSlice } from '@/lib/station-types'
import { cn } from '@/lib/utils'

/**
 * ProgramClockRing — a compact SVG donut of the FULL AutoDJ program-clock
 * wheel (music blocks → station IDs → ad breaks → talk), with a sweep marker
 * showing exactly where the current pass is. Slot math mirrors the engine:
 * every element occupies durSec + a 12s inter-track gap.
 */

const TRACK_GAP_SEC = 12

/** Wheel-slice colors — amber/red/orange family only, never blue. */
const SLIDE_COLOR: Record<WheelSlice['kind'], string> = {
  MUSIC: '#f59e0b', // amber-500
  STATION_ID: '#a1a1aa', // zinc-400
  AD_SPOT: '#ef4444', // red-500
  TALK: '#f97316', // orange-500
}

const SLIDE_LABEL: Record<WheelSlice['kind'], string> = {
  MUSIC: 'Music block',
  STATION_ID: 'Station ID',
  AD_SPOT: 'Ad break',
  TALK: 'Spotlight',
}

export function ProgramClockRing({
  wheel,
  cycleIndex,
  progress,
  size = 84,
  className,
}: {
  wheel: WheelSlice[]
  cycleIndex: number
  /** 0..1 progress inside the current element. */
  progress: number
  size?: number
  className?: string
}) {
  const slots = wheel.map((s) => ({ ...s, slotSec: s.durSec + TRACK_GAP_SEC }))
  const totalSec = slots.reduce((acc, s) => acc + s.slotSec, 0)
  if (slots.length === 0 || totalSec <= 0) return null

  const stroke = Math.max(6, Math.round(size * 0.09))
  const r = (size - stroke) / 2
  const c = 2 * Math.PI * r
  const pad = Math.min(3, c * 0.004) // hairline gap between segments

  // Where the sweep marker sits: seconds through the pass.
  let cum = 0
  for (let i = 0; i < cycleIndex && i < slots.length; i++) cum += slots[i].slotSec
  const markerSec = cum + progress * (slots[Math.min(cycleIndex, slots.length - 1)]?.slotSec ?? 0)
  const markerAngle = (markerSec / totalSec) * 360
  const wheelPct = Math.round((markerSec / totalSec) * 100)

  const currentIdx = Math.min(cycleIndex, slots.length - 1)
  const current = slots[currentIdx]

  return (
    <div
      className={cn('relative shrink-0', className)}
      style={{ width: size, height: size }}
      role="img"
      aria-label={`Program clock wheel — element ${cycleIndex + 1} of ${slots.length}, ${wheelPct}% through the pass. Now airing: ${SLIDE_LABEL[current.kind]}.`}
    >
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        {/* faint track behind the segments */}
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke="currentColor"
          className="text-border/50"
          strokeWidth={stroke}
        />
        {slots.map((s, i) => {
          const frac = s.slotSec / totalSec
          const dash = Math.max(0, frac * c - pad)
          return (
            <circle
              key={i}
              cx={size / 2}
              cy={size / 2}
              r={r}
              fill="none"
              stroke={SLIDE_COLOR[s.kind]}
              strokeWidth={stroke}
              strokeDasharray={`${dash} ${c - dash}`}
              transform={`rotate(${(slots.slice(0, i).reduce((acc, p) => acc + p.slotSec, 0) / totalSec) * 360 - 90} ${size / 2} ${size / 2})`}
              opacity={i === cycleIndex ? 1 : 0.45}
              className="transition-opacity duration-700"
            >
              <title>{`${SLIDE_LABEL[s.kind]} — ${Math.round(s.durSec / 60) || 1} min slot`}</title>
            </circle>
          )
        })}
        {/* sweep marker — the broadcast needle (starts at 12 o'clock) */}
        <g
          style={{
            transform: `rotate(${markerAngle - 90}deg)`,
            transformOrigin: '50% 50%',
            transition: 'transform 1000ms linear',
          }}
        >
          <circle
            cx={size / 2}
            cy={size / 2 - r}
            r={stroke * 0.42}
            fill="#fafaf9"
            stroke="#0c0a09"
            strokeWidth={1}
          />
        </g>
      </svg>
      <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
        <span className="font-mono text-[11px] font-bold leading-none text-foreground/90 tabular-nums">
          {cycleIndex + 1}
          <span className="text-muted-foreground">/{slots.length}</span>
        </span>
        <span className="mt-0.5 text-[8px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
          wheel
        </span>
      </div>
    </div>
  )
}
