import { defineConfig } from "vite";

/**
 * The guest door: the same console build, served for hosts and guest DJs.
 *
 * The OWNER's server (vite.config.ts) adds INGEST_TOKEN to every proxied
 * request, so anyone who can reach it is the owner. This server must be the
 * opposite, and that is the whole point of having a second one:
 *
 *   - it NEVER adds the master token, and does not read INGEST_TOKEN at all;
 *   - the visitor's own session token (from their invite link) rides on every
 *     request, and ingest decides what it may do;
 *   - it proxies only the ingest paths a console needs, so the owner-only
 *     routes (/sessions, /live/kill, /live/unlock) are not reachable from the
 *     public door even by someone holding a stolen master token;
 *   - it has no /station proxy.
 *
 * Expose THIS port to the internet (a tunnel pointed at it), never the owner's.
 * Run it from the production build, not the dev server:
 *
 *     bun run build
 *     INGEST_ALLOWED_ORIGINS=https://guest.example.com bun run guest
 *
 * INGEST_ALLOWED_ORIGINS must name the public URL (set it on INGEST, not here):
 * ingest checks the browser's Origin on POSTs and sockets and refuses anything
 * that is not loopback or listed. INGEST_TOKEN must be set on ingest or it will
 * not accept tunnelled requests at all.
 */
const INGEST_TARGET = process.env.INGEST_URL ?? "http://127.0.0.1:8099";
const GUEST_PORT = Number(process.env.DJ_GUEST_PORT ?? 3104);
// Loopback: a tunnel client (cloudflared) runs on this machine and connects locally.
const GUEST_HOST = process.env.DJ_GUEST_HOST ?? "127.0.0.1";

/** Ingest paths a console may use. Everything else answers 404 here. */
const ALLOWED = /^\/ingest\/(whoami|status|health|imaging|requests|command|ws|live|live\/arm)(\?.*)?$/;

const proxy = {
  "/ingest": {
    target: INGEST_TARGET,
    changeOrigin: true,
    ws: true,
    rewrite: (path: string) => path.replace(/^\/ingest/, ""),
    // Vite: returning false answers 404; undefined lets the request through.
    bypass: (req: { url?: string }) => (req.url && ALLOWED.test(req.url) ? undefined : false),
    // Deliberately no `headers: { authorization … }`.
  },
};

export default defineConfig({
  optimizeDeps: { exclude: ["signalsmith-stretch"] },
  server: { host: GUEST_HOST, port: GUEST_PORT, strictPort: true, allowedHosts: true, hmr: false, proxy },
  preview: { host: GUEST_HOST, port: GUEST_PORT, strictPort: true, allowedHosts: true, proxy },
});
