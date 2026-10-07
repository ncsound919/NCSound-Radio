/**
 * Deterministic content hash for the analysis cache.
 *
 * The cache key is file name + size + last-modified + a hash of the first
 * 64 KB. The hash is what catches the common case of a file edited in place
 * without its size changing. FNV-1a is used rather than `crypto.subtle` because
 * it is synchronous, runs identically in a Worker and in a Node test, and a
 * cache collision only costs a re-analysis, never correctness.
 */

export function fnv1a(bytes: Uint8Array, seed = 0x811c9dc5): number {
  let h = seed >>> 0;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    // h *= 16777619, mod 2^32, without BigInteger precision loss
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h >>> 0;
}

const hex = (n: number) => n.toString(16).padStart(8, "0");

export function hashBytes(bytes: Uint8Array): string {
  return hex(fnv1a(bytes));
}

/** Stable cache key. `headHash` should come from `hashBytes` on the first 64 KB. */
export function cacheKeyFor(fileName: string, size: number, lastModified: number, headHash: string): string {
  return `${fileName}|${size}|${lastModified}|${headHash}`;
}

/** Stable id from a seed string, so the same file added twice is one row. */
export function makeId(prefix: string, seed: string): string {
  const bytes = new TextEncoder().encode(seed);
  const a = hex(fnv1a(bytes));
  const b = hex(fnv1a(bytes, 0x9e3779b9));
  return `${prefix}-${a}${b}`;
}
