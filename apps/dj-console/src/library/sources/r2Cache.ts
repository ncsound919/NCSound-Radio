/**
 * Offline cache for R2 audio (Cache Storage).
 *
 * Venue Wi-Fi fails. A track that was pinned here loads without the network, and
 * a track that was played once is kept for next time. Entries are keyed by the
 * R2 object key on this origin, never by the Worker URL or token, so changing
 * either does not orphan the cache.
 */
import { r2AudioUrl, r2Headers, R2Unavailable } from "./r2";

export const R2_CACHE_NAME = "ncsound-r2-audio-v1";

const cacheKey = (key: string): Request =>
  new Request(`${location.origin}/__r2/${key.split("/").map(encodeURIComponent).join("/")}`);

export function offlineCacheSupported(): boolean {
  return typeof caches !== "undefined";
}

export async function isCachedOffline(key: string): Promise<boolean> {
  if (!offlineCacheSupported()) return false;
  try {
    return !!(await (await caches.open(R2_CACHE_NAME)).match(cacheKey(key)));
  } catch {
    return false;
  }
}

export async function cachedOfflineKeys(): Promise<Set<string>> {
  const out = new Set<string>();
  if (!offlineCacheSupported()) return out;
  try {
    const cache = await caches.open(R2_CACHE_NAME);
    const prefix = `${location.origin}/__r2/`;
    for (const req of await cache.keys()) {
      if (req.url.startsWith(prefix)) out.add(decodeURIComponent(req.url.slice(prefix.length)));
    }
  } catch {
    /* unavailable: treat as empty */
  }
  return out;
}

export async function removeOffline(key: string): Promise<boolean> {
  if (!offlineCacheSupported()) return false;
  try {
    return await (await caches.open(R2_CACHE_NAME)).delete(cacheKey(key));
  } catch {
    return false;
  }
}

/**
 * Bytes for an R2 track: the offline copy if there is one, else the network
 * (stored for next time). A failed or partial response is never stored.
 */
export async function fetchR2Audio(key: string, fetchImpl: typeof fetch = fetch): Promise<ArrayBuffer> {
  if (offlineCacheSupported()) {
    try {
      const hit = await (await caches.open(R2_CACHE_NAME)).match(cacheKey(key));
      if (hit) return hit.arrayBuffer();
    } catch {
      /* fall through to the network */
    }
  }
  let res: Response;
  try {
    res = await fetchImpl(r2AudioUrl(key), { headers: r2Headers() });
  } catch (e) {
    throw new R2Unavailable(`R2 audio unavailable: no network and "${key.split("/").pop()}" is not saved offline.`);
  }
  if (res.status === 401) throw new R2Unavailable("R2 audio refused: set the R2 token in Settings.");
  if (!res.ok) throw new R2Unavailable(`R2 audio unavailable (${res.status}).`);
  const bytes = await res.clone().arrayBuffer();
  // Only a complete 200 whose length matches the header is worth keeping.
  const declared = Number(res.headers.get("content-length") ?? NaN);
  if (res.status === 200 && offlineCacheSupported() && (!Number.isFinite(declared) || declared === bytes.byteLength)) {
    try {
      await (await caches.open(R2_CACHE_NAME)).put(cacheKey(key), new Response(bytes, { headers: { "content-type": res.headers.get("content-type") ?? "audio/mpeg" } }));
    } catch {
      /* quota: playing still works */
    }
  }
  return bytes;
}

export type PinProgress = { done: number; total: number; failed: string[]; bytes: number };

/** Download tracks into the offline cache, a couple at a time. */
export async function pinOffline(
  keys: string[],
  onProgress: (p: PinProgress) => void = () => {},
  concurrency = 2,
  fetchImpl: typeof fetch = fetch,
): Promise<PinProgress> {
  const p: PinProgress = { done: 0, total: keys.length, failed: [], bytes: 0 };
  const queue = [...keys];
  const worker = async () => {
    for (;;) {
      const key = queue.shift();
      if (key === undefined) return;
      try {
        const size = (await fetchR2Audio(key, fetchImpl)).byteLength; // await first: `+=` would read p.bytes before a concurrent worker updated it
        p.bytes += size;
      } catch {
        p.failed.push(key);
      }
      p.done++;
      onProgress({ ...p, failed: [...p.failed] });
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
  return p;
}
