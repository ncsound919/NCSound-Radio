import { describe, expect, test } from 'bun:test'
import {
  computeOnAir,
  etDayStartUTC,
  etOffsetMinutes,
  etWallClock,
  stringHash,
} from '../src/lib/broadcast'

describe('America/New_York wall clock (DST-safe)', () => {
  test('EST in January is UTC-5', () => {
    const d = new Date('2026-01-15T05:00:00Z') // 00:00 ET
    expect(etOffsetMinutes(d)).toBe(-300)
    const wc = etWallClock(d)
    expect(wc.year).toBe(2026)
    expect(wc.month).toBe(1)
    expect(wc.day).toBe(15)
    expect(wc.hour).toBe(0)
    expect(wc.dayOfWeek).toBe(4) // Thursday
    expect(wc.weekdayShort).toBe('Thu')
  })

  test('EDT in July is UTC-4', () => {
    const d = new Date('2026-07-15T04:00:00Z') // 00:00 ET
    expect(etOffsetMinutes(d)).toBe(-240)
    const wc = etWallClock(d)
    expect(wc.month).toBe(7)
    expect(wc.day).toBe(15)
    expect(wc.hour).toBe(0)
  })

  test('etDayStartUTC returns local midnight as a UTC instant', () => {
    expect(etDayStartUTC(new Date('2026-01-15T17:00:00Z')).toISOString()).toBe('2026-01-15T05:00:00.000Z')
    expect(etDayStartUTC(new Date('2026-07-15T16:00:00Z')).toISOString()).toBe('2026-07-15T04:00:00.000Z')
  })
})

describe('computeOnAir (the rotation wheel)', () => {
  const ANCHOR = Date.UTC(2025, 0, 1)
  const elements = [{ durSec: 100 }, { durSec: 200 }]
  const cycleSec = 100 + 12 + 200 + 12 // durSec + TRACK_GAP_SEC(12) per element
  const at = (ms: number) => computeOnAir(elements as never, cycleSec, ANCHOR + ms)

  test('walks the wheel by duration + gap, and reports honest progress', () => {
    const start = at(0)
    expect(start.index).toBe(0)
    expect(start.elapsed).toBe(0)
    expect(start.remaining).toBe(100)
    expect(start.startedAt.toISOString()).toBe(new Date(ANCHOR).toISOString())

    const mid = at(50_000)
    expect(mid.index).toBe(0)
    expect(mid.elapsed).toBe(50)
    expect(mid.remaining).toBe(50)
    expect(mid.progress).toBeCloseTo(0.5, 5)
  })

  test('crosses into the next element at the slot boundary', () => {
    const boundary = at(112_000) // 100s + 12s gap
    expect(boundary.index).toBe(1)
    expect(boundary.elapsed).toBe(0)
    expect(boundary.startedAt.toISOString()).toBe(new Date(ANCHOR + 112_000).toISOString())

    const into = at(112_000 + 100_000)
    expect(into.index).toBe(1)
    expect(into.elapsed).toBe(100)
    expect(into.remaining).toBe(100)
  })

  test('wraps around at the cycle end', () => {
    expect(at(cycleSec * 1000).index).toBe(0)
    expect(at(cycleSec * 1000 * 3).elapsed).toBe(0)
  })

  test('an empty wheel or zero cycle throws rather than inventing a track', () => {
    expect(() => computeOnAir([] as never, 100, ANCHOR)).toThrow(/empty/i)
    expect(() => computeOnAir(elements as never, 0, ANCHOR)).toThrow(/empty/i)
  })
})

describe('stringHash', () => {
  test('is deterministic and spreads different inputs', () => {
    expect(stringHash('abc')).toBe(stringHash('abc'))
    expect(stringHash('abc')).not.toBe(stringHash('abd'))
    expect(Number.isFinite(stringHash('anything'))).toBe(true)
  })
})
