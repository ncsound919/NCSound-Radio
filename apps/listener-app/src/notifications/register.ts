import { supabase } from '../auth/supabase';

export type DevicePlatform = 'ios' | 'android';

/**
 * Store this device's push token in Supabase (`devices`).
 *
 * The token comes from the OS — APNs on iOS, FCM on Android — obtained by a
 * native module that is not wired here. This function is the Supabase side:
 * given a token, it registers it for the signed-in user. Returns false when
 * signed out or when Supabase is not configured.
 */
export async function registerDeviceToken(
  token: string,
  platform: DevicePlatform,
): Promise<boolean> {
  if (!supabase || !token) return false;
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return false;
  const { error } = await supabase
    .from('devices')
    .upsert(
      { user_id: user.id, platform, push_token: token },
      { onConflict: 'user_id,push_token' },
    );
  return !error;
}

/** Remove this device's token (e.g. on sign-out). */
export async function unregisterDeviceToken(token: string): Promise<void> {
  if (!supabase || !token) return;
  await supabase.from('devices').delete().match({ push_token: token });
}
