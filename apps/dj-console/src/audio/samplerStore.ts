/**
 * Sampler persistence (plan 3C.4).
 *
 * Stores each pad's original file bytes plus its config in IndexedDB, so the
 * sampler survives a reload. Bytes are decoded back into AudioBuffers at boot.
 * Nothing here is the only copy of a file; the cache is rebuildable.
 */
import type { PadConfig } from "@ncsound/dj-engine/sampler";

const DB_NAME = "ncsound-sampler";
const STORE = "pads";
const VERSION = 1;

export type StoredPad = {
  id: string;
  bank: number;
  pad: number;
  name: string;
  type: string;
  bytes: ArrayBuffer;
  config: PadConfig;
};

export const padId = (bank: number, pad: number) => `${bank}:${pad}`;

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB_NAME, VERSION);
    r.onupgradeneeded = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: "id" });
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

export async function savePad(rec: StoredPad): Promise<void> {
  const db = await open();
  try {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(rec);
    await txDone(tx);
  } finally {
    db.close();
  }
}

export async function loadPads(): Promise<StoredPad[]> {
  const db = await open();
  try {
    const tx = db.transaction(STORE, "readonly");
    const all = await req(tx.objectStore(STORE).getAll());
    return all as StoredPad[];
  } finally {
    db.close();
  }
}

export async function deletePad(bank: number, pad: number): Promise<void> {
  const db = await open();
  try {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(padId(bank, pad));
    await txDone(tx);
  } finally {
    db.close();
  }
}

export async function usage(): Promise<{ usage: number; quota: number } | null> {
  if (typeof navigator === "undefined" || !navigator.storage?.estimate) return null;
  const e = await navigator.storage.estimate();
  return { usage: e.usage ?? 0, quota: e.quota ?? 0 };
}

export async function requestPersist(): Promise<boolean> {
  if (typeof navigator === "undefined" || !navigator.storage?.persist) return false;
  try {
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}
