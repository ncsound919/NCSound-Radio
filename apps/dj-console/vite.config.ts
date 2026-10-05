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
  // There is deliberately NO bearer-token check on this proxy. There was one,
  // and it was worse than useless: the browser cannot present `INGEST_TOKEN`,
  // so setting that variable — which the engine *requires* before it will bind
  // a non-loopback host — rejected every console request and left the console
  // permanently dead. It could only ever deny service.
  //
  // The real boundary is that ingest binds 127.0.0.1 and refuses a
  // non-loopback bind without a token. This proxy is loopback-bound with it.
  "/ingest": {
    target: INGEST_TARGET,
    changeOrigin: true,
    ws: true,
    rewrite: (path: string) => path.replace(/^\/ingest/, ""),
  },
};

/** Same-origin route to the station site for the console's ops panel. */
const proxyToStation = {
  "/station": {
    target: STATION_TARGET,
    changeOrigin: true,
    rewrite: (path: string) => path.replace(/^\/station/, ""),
  },
};

const proxies = { ...proxyToIngest, ...proxyToStation };


export default defineConfig({
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