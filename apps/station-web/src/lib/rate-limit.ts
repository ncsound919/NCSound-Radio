/**
 * Tiny in-memory sliding-window rate limiter (per IP + bucket).
 * Sandbox-scale only: state lives in the process, resets on reload —
 * exactly like the local-memory caching policy for this stack.
 */

type Bucket = { timestamps: number[] }

const globalForLimiter = globalThis as unknown as {
  ncsoundRateBuckets: Map<string, Bucket> | undefined
}

const buckets: Map<string, Bucket> =
  globalForLimiter.ncsoundRateBuckets ?? (globalForLimiter.ncsoundRateBuckets = new Map())

/**
 * The client IP as asserted by a trusted reverse proxy, or null.
 *
 * `x-forwarded-for` / `x-real-ip` are request headers: without a proxy in
 * front that overwrites them, the client writes them. Trusting them
 * unconditionally let anyone rotate the header to get a fresh rate-limit
 * bucket per request (unlimited admin-login guesses) and forge the IP stored
 * on a signed submission agreement.
 *
 * Set TRUST_PROXY=1 only when the station sits behind a proxy that replaces
 * these headers (nginx `proxy_set_header X-Forwarded-For $remote_addr`, a
 * Cloudflare tunnel, etc.).
 */
export function trustedClientIp(req: Request): string | null {
  if (process.env.TRUST_PROXY !== '1') return null
  const fwd = req.headers.get('x-forwarded-for')
  if (fwd) {
    // Rightmost hop is the one our proxy appended; leftmost is client-supplied.
    const hops = fwd.split(',').map((h) => h.trim()).filter(Boolean)
    const last = hops[hops.length - 1]
    if (last) return last
  }
  return req.headers.get('x-real-ip')
}

/**
 * Rate-limit key for the caller.
 *
 * Without a trusted proxy, Next route handlers have no socket address, so every
 * caller shares one 'direct' bucket. That trades per-IP fairness for a limit
 * that cannot be bypassed: a flood can lock legitimate users out for one
 * window, but it cannot buy unlimited attempts.
 */
export function clientIp(req: Request): string {
  return trustedClientIp(req) ?? 'direct'
}

/**
 * Consume one slot for `key` (bucket:ip). Returns false when the caller
 * exceeded `max` hits inside `windowMs`.
 */
export function allow(key: string, max: number, windowMs: number): boolean {
  const now = Date.now()
  const bucket = buckets.get(key) ?? { timestamps: [] }
  bucket.timestamps = bucket.timestamps.filter((t) => now - t < windowMs)
  if (bucket.timestamps.length >= max) {
    buckets.set(key, bucket)
    return false
  }
  bucket.timestamps.push(now)
  buckets.set(key, bucket)
  return true
}

/** Occasional sweep so abandoned IPs don't accumulate. */
export function sweepRateLimits(): void {
  if (buckets.size < 512) return
  const now = Date.now()
  for (const [key, bucket] of buckets) {
    if (!bucket.timestamps.some((t) => now - t < 3_600_000)) buckets.delete(key)
  }
}
