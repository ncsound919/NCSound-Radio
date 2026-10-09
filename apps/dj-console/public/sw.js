const CACHE = "ncsound-console-v1";
// Caches this worker owns and may evict. The offline R2 audio cache
// ("ncsound-r2-audio-v1") is deliberately NOT under this prefix: it holds
// downloads the DJ explicitly pinned, and an unrelated app-deployed update
// must never wipe them.
const MANAGED_PREFIX = "ncsound-console-";

self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((k) => k.startsWith(MANAGED_PREFIX) && k !== CACHE).map((k) => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  // Live station traffic must always hit the network.
  if (url.pathname.startsWith("/ingest") || url.pathname.includes("live")) return;

  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req).then((hit) => hit || caches.match("/")))
  );
});
