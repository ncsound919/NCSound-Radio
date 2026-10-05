'use client'

/**
 * The actual radio stream.
 *
 * This replaces a Web Audio "studio preview" that generated its own loop in the
 * browser. That was a stand-in: pressing play produced music that was never on
 * air, so the page's most important control was a simulation of itself. What
 * plays now is the real Icecast mount, the same bytes a listener's player gets.
 *
 * One <audio> element is shared by the whole UI, because two elements on one
 * live stream fight over the connection and double the listener count.
 *
 * Note on metering: the stream is cross-origin and Icecast sends no CORS
 * headers, so routing it through a Web Audio AnalyserNode yields silence. The
 * UI therefore takes its levels from the engine's master-bus spectrum over the
 * API instead, which is both real and unaffected by CORS.
 */

/** Icecast moved off 8000: an unrelated Windows service holds that port. */
const ICECAST_PORT = Number(process.env.NEXT_PUBLIC_ICECAST_PORT ?? 8010)

export type StreamQuality = 'hi' | 'mobile'

/**
 * The two mounts, with what they actually carry.
 *
 * `bitrateKbps` and `codec` were previously duplicated as UI literals in the
 * player bar, where they read "128 kbps AAC" and "64 kbps HE-AAC". Both were
 * wrong twice over: the bitrates happened to match, but Liquidsoap encodes these
 * mounts with `%mp3` (infra/liquidsoap/ncsound.liq), so the codec was fiction.
 * One authority here, so the label cannot drift from the encoder again.
 */
export const MOUNTS: Record<
  StreamQuality,
  { path: string; bitrateKbps: number; codec: string; label: string }
> = {
  hi: { path: '/live.mp3', bitrateKbps: 128, codec: 'MP3', label: 'Full quality' },
  mobile: { path: '/mobile.mp3', bitrateKbps: 64, codec: 'MP3', label: 'Data saver' },
}

export type StreamSource = {
  element: HTMLAudioElement
  urlFor: (q: StreamQuality) => string
  play: (q: StreamQuality, volume: number) => Promise<void>
  pause: () => void
  setVolume: (v: number) => void
  /** Ramp to silence over `seconds`, then pause. Resolves when finished. */
  fadeOutAndPause: (seconds: number) => Promise<void>
  /** Cancel an in-flight fade and restore `volume`. */
  cancelFade: () => void
  isLive: () => boolean
  /** Set when the element errors, so the UI can say why playback failed. */
  error: () => string | null
}

let singleton: StreamSource | null = null

function create(): StreamSource {
  const el = document.createElement('audio')
  el.preload = 'none'
  // Keep playing in the background when the tab loses focus: people switch tabs
  // while listening.
  el.setAttribute('playsinline', '')

  let raf = 0
  let lastError: string | null = null

  el.addEventListener('error', () => {
    lastError =
      el.error?.message ||
      (el.error?.code === 2 ? 'stream unreachable' : el.error?.code === 3 ? 'decode failed' : 'playback failed')
    // eslint-disable-next-line no-console
    console.warn('[stream] playback error:', lastError)
  })
  el.addEventListener('playing', () => {
    lastError = null
  })
  el.addEventListener('stalled', () => {
    // Icecast sends silence to keep the connection warm during a gap; that is
    // normal and does not mean the stream died.
  })

  const urlFor = (q: StreamQuality) => `http://127.0.0.1:${ICECAST_PORT}${MOUNTS[q].path}`

  const cancelFade = () => {
    if (raf) cancelAnimationFrame(raf)
    raf = 0
  }

  return {
    element: el,
    urlFor,
    isLive: () => !el.paused && !el.ended && el.readyState > 2,
    error: () => lastError,

    async play(q, volume) {
      const wanted = urlFor(q)
      if (el.src !== wanted) {
        el.src = wanted
        el.load()
      }
      el.volume = Math.min(1, Math.max(0, volume))
      await el.play()
    },

    pause() {
      el.pause()
    },

    setVolume(v) {
      el.volume = Math.min(1, Math.max(0, v))
    },

    cancelFade,

    fadeOutAndPause(seconds) {
      return new Promise<void>((resolve) => {
        cancelFade()
        const from = el.volume
        const start = performance.now()
        const step = () => {
          const t = Math.min(1, (performance.now() - start) / (seconds * 1000))
          el.volume = from * (1 - t)
          if (t < 1) {
            raf = requestAnimationFrame(step)
          } else {
            raf = 0
            el.pause()
            resolve()
          }
        }
        step()
      })
    },
  }
}

export function getStreamSource(): StreamSource | null {
  if (typeof window === 'undefined') return null
  if (!singleton) singleton = create()
  return singleton
}