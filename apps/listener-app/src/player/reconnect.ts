/**
 * Reconnect policy: classify a failure, then back off — bounded.
 *
 * A radio player must not retry a 404 forever (it will never succeed) and must
 * not give up on a dropped Wi-Fi hop (it almost certainly will). Pure and
 * dependency-free so it can be unit-tested without a device.
 */

export type ErrorClass = 'transient' | 'permanent';

/** HTTP statuses worth retrying. Everything else is permanent. */
const TRANSIENT_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

export type ErrorLike = {
  status?: number;
  /** A string code from a player/library (the shape the reconnect policy was
   *  first written against). */
  code?: string;
  /** `react-native-video` error object fields. `errorCode` is a string on
   *  Android; `code` is a number and is ignored by the string branch. */
  errorCode?: string;
  domain?: string;
  name?: string;
  message?: string;
  errorString?: string;
  localizedDescription?: string;
  localizedFailureReason?: string;
};

/** Specific error codes a retry will not fix. */
const PERMANENT_CODES = new Set([
  'source',
  'renderer',
  'play-not-permitted',
  'controller-connection-failed',
]);

/**
 * `react-native-video` errorCode substrings that are genuinely unrecoverable.
 * Kept deliberately narrow: most transport failures on a live stream (bad HTTP
 * status, decoder hiccups) do recover, so retrying is the safer default.
 */
const PERMANENT_PATTERN = /(not.?found|unsupported|malformed|invalid.?source|no.?permission)/i;

export function classifyError(input?: ErrorLike | null): ErrorClass {
  if (!input) return 'transient'; // unknown -> retry conservatively

  if (typeof input.code === 'string') {
    return PERMANENT_CODES.has(input.code) ? 'permanent' : 'transient';
  }
  if (typeof input.errorCode === 'string') {
    return PERMANENT_PATTERN.test(input.errorCode) ? 'permanent' : 'transient';
  }
  if (typeof input.status === 'number') {
    return TRANSIENT_STATUS.has(input.status) ? 'transient' : 'permanent';
  }

  const msg = `${input.name ?? ''} ${input.message ?? ''} ${input.errorString ?? ''} ${
    input.localizedDescription ?? ''
  } ${input.localizedFailureReason ?? ''}`.toLowerCase();
  if (/(abort|timeout|timed out|network|offline|socket|unreachable|econn|dns|temporar)/.test(msg)) {
    return 'transient';
  }
  return 'permanent';
}

/** Bounded exponential backoff: 1s, 2s, 4s, 8s, 16s, 30s. */
export const BACKOFF_MS = [1000, 2000, 4000, 8000, 16000, 30000] as const;

/**
 * Delay before attempt `attempt` (0-based), or `null` when retries are
 * exhausted — at which point the caller surfaces the failure instead of looping.
 */
export function nextBackoffMs(attempt: number): number | null {
  if (attempt < 0 || attempt >= BACKOFF_MS.length) return null;
  return BACKOFF_MS[attempt];
}
