import { classifyError, nextBackoffMs } from './reconnect';
import { subscribeConnectivity } from './network';
import { engine, subscribeEngine, type EngineError } from './engine';
import { isStalled } from './watchdog';

export type PlaybackHealth = {
  /** Called before each retry with the attempt index and its delay. */
  onReconnecting?: (attempt: number, delayMs: number) => void;
  /** Called when retries are exhausted or the failure is permanent. */
  onFatal?: (reason: string) => void;
};

let healthStarted = false;
let retryAttempt = 0;
let retryTimer: ReturnType<typeof setTimeout> | null = null;

function describe(error: EngineError): string {
  return `${error.code ?? 'error'}${error.message ? `: ${error.message}` : ''}`;
}

/**
 * Subscribe to the engine's events and apply the reconnect + watchdog policy.
 *
 * Transient failures back off (bounded) and retry by reopening the stream at the
 * live edge; permanent failures stop. A frozen position while "playing" triggers
 * the same live-edge recovery. Registered once from `initPlayback`.
 */
export function startPlaybackHealth(handlers: PlaybackHealth = {}): () => void {
  let lastPos = 0;
  let lastAt = Date.now();
  let recovering = false;
  let recoverTimer: ReturnType<typeof setTimeout> | null = null;

  const unsubscribe = subscribeEngine((event) => {
    if (event.type === 'state') {
      // A healthy state resets the retry budget.
      if (event.state === 'playing' || event.state === 'buffering') retryAttempt = 0;
      return;
    }

    if (event.type === 'error') {
      if (classifyError(event.error) === 'permanent') {
        handlers.onFatal?.(describe(event.error));
        return;
      }
      const delay = nextBackoffMs(retryAttempt);
      if (delay === null) {
        handlers.onFatal?.('retries exhausted');
        return;
      }
      handlers.onReconnecting?.(retryAttempt, delay);
      retryAttempt += 1;
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = setTimeout(() => engine.jumpToLive(), delay);
      return;
    }

    if (event.type === 'progress') {
      const now = Date.now();
      // Only judge a stall while actually playing. Hardcoding `playing: true`
      // meant a frozen position while paused (or buffering) looked like a stall
      // and `jumpToLive()` restarted audio the listener had deliberately paused.
      const playing = engine.state() === 'playing';
      if (!playing) {
        // Re-baseline so the pause duration is not later counted as an 8s stall.
        lastPos = event.positionSec;
        lastAt = now;
        return;
      }
      const stalled = isStalled({
        playing,
        positionSec: event.positionSec,
        lastPositionSec: lastPos,
        elapsedMs: now - lastAt,
      });
      lastPos = event.positionSec;
      lastAt = now;
      if (stalled && !recovering) {
        recovering = true;
        engine.jumpToLive();
        if (recoverTimer) clearTimeout(recoverTimer);
        recoverTimer = setTimeout(() => {
          recovering = false;
        }, 3000);
      }
    }
  });

  // When real connectivity returns, recover a stream stuck in Error.
  const unsubscribeNet = subscribeConnectivity((online) => {
    if (online && engine.state() === 'error') engine.jumpToLive();
  });

  return () => {
    unsubscribe();
    unsubscribeNet();
    if (retryTimer) clearTimeout(retryTimer);
    if (recoverTimer) clearTimeout(recoverTimer);
  };
}

/** Idempotent: start health monitoring exactly once at app launch. */
export function initPlayback(handlers?: PlaybackHealth): void {
  if (healthStarted) return;
  startPlaybackHealth(handlers);
  healthStarted = true;
}
