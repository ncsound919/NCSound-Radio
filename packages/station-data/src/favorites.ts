/**
 * The favorites store ("My Waves").
 *
 * `toggle` is optimistic: the item flips in the local list before the write
 * returns, and rolls back on failure. That matters on cellular — a favorite tap
 * must feel instant and must not silently lie if the write is rejected.
 */

import type { FavoritesGateway } from "./gateways";
import type { Favorite, FavoriteKey, FavoriteKind } from "./types";

export type FavoritesState = {
  items: Favorite[];
  loaded: boolean;
  error: string | null;
};

export type FavoritesStore = {
  getState(): FavoritesState;
  subscribe(listener: (state: FavoritesState) => void): () => void;
  load(): Promise<void>;
  isFavorite(key: FavoriteKey): boolean;
  /** Returns true if the item is now a favorite, false if it was removed. */
  toggle(key: FavoriteKey): Promise<boolean>;
  /** Union-merge local (pre-sign-in) favorites into the account. */
  migrateLocal(entries: FavoriteKey[]): Promise<number>;
};

function keyOf(key: FavoriteKey): string {
  return `${key.kind}:${key.ref}`;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createFavoritesStore(gateway: FavoritesGateway): FavoritesStore {
  let state: FavoritesState = { items: [], loaded: false, error: null };
  const listeners = new Set<(state: FavoritesState) => void>();

  function set(patch: Partial<FavoritesState>): void {
    state = { ...state, ...patch };
    for (const listener of listeners) listener(state);
  }

  function contains(key: FavoriteKey): boolean {
    return state.items.some((f) => f.kind === key.kind && f.ref === key.ref);
  }

  async function load(): Promise<void> {
    try {
      const items = await gateway.list();
      set({ items, loaded: true, error: null });
    } catch (error) {
      set({ error: message(error) });
      throw error;
    }
  }

  async function toggle(key: FavoriteKey): Promise<boolean> {
    const before = state.items;

    if (contains(key)) {
      set({ items: before.filter((f) => !(f.kind === key.kind && f.ref === key.ref)), error: null });
      try {
        await gateway.remove(key);
      } catch (error) {
        set({ items: before, error: message(error) });
        throw error;
      }
      return false;
    }

    const optimistic: Favorite = {
      id: `local:${keyOf(key)}`,
      kind: key.kind,
      ref: key.ref,
      createdAt: new Date().toISOString(),
    };
    set({ items: [...before, optimistic], error: null });
    try {
      const row = await gateway.add(key);
      set({ items: state.items.map((f) => (f.id === optimistic.id ? row : f)) });
      return true;
    } catch (error) {
      set({ items: before, error: message(error) });
      throw error;
    }
  }

  async function migrateLocal(entries: FavoriteKey[]): Promise<number> {
    const seen = new Set(state.items.map(keyOf));
    const missing: FavoriteKey[] = [];
    for (const entry of entries) {
      const key = keyOf(entry);
      if (seen.has(key)) continue;
      seen.add(key);
      missing.push(entry);
    }
    for (const entry of missing) {
      try {
        await gateway.add(entry);
      } catch {
        // A single failed local favorite must not abort the migration.
      }
    }
    if (missing.length > 0) await load();
    return missing.length;
  }

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    load,
    isFavorite: contains,
    toggle,
    migrateLocal,
  };
}

/** Distinct kinds present, for the Settings / My Waves summary rows. */
export function countByKind(items: Favorite[], kind: FavoriteKind): number {
  return items.filter((f) => f.kind === kind).length;
}
