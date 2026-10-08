import { engine } from './engine';

/**
 * Sleep timer: fade to silence over the last few seconds, then pause.
 *
 * The fade is a JS volume ramp plus one pause, applied through the engine
 * facade. Glue code — covered by the on-device checkpoint, not unit tests.
 */
let fadeTimer: ReturnType<typeof setInterval> | null = null;
let pauseTimer: ReturnType<typeof setTimeout> | null = null;

export function startSleepTimer(minutes: number, fadeSeconds = 10): void {
  cancelSleepTimer();
  const totalMs = Math.max(0, minutes * 60_000);
  const fadeMs = Math.min(fadeSeconds * 1000, totalMs);
  const fadeStart = totalMs - fadeMs;

  pauseTimer = setTimeout(() => {
    const steps = Math.max(1, Math.round(fadeMs / 100));
    let i = 0;
    fadeTimer = setInterval(() => {
      i += 1;
      engine.setVolume(Math.max(0, 1 - i / steps));
      if (i >= steps) {
        if (fadeTimer) clearInterval(fadeTimer);
        fadeTimer = null;
        engine.pause();
        engine.setVolume(1);
      }
    }, 100);
  }, fadeStart);
}

export function cancelSleepTimer(): void {
  if (pauseTimer) {
    clearTimeout(pauseTimer);
    pauseTimer = null;
  }
  if (fadeTimer) {
    clearInterval(fadeTimer);
    fadeTimer = null;
    engine.setVolume(1);
  }
}
