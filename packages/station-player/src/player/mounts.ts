/**
 * Which Icecast mount to play.
 *
 * The mount is never hardcoded in the app — it comes from `GET /api/stream`
 * (via station-client) so the bitrate and path cannot drift from the encoder.
 * Data saver simply switches which of the two mounts the player is handed.
 */

import type { StreamDescriptor, StreamMount, StreamQuality } from "@ncsound/station-client";

export function qualityFor(dataSaver: boolean): StreamQuality {
  return dataSaver ? "mobile" : "hi";
}

export function selectMount(
  descriptor: StreamDescriptor,
  quality: StreamQuality,
): StreamMount {
  return quality === "mobile" ? descriptor.mobile : descriptor.live;
}

/**
 * The URL to play, or null when the descriptor has nothing usable. A malformed
 * or missing `url` must not be handed to the player: RNTP on a bad URL fails
 * with an opaque native error rather than an actionable one.
 */
export function playbackUrl(
  descriptor: StreamDescriptor | null,
  dataSaver: boolean,
): string | null {
  if (!descriptor) return null;
  const mount = selectMount(descriptor, qualityFor(dataSaver));
  return mount && typeof mount.url === "string" && mount.url.length > 0 ? mount.url : null;
}
