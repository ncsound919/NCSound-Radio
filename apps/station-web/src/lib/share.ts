'use client'

import type { ShareResult } from '@/lib/station-types'

export const STATION_NAME = 'NCSound Radio — NCSound Radio'
export const STATION_URL = 'https://ncsound.fm'

/**
 * Share the station via the Web Share API when available (mobile), falling
 * back to the clipboard on desktop. Returns what happened so callers can
 * toast accordingly. Never throws.
 */
export async function shareStation(
  text = 'Listen live to the Carolinas’ independent hip-hop signal.',
): Promise<ShareResult> {
  if (typeof window === 'undefined') return 'failed'
  const shareData = { title: STATION_NAME, text, url: STATION_URL }
  try {
    if (typeof navigator.share === 'function') {
      await navigator.share(shareData)
      return 'shared'
    }
  } catch (err) {
    // AbortError = user dismissed the sheet; not a failure worth toasting.
    if (err instanceof DOMException && err.name === 'AbortError') return 'shared'
  }
  try {
    await navigator.clipboard.writeText(`${STATION_NAME} — ${STATION_URL}`)
    return 'copied'
  } catch {
    return 'failed'
  }
}

/**
 * Share (or copy) a "now playing" shout-out for the on-air spin. Same Web
 * Share API → clipboard fallback as the station share, but the text carries
 * the track so friends know what they're tuning into. Never throws.
 */
export async function shareNowPlaying(trackTitle: string, artist: string): Promise<ShareResult> {
  if (typeof window === 'undefined') return 'failed'
  const text = `Now playing on NCSound Radio: “${trackTitle}” by ${artist}. Tune in:`
  try {
    if (typeof navigator.share === 'function') {
      await navigator.share({ title: `${trackTitle} — ${artist} · NCSound Radio`, text, url: STATION_URL })
      return 'shared'
    }
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') return 'shared'
  }
  try {
    await navigator.clipboard.writeText(`${text} ${STATION_URL}`)
    return 'copied'
  } catch {
    return 'failed'
  }
}
