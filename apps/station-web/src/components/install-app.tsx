'use client';

import { useEffect, useState } from 'react';

/** Chromium's install-prompt event (not in the default TS lib). */
interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

/**
 * Floating "Install app" button — the site's downloadable-app path.
 *
 * Shows only when the browser fires `beforeinstallprompt` (Chromium, over HTTPS,
 * after the service worker registers), so it never appears where install is not
 * possible. On iOS Safari there is no such event; the button stays hidden and the
 * app is installed via Share → Add to Home Screen (a checklist item).
 */
export function InstallApp() {
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (window.matchMedia('(display-mode: standalone)').matches) return; // already installed

    const onPrompt = (e: Event) => {
      e.preventDefault();
      setDeferred(e as BeforeInstallPromptEvent);
      setVisible(true);
    };
    const onInstalled = () => {
      setDeferred(null);
      setVisible(false);
    };
    window.addEventListener('beforeinstallprompt', onPrompt);
    window.addEventListener('appinstalled', onInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', onPrompt);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  if (!deferred || !visible) return null;

  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await deferred.prompt();
          await deferred.userChoice;
        } finally {
          setVisible(false);
          setDeferred(null);
        }
      }}
      className="fixed bottom-4 right-4 z-50 rounded-full bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground shadow-lg transition hover:opacity-90"
    >
      Install app
    </button>
  );
}
