import path from "node:path";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");

const nextConfig: NextConfig = {
  output: "standalone",
  transpilePackages: ["@ncsound/station-core"],
  turbopack: {
    root: repoRoot,
  },
  /* config options here */
  typescript: {
    ignoreBuildErrors: true,
  },
  reactStrictMode: false,

  /**
   * CORS on the public JSON routes only.
   *
   * Native clients do not need CORS, but the PWA and any future webview do.
   * These are all public, unauthenticated, cookie-free reads (plus the request
   * POST), so `*` is safe; the admin/auth routes are deliberately excluded.
   * Override the origin with NEXT_PUBLIC_API_ORIGIN when serving a fixed site.
   */
  async headers() {
    const origin = process.env.NEXT_PUBLIC_API_ORIGIN?.trim() || "*";
    const cors = [
      { key: "Access-Control-Allow-Origin", value: origin },
      { key: "Access-Control-Allow-Methods", value: "GET, POST, OPTIONS" },
      { key: "Access-Control-Allow-Headers", value: "content-type, authorization" },
      { key: "Vary", value: "Origin" },
    ];
    return [
      "/api/stream",
      "/api/nowplaying",
      "/api/schedule",
      "/api/charts",
      "/api/history",
      "/api/tracks",
      "/api/artists/:path*",
      "/api/requests",
      "/api/listeners/:path*",
      "/api/video",
    ].map((source) => ({ source, headers: cors }));
  },
};

export default nextConfig;