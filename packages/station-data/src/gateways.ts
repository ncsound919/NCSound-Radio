/**
 * The data layer's ports.
 *
 * The stores (favorites, devices, prefs) depend on these interfaces, not on
 * Supabase, so their behaviour — optimistic toggles, rollback, local-favorite
 * migration, device re-registration — is unit-tested against an in-memory
 * gateway with no network. `rest.ts` is the Supabase-backed adapter.
 */

import type {
  Device,
  DevicePlatform,
  Favorite,
  FavoriteKey,
  FavoriteKind,
  Profile,
  PushPrefs,
} from "./types";

export interface FavoritesGateway {
  list(kind?: FavoriteKind): Promise<Favorite[]>;
  /** Idempotent: adding an existing favorite returns the existing row. */
  add(input: FavoriteKey): Promise<Favorite>;
  remove(input: FavoriteKey): Promise<void>;
}

export interface DevicesGateway {
  /** Upsert on (user, token): re-registering the same device is a no-op update. */
  upsert(input: { platform: DevicePlatform; pushToken: string }): Promise<Device>;
  remove(pushToken: string): Promise<void>;
  list(): Promise<Device[]>;
}

export interface PrefsGateway {
  /** Returns the table defaults when the user has no row yet. */
  get(): Promise<PushPrefs>;
  update(patch: Partial<PushPrefs>): Promise<PushPrefs>;
}

export interface ProfileGateway {
  get(): Promise<Profile | null>;
  updateDisplayName(name: string): Promise<Profile>;
}

export interface StationDataGateways {
  favorites: FavoritesGateway;
  devices: DevicesGateway;
  prefs: PrefsGateway;
  profile: ProfileGateway;
}
