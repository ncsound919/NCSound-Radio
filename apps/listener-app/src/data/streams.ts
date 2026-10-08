/**
 * Stream mounts and the data-saver choice.
 *
 * Mirror of station-web's `STREAM_MOUNTS` (`apps/station-web/src/lib/stream.ts`).
 * The app prefers the authoritative descriptor from `GET /api/stream` at
 * runtime; these constants are the fallback and the single source for the
 * data-saver mapping.
 */
export type StreamQuality = 'hi' | 'mobile';

export const STREAM_MOUNTS: Record<StreamQuality, { path: string; bitrateKbps: number }> = {
  hi: { path: '/live.mp3', bitrateKbps: 128 },
  mobile: { path: '/mobile.mp3', bitrateKbps: 64 },
};

/** Data saver -> 64k mobile mount; otherwise the 128k full-quality mount. */
export function qualityFor(dataSaver: boolean): StreamQuality {
  return dataSaver ? 'mobile' : 'hi';
}

/** Absolute mount URL, tolerating a trailing slash on the base. */
export function mountUrl(base: string, quality: StreamQuality): string {
  return `${base.replace(/\/+$/, '')}${STREAM_MOUNTS[quality].path}`;
}
