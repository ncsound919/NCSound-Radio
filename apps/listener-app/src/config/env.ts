import Config from 'react-native-config';

/**
 * Resolved, non-secret runtime config.
 *
 * react-native-config bakes `.env.*` at build time. When the native module is
 * not present yet (e.g. before `pod install`) or a key is blank, `Config` can be
 * empty — so every value falls back to a safe development default and the app
 * still runs. Nothing here is a secret; RLS on Supabase is the boundary.
 */
const raw = (Config ?? {}) as Record<string, string | undefined>;

const trimSlash = (v: string): string => v.replace(/\/+$/, '');

export const env = {
  /** Public JSON API base. */
  apiBaseUrl: trimSlash(raw.API_BASE_URL || 'http://127.0.0.1:3100'),
  /** Icecast stream base (authoritative URLs still come from GET /api/stream). */
  streamBaseUrl: trimSlash(raw.STREAM_BASE_URL || 'http://127.0.0.1:8010'),
  supabaseUrl: raw.SUPABASE_URL || '',
  supabaseAnonKey: raw.SUPABASE_ANON_KEY || '',
} as const;

export type Env = typeof env;
