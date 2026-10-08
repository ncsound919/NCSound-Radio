/**
 * In-memory gateways: the store tests' fixture, and a working offline/dev
 * backend. Deterministic ids keep the optimistic-toggle tests readable.
 */

import type {
  DevicesGateway,
  FavoritesGateway,
  PrefsGateway,
  ProfileGateway,
  StationDataGateways,
} from "./gateways";
import {
  DEFAULT_PUSH_PREFS,
  type Device,
  type DevicePlatform,
  type Favorite,
  type FavoriteKey,
  type FavoriteKind,
  type Profile,
  type PushPrefs,
} from "./types";

function counter(prefix: string): () => string {
  let n = 0;
  return () => `${prefix}-${++n}`;
}

export function createMemoryGateways(): StationDataGateways {
  const favorites: Favorite[] = [];
  const nextFavoriteId = counter("fav");
  const devices: Device[] = [];
  const nextDeviceId = counter("dev");
  let prefs: PushPrefs = { ...DEFAULT_PUSH_PREFS };
  let profile: Profile | null = null;
  const now = () => new Date().toISOString();

  const favoritesGateway: FavoritesGateway = {
    async list(kind?: FavoriteKind) {
      return favorites.filter((f) => (kind ? f.kind === kind : true));
    },
    async add(input: FavoriteKey) {
      const existing = favorites.find(
        (f) => f.kind === input.kind && f.ref === input.ref,
      );
      if (existing) return existing;
      const row: Favorite = { id: nextFavoriteId(), kind: input.kind, ref: input.ref, createdAt: now() };
      favorites.push(row);
      return row;
    },
    async remove(input: FavoriteKey) {
      const i = favorites.findIndex(
        (f) => f.kind === input.kind && f.ref === input.ref,
      );
      if (i >= 0) favorites.splice(i, 1);
    },
  };

  const devicesGateway: DevicesGateway = {
    async upsert(input: { platform: DevicePlatform; pushToken: string }) {
      const existing = devices.find((d) => d.pushToken === input.pushToken);
      if (existing) {
        existing.platform = input.platform;
        existing.updatedAt = now();
        return existing;
      }
      const row: Device = { id: nextDeviceId(), platform: input.platform, pushToken: input.pushToken, updatedAt: now() };
      devices.push(row);
      return row;
    },
    async remove(pushToken: string) {
      const i = devices.findIndex((d) => d.pushToken === pushToken);
      if (i >= 0) devices.splice(i, 1);
    },
    async list() {
      return devices;
    },
  };

  const prefsGateway: PrefsGateway = {
    async get() {
      return { ...prefs };
    },
    async update(patch: Partial<PushPrefs>) {
      prefs = { ...prefs, ...patch };
      return { ...prefs };
    },
  };

  const profileGateway: ProfileGateway = {
    async get() {
      return profile;
    },
    async updateDisplayName(name: string) {
      profile = profile
        ? { ...profile, displayName: name }
        : { id: "self", displayName: name, createdAt: now() };
      return profile;
    },
  };

  return {
    favorites: favoritesGateway,
    devices: devicesGateway,
    prefs: prefsGateway,
    profile: profileGateway,
  };
}
