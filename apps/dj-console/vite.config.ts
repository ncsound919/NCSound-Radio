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

// 3000 is Grafana's port on this machine, and strictPort would abort the boot.
const CONSOLE_PORT = Number(process.env.DJ_CONSOLE_PORT ?? 3101);

const proxyToIngest = {
  "/ingest": {
    target: INGEST_TARGET,
    changeOrigin: true,
    rewrite: (path: string) => path.replace(/^\/ingest/, ""),
  },
};

export default defineConfig({
  server: {
    host: "0.0.0.0",
    port: CONSOLE_PORT,
    strictPort: true,
    allowedHosts: true,
    hmr: false,
    proxy: proxyToIngest,
  },
  preview: {
    host: "0.0.0.0",
    port: CONSOLE_PORT,
    strictPort: true,
    allowedHosts: true,
    proxy: proxyToIngest,
  },
});