/**
 * Listener account data, mirroring the Supabase identity tables applied in
 * `supabase/migrations/20261007000000_init_identity.sql`. Only the columns the
 * app reads/writes are modelled; RLS (`auth.uid() = user_id`) is the boundary.
 */

export type FavoriteKind = "station" | "artist" | "track";

export type Favorite = {
  id: string;
  kind: FavoriteKind;
  ref: string;
  createdAt: string;
};

/** A favorite identified by what it points at, before it has a row id. */
export type FavoriteKey = { kind: FavoriteKind; ref: string };

export type DevicePlatform = "ios" | "android";

export type Device = {
  id: string;
  platform: DevicePlatform;
  pushToken: string;
  updatedAt: string;
};

export type PushPrefs = {
  artistOnAir: boolean;
  requestPlayed: boolean;
  showStart: boolean;
};

export type Profile = {
  id: string;
  displayName: string | null;
  createdAt: string;
};

/** Every preference defaults on, matching the table defaults. */
export const DEFAULT_PUSH_PREFS: PushPrefs = {
  artistOnAir: true,
  requestPlayed: true,
  showStart: true,
};
