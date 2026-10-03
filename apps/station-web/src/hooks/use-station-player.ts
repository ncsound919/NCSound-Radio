'use client'

/**
 * Shared player state for the whole station UI.
 *
 * Play means "play the actual stream". This used to spin up a generative Web
 * Audio loop in the browser, which meant the Listen button produced music that
 * was never broadcast - a convincing simulation of a radio station, on the page
 * whose job is to be one. Audio now goes through a single shared <audio>
 * element pointed at the Icecast mount.
 *
 * Because the stream is cross-origin, levels cannot be read from it with a Web
 * Audio analyser. They come from the engine's master-bus spectrum via the API
 * instead, which is both real and CORS-independent.
 */

import { create } from 'zustand'
import { getStreamSource, type StreamQuality } from '@/lib/stream-source'

const QUALITY_KEY = 'ncsound-stream-quality'

function initialQuality(): StreamQuality {
  if (typeof window === 'undefined') return 'hi'
  try {
    return localStorage.getItem(QUALITY_KEY) === 'mobile' ? 'mobile' : 'hi'
  } catch {
    return 'hi'
  }
}

type StationPlayerStore = {
  isPlaying: boolean
  volume: number // 0..1
  quality: StreamQuality // hi = /live.mp3 at 128 kbps, mobile = /mobile.mp3 at 64 kbps
  /** Set when the stream could not be played, so the UI can say why. */
  streamError: string | null
  /** Epoch ms when the sleep timer expires; null = no timer armed. */
  sleepEndsAt: number | null
  /** 'timer' = wall-clock countdown, 'end-of-track' = fade when this spin ends. */
  sleepMode: 'timer' | 'end-of-track'
  toggle: () => void
  setVolume: (v: number) => void
  setQuality: (q: StreamQuality) => void
  /** minutes = null cancels the timer. Arms the wall-clock mode. */
  setSleepTimer: (minutes: number | null) => void
  /** Fade out when the currently airing spin finishes (uses remaining from now-playing). */
  setSleepEndOfTrack: () => void
  /** Fire the fade-out + stop. Idempotent; safe to call repeatedly at expiry. */
  expireSleep: () => void
  /**
   * End-of-track sleep mode: called every second from the player-bar tick with
   * the on-air spin's remaining seconds; triggers the shared fade when it dips
   * below the fade window. No-op unless sleepMode === 'end-of-track'.
   */
  checkTrackEndSleep: (remainingSec: number) => void
}

const SLEEP_FADE_SEC = 4
let sleepFading = false
let sleepBailed = false // set when the listener toggles playback mid-fade

/** Start or stop the real stream to match the desired transport state. */
function syncAudio(isPlaying: boolean, quality: StreamQuality, volume: number): void {
  if (typeof window === 'undefined') return
  const stream = getStreamSource()
  if (!stream) return
  if (isPlaying) {
    void stream.play(quality, volume).catch(() => {
      // Autoplay rejection or an unreachable mount. The UI shows streamError.
      useStationPlayer.setState({
        isPlaying: false,
        streamError:
          document.visibilityState === 'hidden'
            ? 'browser blocked autoplay'
            : 'could not reach the stream',
      })
    })
  } else {
    stream.pause()
  }
}

/**
 * Shared fade-out-and-stop path for both sleep modes (wall-clock expiry and
 * end-of-track). Idempotent via sleepFading; the listener toggling playback
 * mid-fade (sleepBailed) always wins over the queued stop.
 */
function beginSleepFade(set: (partial: Partial<StationPlayerStore>) => void, isPlaying: boolean): void {
  sleepFading = true
  sleepBailed = false
  set({ sleepEndsAt: null, sleepMode: 'timer' })

  const stream = getStreamSource()
  if (!isPlaying || !stream) {
    sleepFading = false
    set({ isPlaying: false })
    return
  }

  void stream.fadeOutAndPause(SLEEP_FADE_SEC).then(() => {
    try {
      // The listener toggling playback mid-fade means they took over the
      // transport, so leave the state alone.
      if (!sleepBailed) set({ isPlaying: false })
    } finally {
      sleepFading = false
    }
  })
}

export const useStationPlayer = create<StationPlayerStore>()((set, get) => ({
  isPlaying: false,
  volume: 0.8,
  quality: initialQuality(),
  streamError: null,
  sleepEndsAt: null,
  sleepMode: 'timer',

  toggle: () => {
    const next = !get().isPlaying
    set({ isPlaying: next, streamError: null })
    // Manual pause cancels a pending sleep timer; the expiry path stops the
    // stream directly and never routes through toggle(), so this is safe.
    if (!next && (get().sleepEndsAt || get().sleepMode === 'end-of-track')) {
      set({ sleepEndsAt: null, sleepMode: 'timer' })
    }
    // Any manual toggle during the expiry fade means the listener took over.
    if (sleepFading) sleepBailed = true
    if (!next) getStreamSource()?.cancelFade()
    syncAudio(next, get().quality, get().volume)
  },

  setVolume: (v: number) => {
    const clamped = Math.min(1, Math.max(0, v))
    set({ volume: clamped })
    getStreamSource()?.setVolume(clamped)
  },

  setQuality: (q: StreamQuality) => {
    const changed = q !== get().quality
    set({ quality: q })
    try {
      localStorage.setItem(QUALITY_KEY, q)
    } catch {
      /* private mode */
    }
    // Switch mounts without interrupting playback.
    if (changed && get().isPlaying) syncAudio(true, q, get().volume)
  },

  setSleepTimer: (minutes: number | null) => {
    if (minutes === null || minutes <= 0) {
      set({ sleepEndsAt: null, sleepMode: 'timer' })
      return
    }
    set({ sleepEndsAt: Date.now() + minutes * 60_000, sleepMode: 'timer' })
  },

  setSleepEndOfTrack: () => {
    set({ sleepEndsAt: null, sleepMode: 'end-of-track' })
  },

  expireSleep: () => {
    if (sleepFading) return
    const endsAt = get().sleepEndsAt
    if (endsAt === null || Date.now() < endsAt) return
    beginSleepFade(set, get().isPlaying)
  },

  checkTrackEndSleep: (remainingSec: number) => {
    if (sleepFading) return
    if (get().sleepMode !== 'end-of-track') return
    if (!get().isPlaying) return
    // Trigger just before the spin ends so the fade lands on the gap.
    if (remainingSec > SLEEP_FADE_SEC + 0.5) return
    beginSleepFade(set, true)
  },
}))

// Dev/QA handle: lets browser tooling drive the transport directly
// (e.g. fast-forwarding the sleep timer in E2E checks). Stripped in prod builds.
if (process.env.NODE_ENV !== 'production' && typeof window !== 'undefined') {
  ;(window as unknown as { __ncsoundPlayer?: typeof useStationPlayer }).__ncsoundPlayer =
    useStationPlayer
}