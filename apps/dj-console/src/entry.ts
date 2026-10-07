/**
 * Entry point: picks the console UI.
 *
 *   /             the redesigned console
 *   /?ui=gallery  component gallery for the control set
 *   /?ui=overlay  the transparent OBS overlay (#obs-overlay also selects it)
 */
const params = new URLSearchParams(location.search);
const ui = params.get("ui");
const overlayRequested = ui === "overlay" || location.hash.startsWith("#obs-overlay");

const ready = () => document.documentElement.setAttribute("data-ui-ready", "");

if (overlayRequested) {
  void import("./ui/views/overlay").then((m) => m.mountOverlay(document.body)).finally(ready);
} else if (ui === "gallery") {
  void import("./app/gallery").then((m) => m.mountGallery(document.body)).finally(ready);
} else {
  // Identity first: a host/guest invite gets a restricted console, and a bad
  // invite stops here with a message rather than booting a console that fails.
  void import("./app/session")
    .then(async (s) => {
      const r = await s.initSession();
      if (!r.ok) return s.showBlocked(r.message);
      const m = await import("./app/boot");
      m.boot(document.body);
    })
    .finally(ready);
}

// Installable PWA: caches the UI shell so a venue Wi-Fi drop doesn't kill the console.
if (import.meta.env.PROD && "serviceWorker" in navigator) {
  window.addEventListener("load", () => void navigator.serviceWorker.register("/sw.js"));
}
