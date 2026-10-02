'use client'

/**
 * Keyboard shortcuts for the station console:
 *   Space   -> play / pause (ignored while typing)
 *   1..6    -> switch tabs
 *   S       -> sleep timer on (30 min) / off
 *   ?       -> toggle the shortcuts dialog
 *   Escape  -> close the shortcuts dialog
 *
 * Returns [shortcutsOpen, setShortcutsOpen] so the shell can render the
 * help dialog.
 */
import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { useStationPlayer } from '@/hooks/use-station-player'
import { TAB_IDS, type TabId } from '@/lib/station-types'

function isTypingTarget(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false
  const tag = el.tagName
  return (
    tag === 'INPUT' ||
    tag === 'TEXTAREA' ||
    tag === 'SELECT' ||
    el.isContentEditable
  )
}

export function useKeyboardShortcuts(onTabChange: (t: TabId) => void): [
  boolean,
  (open: boolean) => void,
] {
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  const toggle = useStationPlayer((s) => s.toggle)
  const sleepEndsAt = useStationPlayer((s) => s.sleepEndsAt)
  const setSleepTimer = useStationPlayer((s) => s.setSleepTimer)

  const handler = useCallback(
    (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return
      if (shortcutsOpen && e.key === 'Escape') {
        setShortcutsOpen(false)
        return
      }
      if (isTypingTarget(e.target)) return

      if (e.key === ' ') {
        e.preventDefault()
        toggle()
        return
      }
      const idx = Number(e.key)
      if (Number.isInteger(idx) && idx >= 1 && idx <= TAB_IDS.length) {
        onTabChange(TAB_IDS[idx - 1])
        return
      }
      if (e.key === 's' || e.key === 'S') {
        e.preventDefault()
        if (sleepEndsAt) {
          setSleepTimer(null)
          toast('Sleep timer off.')
        } else {
          setSleepTimer(30)
          toast('Sleep timer — 30 minutes.', {
            description: 'Press S again to cancel; the stream fades out on schedule.',
          })
        }
        return
      }
      if (e.key === '?') {
        e.preventDefault()
        setShortcutsOpen((v) => !v)
      }
    },
    [onTabChange, shortcutsOpen, toggle, sleepEndsAt, setSleepTimer],
  )

  useEffect(() => {
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [handler])

  return [shortcutsOpen, setShortcutsOpen]
}
