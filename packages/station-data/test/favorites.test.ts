import { describe, expect, test } from "bun:test";
import {
  countByKind,
  createFavoritesStore,
  createMemoryGateways,
} from "../src/index.ts";
import type { FavoritesGateway } from "../src/gateways.ts";

describe("favorites store", () => {
  test("load populates and notifies subscribers", async () => {
    const gateways = createMemoryGateways();
    await gateways.favorites.add({ kind: "artist", ref: "Jaz" });
    const store = createFavoritesStore(gateways.favorites);

    const seen: number[] = [];
    store.subscribe((s) => seen.push(s.items.length));

    await store.load();
    expect(store.getState().loaded).toBe(true);
    expect(store.isFavorite({ kind: "artist", ref: "Jaz" })).toBe(true);
    expect(seen.at(-1)).toBe(1);
  });

  test("toggle adds then removes", async () => {
    const store = createFavoritesStore(createMemoryGateways().favorites);

    expect(await store.toggle({ kind: "track", ref: "t1" })).toBe(true);
    expect(store.isFavorite({ kind: "track", ref: "t1" })).toBe(true);

    expect(await store.toggle({ kind: "track", ref: "t1" })).toBe(false);
    expect(store.isFavorite({ kind: "track", ref: "t1" })).toBe(false);
  });

  test("an optimistic add rolls back when the write is rejected", async () => {
    const failing: FavoritesGateway = {
      list: async () => [],
      add: async () => {
        throw new Error("network down");
      },
      remove: async () => {},
    };
    const store = createFavoritesStore(failing);

    await expect(store.toggle({ kind: "artist", ref: "Jaz" })).rejects.toThrow("network down");
    expect(store.getState().items).toHaveLength(0);
    expect(store.getState().error).toBe("network down");
  });

  test("an optimistic remove rolls back when the delete is rejected", async () => {
    const gateways = createMemoryGateways();
    await gateways.favorites.add({ kind: "artist", ref: "Jaz" });
    const store = createFavoritesStore({
      ...gateways.favorites,
      remove: async () => {
        throw new Error("offline");
      },
    });
    await store.load();

    await expect(store.toggle({ kind: "artist", ref: "Jaz" })).rejects.toThrow("offline");
    expect(store.isFavorite({ kind: "artist", ref: "Jaz" })).toBe(true);
  });

  test("migrateLocal merges without duplicating what the account already has", async () => {
    const gateways = createMemoryGateways();
    await gateways.favorites.add({ kind: "station", ref: "ncsound" });
    const store = createFavoritesStore(gateways.favorites);
    await store.load();

    const added = await store.migrateLocal([
      { kind: "station", ref: "ncsound" },
      { kind: "track", ref: "t1" },
      { kind: "track", ref: "t1" },
      { kind: "artist", ref: "Jaz" },
    ]);

    expect(added).toBe(2);
    expect(store.getState().items).toHaveLength(3);
    expect(countByKind(store.getState().items, "track")).toBe(1);
  });
});
