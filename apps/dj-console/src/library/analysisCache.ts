/**
 * The analysis cache: analysis + waveform keyed by content hash.
 *
 * A cached record lets a deck load skip the Worker entirely and pass the result
 * to `Mixer.loadBuffer` as `overrideAnalysis`. The cache is rebuildable — losing
 * it costs time, never audio.
 */
import type { AnalysisRecord } from "./types";
import { idbGet, idbGetAll, idbPut } from "./db";

const STORE = "analysis" as const;

export function getCachedAnalysis(cacheKey: string): Promise<AnalysisRecord | undefined> {
  return idbGet<AnalysisRecord>(STORE, cacheKey);
}

export function putCachedAnalysis(record: AnalysisRecord): Promise<void> {
  return idbPut(STORE, record);
}

export async function analysisCacheStats(): Promise<{ count: number; bytes: number | null }> {
  let count = 0;
  try {
    count = (await idbGetAll<AnalysisRecord>(STORE)).length;
  } catch {
    count = 0;
  }
  let bytes: number | null = null;
  try {
    const est = await navigator.storage?.estimate?.();
    bytes = est?.usage ?? null;
  } catch {
    bytes = null;
  }
  return { count, bytes };
}

/** Ask the browser not to evict the library. Returns whether it was granted. */
export async function requestPersistentStorage(): Promise<boolean | null> {
  try {
    if (!navigator.storage?.persist) return null;
    if (await navigator.storage.persisted()) return true;
    return await navigator.storage.persist();
  } catch {
    return null;
  }
}
