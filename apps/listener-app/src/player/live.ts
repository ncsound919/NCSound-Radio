import { env } from '../config/env';
import { mountUrl, type StreamQuality } from '../data/streams';
import { engine, type MediaDescriptor } from './engine';

/**
 * Build the live media descriptor. The mount URL comes from config here; the
 * player prefers the authoritative descriptor from `GET /api/stream` when a
 * caller has one.
 */
export function liveMedia(
  quality: StreamQuality = 'hi',
  title = 'NCSound Radio',
): MediaDescriptor {
  return {
    url: mountUrl(env.streamBaseUrl, quality),
    title,
    artist: 'NCSound Radio',
  };
}

/** Load the live stream and start playing it. */
export function playLive(quality: StreamQuality = 'hi'): void {
  engine.load(liveMedia(quality));
}
