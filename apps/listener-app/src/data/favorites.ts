import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../auth/supabase';

/**
 * Favorites, synced per user via Supabase (RLS scopes rows to `auth.uid()`).
 *
 * The web app stored favorites in `localStorage`; there is nothing to migrate
 * here because React Native has no `localStorage` and the app starts from an
 * empty server-side list. Signed-out listeners simply have no favorites.
 */
export type FavoriteKind = 'station' | 'artist' | 'track';
export type Favorite = { id: string; kind: FavoriteKind; ref: string };

export const STATION_REF = 'ncsound';

function requireClient() {
  if (!supabase) throw new Error('Sign-in is not configured for this build.');
  return supabase;
}

export function useFavorites() {
  return useQuery({
    queryKey: ['favorites'],
    enabled: Boolean(supabase),
    queryFn: async (): Promise<Favorite[]> => {
      const sb = requireClient();
      const { data, error } = await sb.from('favorites').select('id,kind,ref');
      if (error) throw new Error(error.message);
      return (data ?? []) as Favorite[];
    },
  });
}

export function useIsFavorite(kind: FavoriteKind, ref: string) {
  const { data } = useFavorites();
  return (data ?? []).some((f) => f.kind === kind && f.ref === ref);
}

export function useToggleFavorite() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { kind: FavoriteKind; ref: string; on: boolean }) => {
      const sb = requireClient();
      const {
        data: { user },
      } = await sb.auth.getUser();
      if (!user) throw new Error('Sign in to save favorites.');

      if (input.on) {
        const { error } = await sb
          .from('favorites')
          .upsert(
            { user_id: user.id, kind: input.kind, ref: input.ref },
            { onConflict: 'user_id,kind,ref', ignoreDuplicates: true },
          );
        if (error) throw new Error(error.message);
      } else {
        const { error } = await sb
          .from('favorites')
          .delete()
          .match({ user_id: user.id, kind: input.kind, ref: input.ref });
        if (error) throw new Error(error.message);
      }
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['favorites'] });
    },
  });
}
