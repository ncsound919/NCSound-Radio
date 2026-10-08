/**
 * ncsound-api (Cloudflare integration, phase 2).
 *
 * The edge surface in front of R2 `ncsound-media`. The console and the station
 * site talk to this Worker instead of the public r2.dev URL, because R2 has no
 * public object listing and no CORS by default. Everything here is read-only
 * and public (the media bucket is public); auth/gating is phase 7 (Access/WAF).
 *
 *   GET  /health            liveness
 *   GET  /library           the full catalog, read from R2 list()
 *   GET  /library/manifest  keys only, for a compact client cache
 *   GET  /audio/<key>       the bytes, with Range support (seek)
 *
 * Access: if the LIBRARY_TOKEN secret is set, /library*, and /audio/* need
 * `Authorization: Bearer <token>` (or `?t=<token>` for plain <audio> tags).
 * /health stays open. With no secret the Worker is open, as it was before.
 */
export interface Env {
  MEDIA: R2Bucket;
  VECTORIZE: VectorizeIndex;
  ALLOWED_ORIGINS?: string;
  LIBRARY_TOKEN?: string;
  /** Gate for the write endpoint `/index` (fail-closed when unset). */
  INDEX_TOKEN?: string;
}

/** Must match `FEATURE_DIMENSIONS` in @ncsound/station-core. */
const VECTOR_DIMENSIONS = 32;

type Range = { offset?: number; length?: number; suffix?: number };

const MAX_LIST = 1000;

function corsHeaders(origin: string, env: Env): Record<string, string> {
  const allow = (env.ALLOWED_ORIGINS ?? "*").trim();
  const value =
    allow === "*" ? "*" : allow.split(",").map((s) => s.trim()).filter(Boolean).includes(origin) ? origin : "";
  const headers: Record<string, string> = {
    "access-control-allow-methods": "GET, HEAD, OPTIONS",
    "access-control-allow-headers": "range, content-type, if-none-match, authorization",
    "access-control-expose-headers": "content-length, content-range, accept-ranges, etag",
    vary: "Origin",
  };
  if (value) headers["access-control-allow-origin"] = value;
  return headers;
}

/** Constant-time string compare, so a wrong token leaks nothing about a right one. */
export function safeEqual(a: string, b: string): boolean {
  const len = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < len; i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

export function authorised(request: Request, url: URL, env: Env): boolean {
  const token = (env.LIBRARY_TOKEN ?? "").trim();
  if (!token) return true;
  const header = request.headers.get("authorization") ?? "";
  const bearer = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
  const query = url.searchParams.get("t") ?? "";
  return (bearer !== "" && safeEqual(bearer, token)) || (query !== "" && safeEqual(query, token));
}

function json(body: unknown, status: number, cors: Record<string, string>, method = "GET"): Response {
  const headers = new Headers(cors);
  headers.set("content-type", "application/json; charset=utf-8");
  return new Response(method === "HEAD" ? null : JSON.stringify(body), { status, headers });
}

function parseRange(header: string): Range | undefined {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return undefined;
  const [, a, b] = m;
  if (a === "" && b === "") return undefined;
  if (a === "") return { suffix: Number(b) };
  const offset = Number(a);
  if (b === "") return { offset };
  const end = Number(b);
  if (end < offset) return undefined;
  return { offset, length: end - offset + 1 };
}

function partial(obj: R2Object, range: Range): { header: string; length: number } {
  const start = range.offset ?? (range.suffix !== undefined ? Math.max(0, obj.size - range.suffix) : 0);
  const end = range.length !== undefined ? Math.min(obj.size - 1, start + range.length - 1) : obj.size - 1;
  return { header: `bytes ${start}-${end}/${obj.size}`, length: Math.max(0, end - start + 1) };
}

async function listLibrary(env: Env) {
  const objects: Array<Record<string, unknown>> = [];
  let cursor: string | undefined;
  do {
    const page = await env.MEDIA.list({ limit: MAX_LIST, cursor });
    for (const o of page.objects) {
      const segments = o.key.split("/");
      objects.push({
        key: o.key,
        fileName: segments[segments.length - 1],
        album: segments.length > 1 ? segments[0] : null,
        size: o.size,
        uploaded: o.uploaded instanceof Date ? o.uploaded.toISOString() : String(o.uploaded),
        contentType: o.httpMetadata?.contentType ?? null,
      });
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  objects.sort((a, b) => String(a.key).localeCompare(String(b.key)));
  return objects;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const method = request.method.toUpperCase();
    const cors = corsHeaders(request.headers.get("Origin") ?? "", env);

    if (method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    // Write: upsert an audio-feature vector. The console publishes these after
    // it analyses a track. Token-gated and fail-closed; never a public route.
    if (url.pathname === "/index" && method === "POST") {
      const token = (env.INDEX_TOKEN ?? "").trim();
      if (!token) return json({ error: "indexing is not configured" }, 503, cors, method);
      const auth = request.headers.get("authorization") ?? "";
      const bearer = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
      if (!safeEqual(bearer, token)) return json({ error: "unauthorised" }, 401, cors, method);

      const body = (await request.json().catch(() => null)) as
        | { key?: unknown; vector?: unknown; metadata?: unknown }
        | null;
      const key = typeof body?.key === "string" ? body.key.trim() : "";
      const vector = body?.vector;
      if (!key) return json({ error: "key is required" }, 400, cors, method);
      if (
        !Array.isArray(vector) ||
        vector.length !== VECTOR_DIMENSIONS ||
        !vector.every((n) => typeof n === "number" && Number.isFinite(n))
      ) {
        return json({ error: `vector must be ${VECTOR_DIMENSIONS} finite numbers` }, 400, cors, method);
      }
      const metadata: Record<string, string | number | boolean> = {};
      if (body?.metadata && typeof body.metadata === "object") {
        for (const [k, v] of Object.entries(body.metadata as Record<string, unknown>)) {
          if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") metadata[k] = v;
        }
      }
      await env.VECTORIZE.upsert([{ id: key, values: vector as number[], metadata }]);
      return json({ ok: true, key, dimensions: VECTOR_DIMENSIONS }, 200, cors, method);
    }

    if (method !== "GET" && method !== "HEAD") return json({ error: "method not allowed" }, 405, cors, method);

    if (url.pathname === "/health") {
      return json({ ok: true, service: "ncsound-api", bucket: "ncsound-media", time: new Date().toISOString() }, 200, cors, method);
    }

    const open = url.pathname === "/health";
    if (!open && !authorised(request, url, env)) {
      const headers = new Headers(cors);
      headers.set("www-authenticate", "Bearer");
      headers.set("content-type", "application/json; charset=utf-8");
      return new Response(method === "HEAD" ? null : JSON.stringify({ error: "unauthorised" }), { status: 401, headers });
    }

    if (url.pathname === "/similar" || url.pathname === "/similar/") {
      const key = (url.searchParams.get("key") ?? "").trim();
      if (!key) return json({ error: "key is required" }, 400, cors, method);
      const topK = Math.min(20, Math.max(1, Number(url.searchParams.get("top") ?? 8) || 8));
      // The bound type is the legacy VectorizeIndex (no queryById), so fetch the
      // vector, then query by value. +1 so we can drop the query vector itself.
      const [self] = await env.VECTORIZE.getByIds([key]);
      if (!self) return json({ error: "not indexed", key }, 404, cors, method);
      const res = await env.VECTORIZE.query(self.values, { topK: topK + 1, returnMetadata: "all" });
      const matches = res.matches
        .filter((m) => m.id !== key)
        .slice(0, topK)
        .map((m) => ({ key: m.id, score: m.score, metadata: m.metadata ?? null }));
      return json({ key, topK, matches }, 200, cors, method);
    }

    if (url.pathname === "/library" || url.pathname === "/library/") {
      const objects = await listLibrary(env);
      return json({ bucket: "ncsound-media", count: objects.length, objects }, 200, cors, method);
    }

    if (url.pathname === "/library/manifest") {
      const objects = await listLibrary(env);
      return json({ bucket: "ncsound-media", count: objects.length, keys: objects.map((o) => o.key) }, 200, cors, method);
    }

    if (url.pathname.startsWith("/audio/")) {
      let key: string;
      try {
        key = decodeURIComponent(url.pathname.slice("/audio/".length));
      } catch {
        return json({ error: "bad key encoding" }, 400, cors, method);
      }
      if (!key) return json({ error: "missing key" }, 400, cors, method);
      const rangeHeader = request.headers.get("range");
      const range = rangeHeader ? parseRange(rangeHeader) : undefined;
      const getRange = range && rangeHeader ? new Headers({ range: rangeHeader }) : undefined;
      let obj: R2ObjectBody | R2Object | null;
      try {
        obj = await env.MEDIA.get(key, getRange ? { range: getRange } : undefined);
      } catch {
        const headers = new Headers(cors);
        headers.set("content-type", "application/json; charset=utf-8");
        return new Response(JSON.stringify({ error: "range not satisfiable", key }), { status: 416, headers });
      }
      if (!obj) return json({ error: "not found", key }, 404, cors, method);

      const headers = new Headers(cors);
      obj.writeHttpMetadata(headers);
      headers.set("cache-control", env.LIBRARY_TOKEN ? "private, max-age=3600" : "public, max-age=3600");
      headers.set("etag", obj.httpEtag);
      headers.set("accept-ranges", "bytes");
      if (method === "HEAD") return new Response(null, { status: 200, headers });
      if (range) {
        const part = partial(obj, range);
        headers.set("content-range", part.header);
        headers.set("content-length", String(part.length));
        return new Response((obj as R2ObjectBody).body, { status: 206, headers });
      }
      headers.set("content-length", String(obj.size));
      return new Response((obj as R2ObjectBody).body, { status: 200, headers });
    }

    return json({ error: "not found", path: url.pathname }, 404, cors, method);
  },
};
