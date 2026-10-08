/**
 * Live-radio resilience.
 *
 * A radio stream drops for reasons a desk connection never sees: a tunnel on the
 * train, a Wi-Fi→cellular handover, the operator restarting the encoder. iOS
 * reports a live drop as a silent buffering stall with no error at all, so
 * recovery cannot hinge on an error event alone — it needs a stall watchdog and
 * a connectivity-change trigger too.
 *
 * All of it is pure and clock-injected so the policy is unit-tested rather than
 * tuned by hand on a device.
 */

export type PlaybackErrorKind = "network" | "not_found" | "server" | "interrupted" | "unknown";

export function classifyPlaybackError(reason: string | null | undefined): PlaybackErrorKind {
  const text = (reason ?? "").toLowerCase();
  if (!text) return "unknown";
  if (text.includes("interrupt") || text.includes("audio session")) return "interrupted";
  if (text.includes("network") || text.includes("offline") || text.includes("timed out") || text.includes("timeout")) {
    return "network";
  }
  if (text.includes("404") || text.includes("not found")) return "not_found";
  if (text.includes("5") && (text.includes("500") || text.includes("502") || text.includes("503"))) {
    return "server";
  }
  return "unknown";
}

export type RetryDecision = {
  /** Milliseconds to wait before reloading the stream. */
  delayMs: number;
  /** True when the policy has given up and the UI must show a manual retry. */
  giveUp: boolean;
};

export type RetryConfig = {
  baseMs: number;
  factor: number;
  maxMs: number;
  maxAttempts: number;
  /** Fraction of the delay applied as upward jitter, 0..1. */
  jitter: number;
};

export const DEFAULT_RETRY: RetryConfig = {
  baseMs: 1000,
  factor: 2,
  maxMs: 30_000,
  maxAttempts: 8,
  jitter: 0.25,
};

/**
 * Bounded exponential backoff with jitter. A permanent failure (404, i.e. the
 * mount does not exist) gives up on the first attempt — retrying a 404 eight
 * times is eight minutes of silence for nothing.
 */
export function nextRetry(
  attempt: number,
  kind: PlaybackErrorKind,
  config: RetryConfig = DEFAULT_RETRY,
  random: () => number = Math.random,
): RetryDecision {
  if (kind === "not_found") return { delayMs: 0, giveUp: true };
  if (attempt >= config.maxAttempts) return { delayMs: 0, giveUp: true };

  const raw = config.baseMs * config.factor ** Math.max(0, attempt - 1);
  const capped = Math.min(raw, config.maxMs);
  const delayMs = Math.round(capped * (1 + config.jitter * random()));
  return { delayMs, giveUp: false };
}

/** Reload only on the offline→online edge, not on every NetInfo event. */
export function shouldReloadOnConnectivity(previousOnline: boolean, nextOnline: boolean): boolean {
  return !previousOnline && nextOnline;
}

/**
 * A stall watchdog: the stream is playing but producing no progress. Used for
 * the iOS case where a dropped live edge surfaces as buffering, not an error.
 */
export function createStallWatchdog(thresholdMs = 4000, now: () => number = Date.now) {
  let lastProgress = now();
  return {
    /** Call whenever playback position or a buffer event advances. */
    note(): void {
      lastProgress = now();
    },
    reset(): void {
      lastProgress = now();
    },
    /** True when nothing has advanced for `thresholdMs`. */
    isStalled(): boolean {
      return now() - lastProgress > thresholdMs;
    },
  };
}
