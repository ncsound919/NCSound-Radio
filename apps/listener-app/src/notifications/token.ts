import { PermissionsAndroid, Platform } from 'react-native';
import PushNotificationIOS from '@react-native-community/push-notification-ios';
import type { DevicePlatform } from './register';

export const devicePlatform: DevicePlatform = Platform.OS === 'ios' ? 'ios' : 'android';

/** Ask the OS for notification permission. */
export async function ensurePushPermission(): Promise<boolean> {
  if (Platform.OS === 'ios') {
    const perms = await PushNotificationIOS.requestPermissions({
      alert: true,
      badge: true,
      sound: true,
    });
    return Boolean(perms.alert || perms.badge || perms.sound);
  }
  const result = await PermissionsAndroid.request(
    PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS,
  );
  return result === PermissionsAndroid.RESULTS.GRANTED;
}

/**
 * The OS device token.
 *
 * iOS: the **APNs** token via the community module — Firebase-free.
 * Android: returns null. Android has no non-Google push transport, so OS push
 * needs the Firebase SDK; until that is added, Android relies on the Supabase
 * Realtime in-app path (see the push-transport lesson).
 */
export async function getDevicePushToken(): Promise<string | null> {
  if (Platform.OS !== 'ios') return null;

  return new Promise<string | null>((resolve) => {
    let settled = false;
    const finish = (token: string | null): void => {
      if (settled) return;
      settled = true;
      PushNotificationIOS.removeEventListener('register');
      PushNotificationIOS.removeEventListener('registrationError');
      resolve(token);
    };
    const onRegister = (token: string): void => finish(token);
    const onError = (): void => finish(null);

    PushNotificationIOS.addEventListener('register', onRegister);
    PushNotificationIOS.addEventListener('registrationError', onError);
    // Triggers registerForRemoteNotifications; the 'register' event follows.
    PushNotificationIOS.requestPermissions().catch(() => finish(null));
    // Do not hang forever if the OS never answers (e.g. simulator).
    setTimeout(() => finish(null), 15000);
  });
}
