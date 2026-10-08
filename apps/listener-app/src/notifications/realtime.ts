import { useEffect } from 'react';
import { supabase } from '../auth/supabase';

export type StationAnnouncement = {
  title: string;
  body: string;
  data?: Record<string, string>;
};

/**
 * Supabase Realtime (broadcast) subscription for in-app announcements — the
 * Firebase-free path. The station broadcasts on the `station` channel and the
 * app shows a banner while it is open. OS push when the app is closed is a
 * separate, per-platform transport (APNs on iOS; FCM on Android).
 */
export function useStationAnnouncements(
  onEvent: (announcement: StationAnnouncement) => void,
): void {
  useEffect(() => {
    if (!supabase) return;
    const channel = supabase
      .channel('station')
      .on('broadcast', { event: 'announcement' }, (msg) => {
        const payload = (msg.payload ?? {}) as Partial<StationAnnouncement>;
        if (payload.title) {
          onEvent({ title: payload.title, body: payload.body ?? '', data: payload.data });
        }
      })
      .subscribe();
    return () => {
      void supabase!.removeChannel(channel);
    };
  }, [onEvent]);
}

/** Broadcast an announcement to listeners (operator/infra use). */
export async function broadcastAnnouncement(announcement: StationAnnouncement): Promise<void> {
  if (!supabase) return;
  const channel = supabase.channel('station');
  await channel.send({ type: 'broadcast', event: 'announcement', payload: announcement });
  await supabase.removeChannel(channel);
}
