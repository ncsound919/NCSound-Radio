import NetInfo from '@react-native-community/netinfo';
import { env } from '../config/env';

/**
 * Real reachability, not "an interface exists".
 *
 * A phone can be joined to Wi-Fi with no route to the internet. The reconnect
 * policy only reloads when the route is genuinely back, so this probes a cheap
 * endpoint after NetInfo reports a connection.
 */
async function probe(timeoutMs = 3000): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${env.apiBaseUrl}/api/stream`, {
      signal: controller.signal,
    });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export async function hasReachability(): Promise<boolean> {
  const state = await NetInfo.fetch();
  if (state.isConnected === false) return false;
  if (state.isInternetReachable === false) return false;
  return probe();
}

/** Subscribe to coarse connectivity; returns an unsubscribe function. */
export function subscribeConnectivity(onChange: (online: boolean) => void): () => void {
  return NetInfo.addEventListener((state) =>
    onChange(state.isConnected === true && state.isInternetReachable !== false),
  );
}
