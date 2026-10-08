import 'react-native-url-polyfill/auto';
import { AppState } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { env } from '../config/env';

/**
 * Supabase client. Null when Supabase is not configured (blank env), so a fresh
 * checkout runs signed-out instead of crashing. RLS is the data boundary; only
 * the publishable URL/key live here.
 */
export const supabase: SupabaseClient | null =
  env.supabaseUrl && env.supabaseAnonKey
    ? createClient(env.supabaseUrl, env.supabaseAnonKey, {
        auth: {
          storage: AsyncStorage,
          autoRefreshToken: true,
          persistSession: true,
          // Native apps have no URL to read a session from.
          detectSessionInUrl: false,
        },
      })
    : null;

export const isAuthConfigured: boolean = supabase !== null;

/** Tie the token-refresh loop to app foreground state (Supabase guidance). */
export function bindAuthToAppState(): () => void {
  if (!supabase) return () => {};
  const sub = AppState.addEventListener('change', (state) => {
    if (state === 'active') supabase.auth.startAutoRefresh();
    else supabase.auth.stopAutoRefresh();
  });
  return () => sub.remove();
}

/**
 * Complete an OAuth / magic-link return. Parses `access_token` + `refresh_token`
 * from the URL (query or fragment) and installs the session. Returns whether a
 * session was established.
 */
export async function handleAuthUrl(url: string): Promise<boolean> {
  if (!supabase) return false;
  try {
    const parsed = new URL(url);
    const hash = parsed.hash.startsWith('#') ? parsed.hash.slice(1) : parsed.hash;
    const params = new URLSearchParams(hash || parsed.search);
    const access_token = params.get('access_token');
    const refresh_token = params.get('refresh_token');
    if (!access_token || !refresh_token) return false;
    const { error } = await supabase.auth.setSession({ access_token, refresh_token });
    return !error;
  } catch {
    return false;
  }
}
