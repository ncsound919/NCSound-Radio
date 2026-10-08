import { configureStationClient, type StationClient } from '@ncsound/station-client';
import { env } from '../config/env';
import { supabase } from '../auth/supabase';

/**
 * One configured station-client for the whole app. The base URL comes from
 * config; requests carry the Supabase access token when signed in, so
 * `POST /api/requests` is attributed to the user.
 */
let client: StationClient | null = null;

export function getClient(): StationClient {
  if (!client) {
    client = configureStationClient({
      baseUrl: env.apiBaseUrl,
      getAuthToken: async () => {
        if (!supabase) return null;
        const { data } = await supabase.auth.getSession();
        return data.session?.access_token ?? null;
      },
    });
  }
  return client;
}
