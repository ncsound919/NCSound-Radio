import { describe, expect, test } from 'bun:test'
import { isSlotOpen, minutesBetween, nextSlotWindow, slotWindowForDate } from '../src/lib/slots'

const thursday = { dayOfWeek: 4, startHour: 9, startMinute: 0, durationMin: 120 }

describe('slot windows (host/guest go-live credentials)', () => {
  test('a specific ET calendar date maps to the right UTC instant (EST)', () => {
    // Thu 2026-01-15 09:00 ET = 14:00Z; +120min = 16:00Z.
    const w = slotWindowForDate(thursday, 2026, 1, 15)
    expect(w.notBefore.toISOString()).toBe('2026-01-15T14:00:00.000Z')
    expect(w.notAfter.toISOString()).toBe('2026-01-15T16:00:00.000Z')
  })

  test('the same wall-clock slot in summer is an hour earlier in UTC (EDT)', () => {
    const w = slotWindowForDate(thursday, 2026, 7, 16)
    expect(w.notBefore.toISOString()).toBe('2026-07-16T13:00:00.000Z')
  })

  test('nextSlotWindow returns today’s slot while it is still upcoming or running', () => {
    const now = new Date('2026-01-15T12:00:00Z') // Thu 07:00 ET, before the 09:00 slot
    const w = nextSlotWindow(thursday, now)
    expect(w.notBefore.toISOString()).toBe('2026-01-15T14:00:00.000Z')
  })

  test('nextSlotWindow skips to the next matching weekday', () => {
    const wednesday = { dayOfWeek: 3, startHour: 9, startMinute: 0, durationMin: 120 }
    const now = new Date('2026-01-15T12:00:00Z') // Thursday
    const w = nextSlotWindow(wednesday, now)
    expect(w.notBefore.toISOString()).toBe('2026-01-21T14:00:00.000Z') // next Wed
  })

  test('isSlotOpen is inclusive of both ends', () => {
    const w = slotWindowForDate(thursday, 2026, 1, 15)
    expect(isSlotOpen(w, new Date('2026-01-15T13:59:59Z'))).toBe(false)
    expect(isSlotOpen(w, new Date('2026-01-15T14:00:00Z'))).toBe(true)
    expect(isSlotOpen(w, new Date('2026-01-15T16:00:00Z'))).toBe(true)
    expect(isSlotOpen(w, new Date('2026-01-15T16:00:01Z'))).toBe(false)
  })

  test('minutesBetween floors at zero for a reversed range', () => {
    const a = new Date('2026-01-15T14:00:00Z')
    const b = new Date('2026-01-15T15:30:30Z')
    expect(minutesBetween(a, b)).toBe(90)
    expect(minutesBetween(b, a)).toBe(0)
  })
})
