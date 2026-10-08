/**
 * NCSound listener app root.
 *
 * @format
 */

import React, { useEffect } from 'react';
import { StatusBar } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SessionProvider } from './src/auth/session';
import { AppNavigation } from './src/app/navigation';
import { loadPrefs } from './src/data/prefs';
import { PushRegistration } from './src/notifications/PushRegistration';
import { ErrorBoundary } from './src/observability/ErrorBoundary';
import { initSentry, captureError, capturePlaybackEvent } from './src/observability/sentry';
import { initPlayback } from './src/player/controller';
import { PlaybackEngine } from './src/player/PlaybackEngine';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, staleTime: 15_000 },
  },
});

function App() {
  useEffect(() => {
    initSentry();
    void loadPrefs();
    // Configure the player and start health monitoring once at launch, so
    // lock-screen / background audio is ready before the first play.
    initPlayback({
      onReconnecting: (attempt, delayMs) =>
        capturePlaybackEvent('reconnect', { attempt, delayMs }),
      onFatal: (reason) => captureError(new Error(`player fatal: ${reason}`), { scope: 'player' }),
    });
  }, []);

  return (
    <SafeAreaProvider>
      <StatusBar barStyle="light-content" />
      <PlaybackEngine />
      <ErrorBoundary>
        <QueryClientProvider client={queryClient}>
          <SessionProvider>
            <PushRegistration />
            <AppNavigation />
          </SessionProvider>
        </QueryClientProvider>
      </ErrorBoundary>
    </SafeAreaProvider>
  );
}

export default App;
