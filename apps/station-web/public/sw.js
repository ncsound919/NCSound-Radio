// Minimal service worker — makes the PWA installable ("download the web app").
//
// Deliberately NO fetch handler. A caching service worker on a live-radio app
// risks serving a stale player, stale API responses, or a stale stream URL; the
// only thing installability actually needs is a registered worker with an
// install/activate lifecycle. Caching, if ever added, must never touch /api/* or
// the stream mounts.

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});
