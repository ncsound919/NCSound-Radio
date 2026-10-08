/**
 * Stall watchdog.
 *
 * The cruelest playback failure raises no error: the player reports "playing"
 * while the position never advances. This detects that from the progress stream
 * so the caller can reopen the stream at the live edge.
 */
export type WatchdogInput = {
  playing: boolean;
  /** Current reported position, seconds. */
  positionSec: number;
  /** Position at the previous sample. */
  lastPositionSec: number;
  /** Milliseconds since the previous sample. */
  elapsedMs: number;
  /** Defaults to 8000ms. */
  thresholdMs?: number;
};

/** Position must move by more than this (seconds) to count as progressing. */
const MIN_PROGRESS_SEC = 0.25;

export function isStalled(input: WatchdogInput): boolean {
  if (!input.playing) return false;
  const threshold = input.thresholdMs ?? 8000;
  const moved = Math.abs(input.positionSec - input.lastPositionSec) > MIN_PROGRESS_SEC;
  return !moved && input.elapsedMs >= threshold;
}
