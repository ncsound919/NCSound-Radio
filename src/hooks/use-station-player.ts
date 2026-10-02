'use client'

/**
 * Shared player state for the whole station UI.
 *
 * Audio side-effects live in the store actions so every consumer (header,
 * player bar, hero CTA) behaves identically:
 *   - play  + previewSynth -> lazily dynamic-import the SynthEngine and start
 *     it (user gesture already happened via the button click)
 *   - pause / previewSynth off -> stop the engine
 *   - volume changes are forwarded to the engine
 *
 * The engine chunk is loaded on demand so SSR never touches WebAudio.
 */

import { create } from 'zustand'
import type { SynthEngine } from '@/lib/synth-engine'

export type StreamQuality = 'hi' | 'mobile'

const QUALITY_KEY = 'wavc-stream-quality'

function initialQuality(): StreamQuality {
  if (typeof window === 'undefined') return 'hi'
  try {
    const v = localStorage.getItem(QUALITY_KEY)
    return v === 'mobile' ? 'mobile' : 'hi'
  } catch {
    return 'hi'
  }
}

type StationPlayerStore = {
  isPlaying: boolean
  volume: number // 0..1
  previewSynth: boolean // true = WebAudio studio preview, false = silent UI
  quality: StreamQuality // hi = Mount 1 (128 kbps AAC), mobile = Mount 2 (64 kbps HE-AAC)
  /** Epoch ms when the sleep timer expires; null = no timer. */
  sleepEndsAt: number | null
  toggle: () => void
  setVolume: (v: number) => void
  setPreviewSynth: (b: boolean) => void
  setQuality: (q: StreamQuality) => void
  /** minutes = null cancels the timer. */
  setSleepTimer: (minutes: number | null) => void
  /** Fire the fade-out + stop. Idempotent; safe to call repeatedly at expiry. */
  expireSleep: () => void
}

let enginePromise: Promise<SynthEngine | null> | null = null
let engineInstance: SynthEngine | null = null

function loadEngine(): Promise<SynthEngine | null> {
  if (typeof window === 'undefined') return Promise.resolve(null)
  if (!enginePromise) {
    enginePromise = import('@/lib/synth-engine')
      .then((m) => {
        engineInstance = m.getSynthEngine()
        return engineInstance
      })
      .catch(() => {
        enginePromise = null
        return null
      })
  }
  return enginePromise
}

async function startEngine(volume: number): Promise<void> {
  try {
    const engine = await loadEngine()
    if (!engine) return
    // If a sleep-timer fade was in flight, cancel it so a manual restart
    // isn't ramped to silence by the queued linear ramp.
    engine.cancelFade()
    engine.setVolume(volume)
    if (!engine.isRunning) engine.start()
  } catch {
    /* never break the UI over audio */
  }
}

function stopEngine(): void {
  if (!engineInstance) return // never loaded -> nothing to stop
  try {
    engineInstance.stop()
  } catch {
    /* ignore */
  }
}

function applyVolume(v: number): void {
  if (!engineInstance) return
  try {
    engineInstance.setVolume(v)
  } catch {
    /* ignore */
  }
}

function syncAudio(isPlaying: boolean, previewSynth: boolean, volume: number): void {
  if (typeof window === 'undefined') return
  if (isPlaying && previewSynth) void startEngine(volume)
  else stopEngine()
}

/** The loaded engine (or null) — used by the reactive-hero audio-level hook. */
export function getLoadedEngine(): SynthEngine | null {
  return engineInstance
}

const SLEEP_FADE_SEC = 4
let sleepFading = false
let sleepBailed = false // set when the listener toggles playback mid-fade

export const useStationPlayer = create<StationPlayerStore>()((set, get) => ({
  isPlaying: false,
  volume: 0.8,
  previewSynth: true,
  quality: 'hi',
  sleepEndsAt: null,

  toggle: () => {
    const next = !get().isPlaying
    set({ isPlaying: next })
    // Manual pause cancels a pending sleep timer — expiry path stops the
    // engine directly and never routes through toggle(), so this is safe.
    if (!next && get().sleepEndsAt) set({ sleepEndsAt: null })
    // Any manual toggle during the expiry fade means the listener took over.
    if (sleepFading) sleepBailed = true
    syncAudio(next, get().previewSynth, get().volume)
  },

  setVolume: (v: number) => {
    const clamped = Math.min(1, Math.max(0, v))
    set({ volume: clamped })
    applyVolume(clamped)
  },

  setPreviewSynth: (b: boolean) => {
    set({ previewSynth: b })
    syncAudio(get().isPlaying, b, get().volume)
  },

  setQuality: (q: StreamQuality) => {
    set({ quality: q })
    try {
      localStorage.setItem(QUALITY_KEY, q)
    } catch {
      /* private mode */
    }
  },

  setSleepTimer: (minutes: number | null) => {
    if (minutes === null || minutes <= 0) {
      set({ sleepEndsAt: null })
      return
    }
    set({ sleepEndsAt: Date.now() + minutes * 60_000 })
  },

  expireSleep: () => {
    if (sleepFading) return
    const endsAt = get().sleepEndsAt
    if (endsAt === null || Date.now() < endsAt) return
    sleepFading = true
    sleepBailed = false
    set({ sleepEndsAt: null })
    try {
      if (get().isPlaying) {
        engineInstance?.fadeOut(SLEEP_FADE_SEC)
        // After the fade: hard-stop + flip the UI off — unless the listener
        // toggled playback mid-fade (then they own the transport).
        setTimeout(() => {
          try {
            if (!sleepBailed) {
              stopEngine()
              set({ isPlaying: false })
            }
          } finally {
            sleepFading = false
          }
        }, SLEEP_FADE_SEC * 1000 + 150)
        return
      }
    } catch {
      /* never break the UI over audio */
    }
    sleepFading = false
  },
}))

// Dev/QA handle: lets browser tooling drive the transport directly
// (e.g. fast-forwarding the sleep timer in E2E checks). Stripped in prod builds.
if (process.env.NODE_ENV !== 'production' && typeof window !== 'undefined') {
  ;(window as unknown as { __wavcPlayer?: typeof useStationPlayer }).__wavcPlayer =
    useStationPlayer
}
