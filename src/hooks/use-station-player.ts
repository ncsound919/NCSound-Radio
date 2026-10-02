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

type StationPlayerStore = {
  isPlaying: boolean
  volume: number // 0..1
  previewSynth: boolean // true = WebAudio studio preview, false = silent UI
  toggle: () => void
  setVolume: (v: number) => void
  setPreviewSynth: (b: boolean) => void
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

export const useStationPlayer = create<StationPlayerStore>()((set, get) => ({
  isPlaying: false,
  volume: 0.8,
  previewSynth: true,

  toggle: () => {
    const next = !get().isPlaying
    set({ isPlaying: next })
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
}))
