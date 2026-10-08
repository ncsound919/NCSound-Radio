import { useEffect, useState, useSyncExternalStore } from 'react';
import { AppState } from 'react-native';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getClient } from './client';
import { getPrefs, subscribePrefs, type Prefs } from './prefs';

/** True while the app is foregrounded; polling is gated on it. */
export function useAppActive(): boolean {
  const [active, setActive] = useState(AppState.currentState === 'active');
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => setActive(state === 'active'));
    return () => sub.remove();
  }, []);
  return active;
}

export function usePrefs(): Prefs {
  return useSyncExternalStore(subscribePrefs, getPrefs, getPrefs);
}

export function useStream() {
  return useQuery({
    queryKey: ['stream'],
    queryFn: () => getClient().getStream(),
    staleTime: 60_000,
  });
}

/** Polls only while foregrounded. A 503 offline document is data, not an error. */
export function useNowPlaying() {
  const active = useAppActive();
  return useQuery({
    queryKey: ['nowplaying'],
    queryFn: () => getClient().getNowPlaying(),
    refetchInterval: active ? 15_000 : false,
  });
}

export function useSchedule() {
  return useQuery({
    queryKey: ['schedule'],
    queryFn: () => getClient().getSchedule(),
    staleTime: 60_000,
  });
}

export function useRequests() {
  return useQuery({
    queryKey: ['requests'],
    queryFn: () => getClient().getRequests(),
    staleTime: 30_000,
  });
}

export function useTracks() {
  return useQuery({
    queryKey: ['tracks'],
    queryFn: () => getClient().getTracks(),
    staleTime: 300_000,
  });
}

/** Show-only live video descriptor. */
export function useVideo() {
  const active = useAppActive();
  return useQuery({
    queryKey: ['video'],
    queryFn: () => getClient().getVideo(),
    refetchInterval: active ? 30_000 : false,
  });
}

export function useSubmitRequest() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { trackId: string; listenerName: string; note?: string | null }) =>
      getClient().postRequest(input),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['requests'] });
    },
  });
}
