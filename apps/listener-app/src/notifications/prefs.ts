import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../auth/supabase';

/** The three notification preferences the sender honours (push_prefs columns). */
export type PushPrefKey = 'artist_on_air' | 'request_played' | 'show_start';
export type PushPrefs = Record<PushPrefKey, boolean>;

const DEFAULTS: PushPrefs = {
  artist_on_air: true,
  request_played: true,
  show_start: true,
};

export function usePushPrefs() {
  return useQuery({
    queryKey: ['push_prefs'],
    enabled: Boolean(supabase),
    queryFn: async (): Promise<PushPrefs> => {
      const sb = supabase!;
      const {
        data: { user },
      } = await sb.auth.getUser();
      if (!user) return DEFAULTS;
      const { data, error } = await sb
        .from('push_prefs')
        .select('artist_on_air, request_played, show_start')
        .eq('user_id', user.id)
        .maybeSingle();
      if (error) throw new Error(error.message);
      return { ...DEFAULTS, ...(data ?? {}) } as PushPrefs;
    },
  });
}

export function useSetPushPref() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { key: PushPrefKey; value: boolean }) => {
      if (!supabase) throw new Error('Sign-in is not configured.');
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) throw new Error('Sign in to change notifications.');
      const { error } = await supabase
        .from('push_prefs')
        .upsert({ user_id: user.id, [input.key]: input.value }, { onConflict: 'user_id' });
      if (error) throw new Error(error.message);
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['push_prefs'] });
    },
  });
}
