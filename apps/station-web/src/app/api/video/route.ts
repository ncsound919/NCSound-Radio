import { NextResponse } from 'next/server'
import { getActiveShow } from '@/lib/broadcast'

export const dynamic = 'force-dynamic'

/**
 * GET /api/video
 *
 * The live-video descriptor for the listener app. Video is SHOW-ONLY: it is
 * promoted when a LIVE show (the morning show, a guest DJ slot) is on air and
 * the OBS feed is actually streaming to Cloudflare Stream.
 *
 * The Stream API token is server-side only; the app receives public playback
 * URLs plus a `promote` hint. When video is not configured or not live this
 * returns `live:false` (never an error), so the app degrades to audio honestly.
 *
 * See docs/LIVE-VIDEO-INTEGRATION.md.
 */
const CUSTOMER = process.env.STREAM_CUSTOMER_CODE?.trim() || null
const INPUT_ID = process.env.STREAM_LIVE_INPUT_ID?.trim() || null
const TOKEN = process.env.STREAM_API_TOKEN?.trim() || null

type Lifecycle = { live?: boolean; videoUID?: string | null }

async function fetchLifecycle(): Promise<{ live: boolean; videoId: string | null }> {
  if (!CUSTOMER || !INPUT_ID || !TOKEN) return { live: false, videoId: null }
  try {
    const res = await fetch(
      `https://customer-${CUSTOMER}.cloudflarestream.com/${INPUT_ID}/lifecycle`,
      {
        headers: { Authorization: `Bearer ${TOKEN}` },
        signal: AbortSignal.timeout(2500),
        cache: 'no-store',
      },
    )
    if (!res.ok) return { live: false, videoId: null }
    const doc = (await res.json()) as Lifecycle
    return { live: doc.live === true, videoId: doc.videoUID ?? null }
  } catch {
    // A failed status check is "not live", not "broken": the app falls back to
    // audio and the screen says so.
    return { live: false, videoId: null }
  }
}

export async function GET() {
  const [life, show] = await Promise.all([fetchLifecycle(), getActiveShow()])

  const showInfo = show
    ? {
        id: show.id,
        name: show.name,
        host: show.host,
        kind: show.kind === 'LIVE' ? ('LIVE' as const) : ('PLAYLIST' as const),
        /**
         * For this station a LIVE show IS the video show (morning show, guest
         * DJ slot). If a LIVE show is ever audio-only, add a `video` flag to the
         * Show model and read it here instead.
         */
        isVideo: show.kind === 'LIVE',
      }
    : null

  const configured = Boolean(CUSTOMER && INPUT_ID)
  const live = configured && life.live
  const id = life.videoId ?? INPUT_ID
  const base = CUSTOMER && id ? `https://customer-${CUSTOMER}.cloudflarestream.com/${id}` : null

  return NextResponse.json(
    {
      configured,
      live,
      inputId: INPUT_ID,
      videoId: life.videoId,
      hls: live && base ? `${base}/manifest/video.m3u8` : null,
      dash: live && base ? `${base}/manifest/video.mpd` : null,
      dvrHls: live && base ? `${base}/manifest/video.m3u8?dvrEnabled=true` : null,
      player: live && base ? `${base}/iframe` : null,
      /**
       * Promotion hint: nudge the listener to watch only when a LIVE show is on
       * air AND the video feed is actually streaming. The app uses this for the
       * watch prompt/banner; the listener's own on/off toggle is app-side.
       */
      promote: live && showInfo?.isVideo === true,
      show: showInfo,
      reason: !configured
        ? 'video not configured'
        : !live
          ? 'no live video right now'
          : null,
      updatedAt: new Date().toISOString(),
    },
    { headers: { 'cache-control': 'no-store' } },
  )
}
