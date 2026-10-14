'use client';

import { useEffect } from 'react';

/**
 * Registers the installability service worker (`/sw.js`).
 *
 * Registration has to happen in the browser, so this is a tiny client island in
 * the root layout. It never throws: a missing worker just means the browser will
 * not offer "Install", which is a capability, not an error.
 */
export function ServiceWorkerRegister() {
  useEffect(() => {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
    navigator.serviceWorker.register('/sw.js').catch(() => {
      /* install prompt simply won't be offered */
    });
  }, []);
  return null;
}
