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

/** Best-effort client IP from proxy headers (x-forwarded-for first hop). */
export function clientIp(req: Request): string {
  const fwd = req.headers.get('x-forwarded-for')
  if (fwd) {
    const first = fwd.split(',')[0]?.trim()
    if (first) return first
  }
  return req.headers.get('x-real-ip') ?? 'local'
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
