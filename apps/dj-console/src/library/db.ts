/**
 * One IndexedDB database for the whole library.
 *
 * Stores:
 *   tracks    metadata for every known track (no audio)
 *   blobs     uploaded file bytes, keyed by track id
 *   handles   FileSystemDirectoryHandle, keyed by track id's handleId
 *   analysis  cached analysis + waveform, keyed by content hash
 *   crates    named track-id lists
 *   meta      Up Next queue, session history, small flags
 *
 * The analysis cache is rebuildable, so it is never the only copy of anything.
 */

const DB_NAME = "ncsound.library.v1";
const DB_VERSION = 1;
export const STORES = ["tracks", "blobs", "handles", "analysis", "crates", "meta"] as const;
export type StoreName = (typeof STORES)[number];

/** Which field is the key in each store. */
const KEY_PATH: Record<StoreName, string> = {
  tracks: "id",
  blobs: "id",
  handles: "id",
  analysis: "cacheKey",
  crates: "name",
  meta: "key",
};

let dbPromise: Promise<IDBDatabase> | null = null;

export function indexedDbAvailable(): boolean {
  return typeof indexedDB !== "undefined";
}

export function libraryDb(): Promise<IDBDatabase> {
  if (!indexedDbAvailable()) return Promise.reject(new Error("IndexedDB is unavailable in this environment"));
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const name of STORES) {
        if (!db.objectStoreNames.contains(name)) {
          db.createObjectStore(name, { keyPath: KEY_PATH[name] });
        }
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function request<T>(store: StoreName, mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return libraryDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction(store, mode);
        const req = run(tx.objectStore(store));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      }),
  );
}

export function idbGet<T>(store: StoreName, key: string): Promise<T | undefined> {
  return request<T | undefined>(store, "readonly", (s) => s.get(key) as IDBRequest<T | undefined>);
}

export function idbGetAll<T>(store: StoreName): Promise<T[]> {
  return request<T[]>(store, "readonly", (s) => s.getAll() as IDBRequest<T[]>);
}

export function idbPut(store: StoreName, value: unknown): Promise<void> {
  return request(store, "readwrite", (s) => s.put(value) as IDBRequest<IDBValidKey>).then(() => undefined);
}

export function idbDelete(store: StoreName, key: string): Promise<void> {
  return request(store, "readwrite", (s) => s.delete(key)).then(() => undefined);
}
