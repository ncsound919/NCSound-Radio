import { NextResponse } from 'next/server'
import { streamDescriptor } from '@/lib/stream'

export const dynamic = 'force-dynamic'

/**
 * GET /api/stream
 *
 * The mount descriptor a client reads instead of hardcoding mount names: the
 * absolute URLs for the full-quality and data-saver mounts, their real
 * bitrate/codec, and the base host. Public by design — every field is a URL a
 * listener already plays.
 *
 * The base host is configuration (`NEXT_PUBLIC_STREAM_BASE_URL` /
 * `NCSOUND_STREAM_BASE_URL`): loopback on the station PC, the VPS Icecast over
 * TLS in production. See `docs/MOBILE-LISTENER-APP-IMPLEMENTATION.md` §4.
 */
export async function GET() {
  return NextResponse.json(streamDescriptor(), {
    headers: { 'cache-control': 'no-store' },
  })
}
