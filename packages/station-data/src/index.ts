/**
 * @ncsound/station-data
 *
 * The listener app's account data layer. Stores depend on the gateway ports in
 * `gateways.ts`, so they are unit-tested without a network; `rest.ts` is the
 * Supabase/PostgREST adapter the app wires up with its publishable key and the
 * signed-in session token.
 */

export type * from "./types";
export { DEFAULT_PUSH_PREFS } from "./types";
export type * from "./gateways";
export { createMemoryGateways } from "./memory";
export { createFavoritesStore, countByKind } from "./favorites";
export type { FavoritesState, FavoritesStore } from "./favorites";
export {
  loadPushPrefs,
  normalizePlatform,
  parseLocalFavorites,
  registerDevice,
  savePushPrefs,
  unregisterDevice,
  updateDisplayName,
} from "./account";
export { createRestGateways, StationDataError } from "./rest";
export type { SupabaseRestConfig } from "./rest";
