/**
 * Devices, push preferences and profile.
 *
 * These are the small, easy-to-get-wrong writes around the listener account: a
 * device token that is blank, a preference patch that silently drops a field, a
 * display name that is only whitespace. They are validated here so the screens
 * stay thin and the same rules apply on both platforms.
 */

import type { DevicesGateway, PrefsGateway, ProfileGateway } from "./gateways";
import {
  type Device,
  type DevicePlatform,
  type FavoriteKey,
  type FavoriteKind,
  type Profile,
  type PushPrefs,
} from "./types";

const FAVORITE_KINDS: FavoriteKind[] = ["station", "artist", "track"];

/** Map a React Native `Platform.OS` (or a user agent hint) to our two values. */
export function normalizePlatform(value: string | null | undefined): DevicePlatform | null {
  if (!value) return null;
  const v = value.toLowerCase();
  if (v === "ios" || v === "iphone" || v === "ipad") return "ios";
  if (v === "android") return "android";
  return null;
}

export async function registerDevice(
  gateway: DevicesGateway,
  input: { platform: string; pushToken: string },
): Promise<Device> {
  const platform = normalizePlatform(input.platform);
  if (!platform) throw new Error(`unsupported platform: ${String(input.platform)}`);
  const pushToken = input.pushToken.trim();
  if (!pushToken) throw new Error("push token is empty");
  return gateway.upsert({ platform, pushToken });
}

export async function unregisterDevice(
  gateway: DevicesGateway,
  pushToken: string,
): Promise<void> {
  const token = pushToken.trim();
  if (token) await gateway.remove(token);
}

export async function loadPushPrefs(gateway: PrefsGateway): Promise<PushPrefs> {
  return gateway.get();
}

export async function savePushPrefs(
  gateway: PrefsGateway,
  patch: Partial<PushPrefs>,
): Promise<PushPrefs> {
  return gateway.update(patch);
}

export async function updateDisplayName(
  gateway: ProfileGateway,
  name: string,
): Promise<Profile> {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("display name cannot be empty");
  if (trimmed.length > 64) throw new Error("display name is too long (max 64)");
  return gateway.updateDisplayName(trimmed);
}

/**
 * Parse the web player's `localStorage` favorites into keys for migration on
 * first sign-in. Accepts the shapes the old store may have written and ignores
 * anything it cannot understand rather than throwing.
 */
export function parseLocalFavorites(raw: unknown): FavoriteKey[] {
  if (!Array.isArray(raw)) return [];
  const out: FavoriteKey[] = [];
  for (const entry of raw) {
    if (typeof entry === "string") {
      // Legacy "kind:ref" strings; a bare ref is treated as a track.
      const idx = entry.indexOf(":");
      if (idx > 0) {
        const kind = entry.slice(0, idx);
        const ref = entry.slice(idx + 1);
        if (isKind(kind) && ref) out.push({ kind, ref });
      } else if (entry) {
        out.push({ kind: "track", ref: entry });
      }
      continue;
    }
    if (entry && typeof entry === "object") {
      const kind = (entry as { kind?: unknown }).kind;
      const ref = (entry as { ref?: unknown }).ref;
      if (typeof kind === "string" && isKind(kind) && typeof ref === "string" && ref) {
        out.push({ kind, ref });
      }
    }
  }
  return out;
}

function isKind(value: string): value is FavoriteKind {
  return (FAVORITE_KINDS as string[]).includes(value);
}
