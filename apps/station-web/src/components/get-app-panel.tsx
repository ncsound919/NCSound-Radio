'use client'

import { useEffect, useState } from 'react'

/** Chromium's install-prompt event (not in the default TS lib). */
interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

type Platform = 'android' | 'ios' | 'desktop'

/**
 * Coarse platform guess, only ever run in the browser.
 *
 * iPadOS 13+ reports as "Macintosh" in the user agent, so `/iPad/` alone misses
 * every modern iPad; the multi-touch probe is what distinguishes it from a
 * desktop Mac.
 */
function detectPlatform(): Platform {
  const ua = navigator.userAgent
  const iPadOS = /macintosh/i.test(ua) && navigator.maxTouchPoints > 1
  if (/ipad|iphone|ipod/i.test(ua) || iPadOS) return 'ios'
  if (/android/i.test(ua)) return 'android'
  return 'desktop'
}

const STEPS: Record<Platform, string[]> = {
  android: [
    'Open this page in Chrome.',
    'Tap the ⋮ menu in the top-right corner.',
    'Choose “Install app” (older builds say “Add to Home screen”).',
    'Confirm — NCSound opens full-screen from your home screen.',
  ],
  ios: [
    'Open this page in Safari.',
    'Tap the Share button in the toolbar.',
    'Scroll down and choose “Add to Home Screen”.',
    'Tap “Add” — NCSound appears on your home screen.',
  ],
  desktop: [
    'Open this page in Chrome or Edge.',
    'Click the install icon at the right end of the address bar.',
    'Confirm — NCSound opens in its own window.',
  ],
}

/**
 * The site's install affordance, in-page.
 *
 * The floating `InstallApp` button in the root layout is the ambient version of
 * this; on /download the reader has asked for the app, so the same logic is
 * rendered inline with written steps for the browsers that never fire
 * `beforeinstallprompt` (notably iOS Safari).
 */
export function GetAppPanel() {
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null)
  const [installed, setInstalled] = useState(false)
  const [platform, setPlatform] = useState<Platform | null>(null)

  useEffect(() => {
    setPlatform(detectPlatform())
    if (window.matchMedia('(display-mode: standalone)').matches) {
      setInstalled(true)
      return
    }

    const onPrompt = (e: Event) => {
      e.preventDefault()
      setDeferred(e as BeforeInstallPromptEvent)
    }
    const onInstalled = () => {
      setDeferred(null)
      setInstalled(true)
    }
    window.addEventListener('beforeinstallprompt', onPrompt)
    window.addEventListener('appinstalled', onInstalled)
    return () => {
      window.removeEventListener('beforeinstallprompt', onPrompt)
      window.removeEventListener('appinstalled', onInstalled)
    }
  }, [])

  if (installed) {
    return (
      <div className="rounded-lg border border-primary/40 bg-primary/10 px-4 py-3">
        <p className="text-sm font-semibold text-primary">You&rsquo;re running the installed app.</p>
        <p className="mt-1 text-sm text-muted-foreground">
          Nothing to do here — this is already NCSound Radio off the home screen.
        </p>
      </div>
    )
  }

  if (deferred) {
    return (
      <div className="rounded-lg border border-border/60 bg-card/40 p-4">
        <p className="text-sm text-muted-foreground">
          Your browser can install this site as an app.
        </p>
        <button
          type="button"
          onClick={async () => {
            try {
              await deferred.prompt()
              await deferred.userChoice
            } finally {
              setDeferred(null)
            }
          }}
          className="mt-3 w-full rounded-lg bg-primary px-5 py-3 text-base font-semibold text-primary-foreground shadow-lg transition hover:opacity-90 sm:w-auto"
        >
          Install app
        </button>
      </div>
    )
  }

  return (
    <div className="rounded-lg border border-border/60 bg-card/40 p-4">
      <h2 className="text-sm font-semibold">
        {platform === 'ios'
          ? 'Add to Home Screen (iPhone / iPad)'
          : platform === 'android'
            ? 'Install on Android'
            : 'Install on this device'}
      </h2>
      {platform === null ? (
        // The platform is only knowable in the browser. Render nothing
        // platform-specific before the effect runs rather than guessing and
        // swapping the text under the reader on hydration.
        <p className="mt-2 text-sm text-muted-foreground">Loading install steps&hellip;</p>
      ) : (
        <ol className="mt-3 space-y-2.5 text-sm text-muted-foreground">
          {STEPS[platform].map((step, i) => (
            <li key={step} className="flex gap-2.5">
              <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary/15 text-[11px] font-bold text-primary">
                {i + 1}
              </span>
              <span>{step}</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}
