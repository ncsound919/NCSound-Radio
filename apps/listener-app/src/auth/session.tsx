import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { Linking } from 'react-native';
import type { Session, User } from '@supabase/supabase-js';
import { supabase, bindAuthToAppState, handleAuthUrl, isAuthConfigured } from './supabase';

type SessionValue = {
  /** False when Supabase is not configured for this build. */
  configured: boolean;
  session: Session | null;
  user: User | null;
  loading: boolean;
  signOut: () => Promise<void>;
};

const Ctx = createContext<SessionValue | null>(null);

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!supabase) {
      setLoading(false);
      return;
    }
    const unbind = bindAuthToAppState();
    supabase.auth
      .getSession()
      .then(({ data }) => {
        setSession(data.session ?? null);
        setLoading(false);
      })
      .catch(() => setLoading(false));

    const { data: sub } = supabase.auth.onAuthStateChange((_event, next) => setSession(next));

    // OAuth / magic-link returns arrive as deep links.
    const linkSub = Linking.addEventListener('url', ({ url }) => {
      void handleAuthUrl(url);
    });
    void Linking.getInitialURL()
      .then((url) => {
        if (url) void handleAuthUrl(url);
      })
      .catch(() => {
        /* no initial URL, or the platform could not read it */
      });

    return () => {
      sub.subscription.unsubscribe();
      linkSub.remove();
      unbind();
    };
  }, []);

  const value = useMemo<SessionValue>(
    () => ({
      configured: isAuthConfigured,
      session,
      user: session?.user ?? null,
      loading,
      signOut: async () => {
        if (supabase) await supabase.auth.signOut();
      },
    }),
    [session, loading],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSession(): SessionValue {
  const value = useContext(Ctx);
  if (!value) throw new Error('useSession must be used within a SessionProvider');
  return value;
}
