import { useEffect } from 'react';
import { useSession } from '../auth/session';
import { registerDeviceToken } from './register';
import { devicePlatform, ensurePushPermission, getDevicePushToken } from './token';

/**
 * Register this device for push once the listener is signed in.
 *
 * Flow: permission -> OS token (APNs on iOS) -> upsert into Supabase `devices`.
 * Signed-out listeners are skipped (a device must belong to a user for the
 * sender to honour their preferences). Failure is silent here; a missing token
 * simply means no OS push, and the in-app Realtime path still works.
 */
export function usePushRegistration(): void {
  const { user } = useSession();

  useEffect(() => {
    if (!user) return;
    let cancelled = false;

    void (async () => {
      const granted = await ensurePushPermission();
      if (!granted || cancelled) return;
      const token = await getDevicePushToken();
      if (token && !cancelled) await registerDeviceToken(token, devicePlatform);
    })().catch(() => {
      /* push is best-effort; never block the app on it */
    });

    return () => {
      cancelled = true;
    };
  }, [user]);
}
