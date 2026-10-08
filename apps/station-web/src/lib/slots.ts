/**
 * Weekly show -> credential slot window (roadmap C5).
 *
 * A Show already carries its weekly slot (`dayOfWeek`, `startHour`,
 * `startMinute`, `durationMin`, America/New_York). This turns that into the
 * concrete `notBefore`/`notAfter` instants for the next occurrence, which is
 * what the engine's session slot window is bound to: outside it, arming is
 * refused and a slot end drops the holder off the air.
 *
 * Pure and dependency-light (only `Intl`), so the arithmetic is inspectable.
 * The one approximation: a wall-clock time is mapped to UTC using the offset in
 * effect at the naive instant, so a slot that starts within the DST-change hour
 * is off by at most an hour. For a per-day show slot that is acceptable and, in
 * this timezone, the transition is at 02:00 ET when the schedule is idle.
 */

import { DAY_MS, etOffsetMinutes, etWallClock } from './broadcast'

export type SlotShow = {
  dayOfWeek: number // 0=Sun..6=Sat (America/New_York)
  startHour: number // 0-23 ET
  startMinute: number
  durationMin: number
}

export type SlotWindow = {
  notBefore: Date
  notAfter: Date
}

/** An ET wall-clock date+time to the UTC instant it names. */
function etLocalToUtc(
  year: number,
  month: number, // 1-12
  day: number,
  hour: number,
  minute: number,
): Date {
  const naive = Date.UTC(year, month - 1, day, hour, minute)
  return new Date(naive - etOffsetMinutes(new Date(naive)) * 60_000)
}

/** The slot window for one specific ET calendar date. */
export function slotWindowForDate(
  show: SlotShow,
  year: number,
  month: number,
  day: number,
): SlotWindow {
  const notBefore = etLocalToUtc(year, month, day, show.startHour, show.startMinute)
  const notAfter = new Date(notBefore.getTime() + show.durationMin * 60_000)
  return { notBefore, notAfter }
}

/**
 * The next occurrence at or after `now` whose window has not already ended —
 * today's slot while it is still running or upcoming, otherwise the next day the
 * show airs. Scans up to a week; a show whose duration is 0 falls back to the
 * next matching day rather than returning a zero-length window.
 */
export function nextSlotWindow(show: SlotShow, now: Date = new Date()): SlotWindow {
  const wc = etWallClock(now)
  for (let i = 0; i < 8; i += 1) {
    // Treat the ET calendar date as a UTC date: the weekday of a calendar date
    // is timezone-independent, so getUTCDay() is the ET weekday.
    const base = new Date(Date.UTC(wc.year, wc.month - 1, wc.day + i))
    if (base.getUTCDay() !== show.dayOfWeek) continue
    const window = slotWindowForDate(
      show,
      base.getUTCFullYear(),
      base.getUTCMonth() + 1,
      base.getUTCDate(),
    )
    if (window.notAfter.getTime() > now.getTime()) return window
  }
  // A show with no future occurrence this week (impossible for a weekly slot):
  // return today's window so the caller still has something concrete.
  return slotWindowForDate(show, wc.year, wc.month, wc.day)
}

/** True when `now` sits inside the window. */
export function isSlotOpen(window: SlotWindow, now: Date = new Date()): boolean {
  return now.getTime() >= window.notBefore.getTime() && now.getTime() <= window.notAfter.getTime()
}

/** Human label for the control room, in station time. */
export function fmtSlotLabel(window: SlotWindow): string {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  })
  return `${fmt.format(window.notBefore)} – ${fmt.format(window.notAfter)} ET`
}

/** Whole minutes between two instants, floored at 0. */
export function minutesBetween(from: Date, to: Date): number {
  return Math.max(0, Math.floor((to.getTime() - from.getTime()) / 60_000))
}

export { DAY_MS }
