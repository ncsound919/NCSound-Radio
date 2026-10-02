'use client'

import type { ShareResult } from '@/lib/station-types'

export const STATION_NAME = 'WAVC 91.3 FM — Carolina Waves'
export const STATION_URL = 'https://wavc.fm'

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
