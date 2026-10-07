/**
 * The stream descriptor: one authority for the mount paths, their bitrates and
 * the public base URL. The web player, the `/api/stream` route and (by contract)
 * the phone app all read this, so the label cannot drift from the encoder.
 *
 * The base URL is **config, not a constant**. On the station PC it is the
 * loopback Icecast; in production it is the VPS Icecast over TLS on a DNS-only
 * subdomain — *not* a Cloudflare Tunnel (Cloudflare's terms bar serving audio
 * over the free CDN and it does not cache ICY). See
 * `docs/MOBILE-LISTENER-APP-IMPLEMENTATION.md` §4.
 */
export type StreamQuality = 'hi' | 'mobile'

export const STREAM_MOUNTS: Record<
  StreamQuality,
  { path: string; bitrateKbps: number; codec: string; label: string }
> = {
  hi: { path: '/live.mp3', bitrateKbps: 128, codec: 'MP3', label: 'Full quality' },
  mobile: { path: '/mobile.mp3', bitrateKbps: 64, codec: 'MP3', label: 'Data saver' },
}

/** Icecast moved off 8000: an unrelated Windows service holds that port. */
const LOOPBACK_PORT = process.env.NEXT_PUBLIC_ICECAST_PORT ?? process.env.ICECAST_PORT ?? '8010'

/**
 * Absolute base URL for the Icecast mounts, without a trailing slash.
 *
 * Precedence: the public env (works in the browser and on the server), then the
 * server-only env, then the loopback default so local dev keeps working.
 */
export function streamBaseUrl(): string {
  const configured = process.env.NEXT_PUBLIC_STREAM_BASE_URL ?? process.env.NCSOUND_STREAM_BASE_URL
  const base = configured && configured.trim() ? configured.trim() : `http://127.0.0.1:${LOOPBACK_PORT}`
  return base.replace(/\/+$/, '')
}

/** The absolute URL of one mount. */
export function streamUrl(q: StreamQuality, base = streamBaseUrl()): string {
  return `${base}${STREAM_MOUNTS[q].path}`
}

/** What a client needs to play the stream, without hardcoding a mount name. */
export function streamDescriptor(base = streamBaseUrl()) {
  return {
    baseUrl: base,
    live: { ...STREAM_MOUNTS.hi, url: `${base}${STREAM_MOUNTS.hi.path}` },
    mobile: { ...STREAM_MOUNTS.mobile, url: `${base}${STREAM_MOUNTS.mobile.path}` },
    /** Reserved for the later adaptive-bitrate path; null until it exists. */
    hls: null as string | null,
    updatedAt: new Date().toISOString(),
  }
}
