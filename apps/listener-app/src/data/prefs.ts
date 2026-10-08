import AsyncStorage from '@react-native-async-storage/async-storage';

/**
 * Local, non-secret preferences. Persisted in AsyncStorage and exposed through a
 * tiny external store so any screen can read them with `usePrefs()`.
 */
export type Prefs = { dataSaver: boolean; watchVideo: boolean };

const KEY = 'ncsound-prefs-v1';

let prefs: Prefs = { dataSaver: false, watchVideo: true };
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

export function getPrefs(): Prefs {
  return prefs;
}

export function subscribePrefs(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export async function loadPrefs(): Promise<void> {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    if (raw) prefs = { ...prefs, ...(JSON.parse(raw) as Partial<Prefs>) };
  } catch {
    /* first run / unreadable -> defaults */
  }
  emit();
}

export async function setDataSaver(value: boolean): Promise<void> {
  prefs = { ...prefs, dataSaver: value };
  emit();
  try {
    await AsyncStorage.setItem(KEY, JSON.stringify(prefs));
  } catch {
    /* non-fatal */
  }
}

export async function setWatchVideo(value: boolean): Promise<void> {
  prefs = { ...prefs, watchVideo: value };
  emit();
  try {
    await AsyncStorage.setItem(KEY, JSON.stringify(prefs));
  } catch {
    /* non-fatal */
  }
}
