import { defineConfig } from "vite";

/**
 * The console runs a LOCAL browser Mixer so an operator can rehearse and
 * monitor without touching the broadcast chain. Broadcast truth comes from the
 * ingest service, which polls Icecast.
 *
 * This file previously carried a ~200 line vite middleware serving eight
 * /api/radio/* endpoints backed by hardcoded state: "Club Horizon Radio",
 * "Midnight Warehouse", 42 listeners, a 1 hour uptime that never moved. It
 * looked like a station backend and agreed only with itself. The engine is
 * packages/ingest, reached through the proxy below.
 */
const INGEST_TARGET = process.env.INGEST_URL ?? "http://127.0.0.1:8099";

/**
 * The ingest control token, held by THIS server process, never by the page.
 *
 * Going live from a club means INGEST_URL is the station's tunnel hostname
 * (https://…) and ingest requires INGEST_TOKEN for any tunnelled request. The
 * proxy below adds `Authorization: Bearer …` to every proxied request,
 * WebSocket upgrades included, so the browser never sees the secret. Ingest
 * accepts a bearer on the upgrade in place of the token in the frame.
 *
 * Why this is safe where the old proxy *check* was not: ingest still applies
 * its Origin gate to what the proxy forwards (the browser's real Origin is
 * passed through; only Host is rewritten), so a foreign page that reaches this
 * port is refused by ingest even though the proxy added the token. And this
 * server stays loopback-bound (see CONSOLE_HOST).
 */
const INGEST_TOKEN = process.env.INGEST_TOKEN?.trim() || null;

/**
 * The ffmpeg Container (Cloudflare Stream/transcode). Like the ingest token,
 * the Worker token is held by THIS server process and added to every proxied
 * `/transcode` request, so it never reaches the page.
 */
const TRANSCODE_TARGET = process.env.TRANSCODE_URL ?? "https://ncsound-transcode.tap4500.workers.dev";
const TRANSCODE_TOKEN = process.env.TRANSCODE_TOKEN?.trim() || null;

/** The R2 catalogue Worker also owns the Vectorize index (`/index`, `/similar`). */
const VECTORIZE_TARGET = process.env.VECTORIZE_URL ?? "https://ncsound-api.tap4500.workers.dev";
const INDEX_TOKEN = process.env.INDEX_TOKEN?.trim() || null;

// Not 3000 (Grafana) and not 3101 (an unrelated project on this machine holds
// it, and strictPort would abort the boot). Override with DJ_CONSOLE_PORT.
const CONSOLE_PORT = Number(process.env.DJ_CONSOLE_PORT ?? 3102);

/**
 * Loopback by default, and that is a security decision rather than a default.
 *
 * This server proxies `/ingest` to the engine, and http-proxy forwards request
 * headers. Bound to `0.0.0.0`, anyone on the LAN could POST
 * `http://<lan-ip>:3102/ingest/command` and have it applied by an engine bound
 * to loopback with no token of its own — completely defeating the `listen()`
 * guard that refuses to bind a non-loopback host unauthenticated.
 *
 * Rather than bolt a token check onto a dev proxy, the exposure is removed: the
 * console is a trusted local operator tool, so it listens locally and a DJ
 * working off-site reaches it through an SSH tunnel
 * (`ssh -L 3102:127.0.0.1:3102 …`). That is the same answer Liquidsoap's own
 * documentation gives for its unauthenticated telnet server.
 *
 * Set DJ_CONSOLE_HOST=0.0.0.0 deliberately for LAN access, and set
 * INGEST_TOKEN so the engine authenticates the proxy as well.
 */
const CONSOLE_HOST = process.env.DJ_CONSOLE_HOST ?? "127.0.0.1";

/**
 * The station site, proxied so the console can reach its API same-origin.
 *
 * station-web sends no CORS headers, and a cross-origin call from the browser
 * would be blocked — which is why this exists rather than pointing the console
 * straight at :3100. Same loopback reasoning as `/ingest` above.
 */
const STATION_TARGET = process.env.STATION_URL ?? "http://127.0.0.1:3100";

const proxyToIngest = {
  // `ws: true` is what makes the upgrade work. Without it the console's
  // control link opens a socket URL, the proxy answers with a non-101
  // response, and the console silently falls back to HTTP polling — which
  // looks healthy and is not what anyone asked for.
  //
  // There is deliberately no bearer-token CHECK on this proxy. There was one,
  // and it was worse than useless: the browser cannot present `INGEST_TOKEN`,
  // so it rejected every console request. Instead the proxy ADDS the token
  // from this process's environment (see INGEST_TOKEN above).
  //
  // The real boundary is that ingest binds 127.0.0.1 and refuses a
  // non-loopback bind without a token. This proxy is loopback-bound with it.
  "/ingest": {
    target: INGEST_TARGET,
    changeOrigin: true,
    ws: true,
    rewrite: (path: string) => path.replace(/^\/ingest/, ""),
    ...(INGEST_TOKEN ? { headers: { authorization: `Bearer ${INGEST_TOKEN}` } } : {}),
  },
};

/** Same-origin route to the station site. Unused since the ops panel moved to the site; reuse or delete in the Radio mode rebuild (plan phase 5). */
const proxyToStation = {
  "/station": {
    target: STATION_TARGET,
    changeOrigin: true,
    rewrite: (path: string) => path.replace(/^\/station/, ""),
  },
};

/**
 * The ffmpeg Container. The browser calls `/transcode/loudness`; this proxy
 * adds the Worker's bearer token, so the token is never in the page.
 */
const proxyToTranscode = {
  "/transcode": {
    target: TRANSCODE_TARGET,
    changeOrigin: true,
    rewrite: (path: string) => path.replace(/^\/transcode/, ""),
    ...(TRANSCODE_TOKEN ? { headers: { authorization: `Bearer ${TRANSCODE_TOKEN}` } } : {}),
  },
};

/** The Vectorize index writes/reads, token injected by this server. */
const proxyToVectorize = {
  "/vectorize": {
    target: VECTORIZE_TARGET,
    changeOrigin: true,
    rewrite: (path: string) => path.replace(/^\/vectorize/, ""),
    ...(INDEX_TOKEN ? { headers: { authorization: `Bearer ${INDEX_TOKEN}` } } : {}),
  },
};

const proxies = { ...proxyToIngest, ...proxyToStation, ...proxyToTranscode, ...proxyToVectorize };


export default defineConfig({
  // signalsmith-stretch builds its AudioWorklet by stringifying its own
  // functions into a Blob. esbuild pre-bundling rewrites those functions, the
  // worklet module then fails inside the audio thread, and the node never
  // posts "ready" - SignalsmithStretch(ctx) hangs forever with no error.
  // Serving the package untouched fixes it (measured: ready in ~30 ms).
  optimizeDeps: { exclude: ["signalsmith-stretch"] },
  server: {
    host: CONSOLE_HOST,
    port: CONSOLE_PORT,
    strictPort: true,
    allowedHosts: true,
    hmr: false,
    proxy: proxies,
  },
  preview: {
    host: CONSOLE_HOST,
    port: CONSOLE_PORT,
    strictPort: true,
    allowedHosts: true,
    proxy: proxies,
  },
});