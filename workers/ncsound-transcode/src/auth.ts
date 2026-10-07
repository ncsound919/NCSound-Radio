/**
 * Bearer gate for the transcode Worker.
 *
 * The container runs ffmpeg, so a reachable URL is a CPU bill. Work routes
 * require `TRANSCODE_TOKEN` (a Worker secret) and fail closed without it;
 * `/health` stays open for liveness. The token rides as
 * `Authorization: Bearer <token>` or `?t=<token>` (for a fetch that cannot set
 * a header).
 */
export type Denial = { error: string; status: number };

const WORK_ROUTES = new Set(["/loudness", "/transcode"]);

/** Constant-time compare, so a wrong token leaks nothing about a right one. */
function safeEqual(a: string, b: string): boolean {
  const len = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < len; i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

export function gate(
  request: Request,
  path: string,
  env: { TRANSCODE_TOKEN?: string },
): Denial | null {
  if (!WORK_ROUTES.has(path)) return null; // /health and unknown paths fall through
  if (request.method.toUpperCase() !== "POST") return { error: "method not allowed", status: 405 };

  const expected = (env.TRANSCODE_TOKEN ?? "").trim();
  if (!expected) return { error: "transcode is not configured with a token", status: 503 };

  const url = new URL(request.url);
  const header = request.headers.get("authorization") ?? "";
  const bearer = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
  const query = url.searchParams.get("t") ?? "";
  const ok = (bearer !== "" && safeEqual(bearer, expected)) || (query !== "" && safeEqual(query, expected));
  return ok ? null : { error: "unauthorized", status: 401 };
}
