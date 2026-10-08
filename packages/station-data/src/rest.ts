/**
 * Supabase-backed gateways over PostgREST.
 *
 * Deliberately dependency-free: the app talks to Supabase with plain `fetch`
 * (apikey + the listener's session JWT), the same way station-web verifies a
 * request's user. `user_id` is omitted on writes because the table default is
 * `auth.uid()` and RLS rejects a forged value, so the client cannot attribute a
 * row to someone else even if it tried.
 *
 * The query shapes here are unit-tested against a fake fetch; the live round
 * trip against a real project is verified separately with credentials.
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

export type SupabaseRestConfig = {
  /** Project origin, e.g. `https://<ref>.supabase.co`. */
  url: string;
  /** The publishable/anon key. Never the service role key. */
  anonKey: string;
  /** The signed-in listener's access token, or null when signed out. */
  getAccessToken: () => string | null | Promise<string | null>;
  fetchImpl?: typeof fetch;
};

export class StationDataError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(status: number, message: string, body: unknown) {
    super(message);
    this.name = "StationDataError";
    this.status = status;
    this.body = body;
  }
}

function errorMessage(body: unknown, fallback: string): string {
  if (body && typeof body === "object") {
    const record = body as Record<string, unknown>;
    if (typeof record.message === "string" && record.message) return record.message;
    if (typeof record.error === "string" && record.error) return record.error;
    if (typeof record.hint === "string" && record.hint) return record.hint;
  }
  return fallback;
}

function eq(value: string): string {
  return encodeURIComponent(value);
}

export function createRestGateways(config: SupabaseRestConfig): StationDataGateways {
  const base = config.url.replace(/\/+$/, "");
  const doFetch = config.fetchImpl ?? fetch;

  async function call<T>(
    path: string,
    init: RequestInit = {},
  ): Promise<T> {
    const token = await config.getAccessToken();
    if (!token) throw new StationDataError(401, "not signed in", null);
    const res = await doFetch(`${base}/rest/v1${path}`, {
      ...init,
      headers: {
        apikey: config.anonKey,
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        ...((init.headers as Record<string, string> | undefined) ?? {}),
      },
      cache: "no-store",
    });

    const text = await res.text();
    let body: unknown = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }
    if (!res.ok) {
      throw new StationDataError(
        res.status,
        errorMessage(body, `request failed: ${res.status}`),
        body,
      );
    }
    return body as T;
  }

  const favorites: FavoritesGateway = {
    async list(kind?: FavoriteKind) {
      const filter = kind ? `&kind=eq.${eq(kind)}` : "";
      const rows = await call<FavoriteRow[]>(
        `/favorites?select=id,kind,ref,created_at&order=created_at.desc${filter}`,
      );
      return rows.map(toFavorite);
    },
    async add(input: FavoriteKey) {
      // on_conflict MUST name the natural key: merge-duplicates otherwise targets
      // the generated `id` PK, which never collides, so a repeat insert hits the
      // unique (user_id,kind,ref) and 409s instead of merging.
      const rows = await call<FavoriteRow[]>(
        "/favorites?select=id,kind,ref,created_at&on_conflict=user_id,kind,ref",
        {
          method: "POST",
          headers: { prefer: "resolution=merge-duplicates,return=representation" },
          body: JSON.stringify({ kind: input.kind, ref: input.ref }),
        },
      );
      const row = rows[0];
      if (!row) throw new StationDataError(500, "favorite write returned no row", rows);
      return toFavorite(row);
    },
    async remove(input: FavoriteKey) {
      await call<null>(`/favorites?kind=eq.${eq(input.kind)}&ref=eq.${eq(input.ref)}`, {
        method: "DELETE",
        headers: { prefer: "return=minimal" },
      });
    },
  };

  const devices: DevicesGateway = {
    async upsert(input: { platform: DevicePlatform; pushToken: string }) {
      const rows = await call<DeviceRow[]>("/devices?select=id,platform,push_token,updated_at&on_conflict=user_id,push_token", {
        method: "POST",
        headers: { prefer: "resolution=merge-duplicates,return=representation" },
        body: JSON.stringify({ platform: input.platform, push_token: input.pushToken }),
      });
      const row = rows[0];
      if (!row) throw new StationDataError(500, "device write returned no row", rows);
      return toDevice(row);
    },
    async remove(pushToken: string) {
      await call<null>(`/devices?push_token=eq.${eq(pushToken)}`, {
        method: "DELETE",
        headers: { prefer: "return=minimal" },
      });
    },
    async list() {
      const rows = await call<DeviceRow[]>(
        "/devices?select=id,platform,push_token,updated_at&order=updated_at.desc",
      );
      return rows.map(toDevice);
    },
  };

  const prefs: PrefsGateway = {
    async get() {
      const rows = await call<PrefsRow[]>(
        "/push_prefs?select=artist_on_air,request_played,show_start&limit=1",
      );
      return rows[0] ? toPrefs(rows[0]) : { ...DEFAULT_PUSH_PREFS };
    },
    async update(patch: Partial<PushPrefs>) {
      const current = await prefs.get();
      const merged: PushPrefs = { ...current, ...patch };
      const rows = await call<PrefsRow[]>(
        "/push_prefs?select=artist_on_air,request_played,show_start&on_conflict=user_id",
        {
          method: "POST",
          headers: { prefer: "resolution=merge-duplicates,return=representation" },
          body: JSON.stringify(toPrefsRow(merged)),
        },
      );
      return rows[0] ? toPrefs(rows[0]) : merged;
    },
  };

  const profile: ProfileGateway = {
    async get() {
      const rows = await call<ProfileRow[]>(
        "/profiles?select=id,display_name,created_at&limit=1",
      );
      return rows[0] ? toProfile(rows[0]) : null;
    },
    async updateDisplayName(name: string) {
      const current = await profile.get();
      if (!current) throw new StationDataError(404, "no profile row for this user", null);
      const rows = await call<ProfileRow[]>(
        `/profiles?id=eq.${eq(current.id)}&select=id,display_name,created_at`,
        {
          method: "PATCH",
          headers: { prefer: "return=representation" },
          body: JSON.stringify({ display_name: name }),
        },
      );
      const row = rows[0];
      if (!row) throw new StationDataError(500, "profile update returned no row", rows);
      return toProfile(row);
    },
  };

  return { favorites, devices, prefs, profile };
}

type FavoriteRow = { id: string; kind: FavoriteKind; ref: string; created_at: string };
type DeviceRow = { id: string; platform: DevicePlatform; push_token: string; updated_at: string };
type PrefsRow = { artist_on_air: boolean; request_played: boolean; show_start: boolean };
type ProfileRow = { id: string; display_name: string | null; created_at: string };

function toFavorite(row: FavoriteRow): Favorite {
  return { id: row.id, kind: row.kind, ref: row.ref, createdAt: row.created_at };
}

function toDevice(row: DeviceRow): Device {
  return { id: row.id, platform: row.platform, pushToken: row.push_token, updatedAt: row.updated_at };
}

function toPrefs(row: PrefsRow): PushPrefs {
  return {
    artistOnAir: row.artist_on_air,
    requestPlayed: row.request_played,
    showStart: row.show_start,
  };
}

function toPrefsRow(prefs: PushPrefs): PrefsRow {
  return {
    artist_on_air: prefs.artistOnAir,
    request_played: prefs.requestPlayed,
    show_start: prefs.showStart,
  };
}

function toProfile(row: ProfileRow): Profile {
  return { id: row.id, displayName: row.display_name, createdAt: row.created_at };
}
