import * as Sentry from '@sentry/react-native';
import Config from 'react-native-config';

/**
 * Crash/error observability. Initialised once at launch.
 *
 * The DSN comes from `react-native-config`; when it is blank (default in dev)
 * Sentry is disabled rather than erroring, so a fresh checkout runs.
 */
let started = false;

export function initSentry(): void {
  if (started) return;
  const raw = (Config ?? {}) as Record<string, string | undefined>;
  const dsn = raw.SENTRY_DSN ?? '';
  Sentry.init({
    dsn: dsn || undefined,
    enabled: Boolean(dsn),
    environment: __DEV__ ? 'dev' : 'production',
    // Sample a fifth of traces; crashes/errors are always captured.
    tracesSampleRate: 0.2,
  });
  started = true;
}

/** Report a non-fatal error with a scope tag (e.g. 'player'). */
export function captureError(error: unknown, context?: Record<string, unknown>): void {
  Sentry.captureException(error, context ? { extra: context } : undefined);
}

/**
 * Playback telemetry: field bugs (reconnects, watchdogs) rarely reproduce at a
 * desk, so they are recorded as breadcrumbs the next crash report carries.
 */
export function capturePlaybackEvent(
  name: string,
  data?: Record<string, unknown>,
): void {
  Sentry.addBreadcrumb({
    category: 'player',
    message: name,
    level: 'info',
    data,
  });
}
