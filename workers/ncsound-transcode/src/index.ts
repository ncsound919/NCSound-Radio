/**
 * ncsound-transcode (Cloudflare integration, phase 4).
 *
 * The edge front for the ffmpeg Container. The Worker does no work beyond
 * routing and CORS; the container owns the audio. One named instance keeps the
 * image warm for the operator.
 */
import { Container } from "@cloudflare/containers";
import { gate } from "./auth";

export interface Env {
  TRANSCODE: DurableObjectNamespace;
  ALLOWED_ORIGINS?: string;
  TRANSCODE_TOKEN?: string;
}

export class TranscodeContainer extends Container<Env> {
  defaultPort = 8080;
  sleepAfter = "5m";
}

function corsHeaders(origin: string, env: Env): Record<string, string> {
  const allow = (env.ALLOWED_ORIGINS ?? "*").trim();
  const value =
    allow === "*" ? "*" : allow.split(",").map((s) => s.trim()).filter(Boolean).includes(origin) ? origin : "";
  const headers: Record<string, string> = {
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type, range, authorization",
    "access-control-expose-headers": "content-length, x-loudness-lufs, x-loudness-truepeak-dbfs",
    vary: "Origin",
  };
  if (value) headers["access-control-allow-origin"] = value;
  return headers;
}

const ROUTES = new Set(["/health", "/loudness", "/transcode"]);

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const cors = corsHeaders(request.headers.get("Origin") ?? "", env);

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    if (ROUTES.has(url.pathname)) {
      const denied = gate(request, url.pathname, env);
      if (denied) {
        const headers = new Headers(cors);
        headers.set("content-type", "application/json; charset=utf-8");
        return new Response(JSON.stringify({ ok: false, error: denied.error }), { status: denied.status, headers });
      }
      const container = env.TRANSCODE.getByName("transcode");
      const res = await container.fetch(request);
      const headers = new Headers(res.headers);
      for (const [k, v] of Object.entries(cors)) headers.set(k, v);
      return new Response(res.body, { status: res.status, headers });
    }

    const headers = new Headers(cors);
    headers.set("content-type", "application/json; charset=utf-8");
    return new Response(JSON.stringify({ ok: false, error: "not found", path: url.pathname }), { status: 404, headers });
  },
};
