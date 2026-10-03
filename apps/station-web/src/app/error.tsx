'use client';

import { Button } from '@/components/ui/button';

/**
 * Route-level error containment.
 *
 * There was no error boundary anywhere in this app: page.tsx renders AppShell,
 * a client tree over a thousand lines deep, directly. A single bad field in a
 * poll response took down the whole page with a blank screen and no way back.
 *
 * This boundary says what failed and offers a retry, which is the minimum a
 * listener or operator should ever see instead of white.
 */
export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-5 px-6 text-center">
      <div className="space-y-2">
        <p className="font-mono text-xs uppercase tracking-[0.2em] text-muted-foreground">
          NCSound Radio
        </p>
        <h1 className="text-2xl font-bold tracking-tight">
          The station page hit an error
        </h1>
        <p className="max-w-md text-sm text-muted-foreground">
          This is a bug in the page, not a problem with the broadcast. The stream
          and the DJ engine run in separate processes and are unaffected.
        </p>
      </div>

      {error.digest && (
        <p className="font-mono text-xs text-muted-foreground">ref {error.digest}</p>
      )}

      <Button onClick={reset}>Try again</Button>
    </main>
  );
}