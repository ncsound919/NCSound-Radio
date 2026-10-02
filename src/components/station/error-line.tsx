'use client'

import { Button } from '@/components/ui/button'

/**
 * ErrorLine — compact inline retry row for fetch-failed cards. Shared by the
 * on-air panel cards so every feed error reads the same way.
 */
export function ErrorLine({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-md border border-border/60 bg-background/40 px-3 py-2">
      <p className="text-xs text-muted-foreground">Feed unavailable — retrying…</p>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-7 px-2 text-xs text-primary hover:text-primary"
        onClick={onRetry}
      >
        Retry
      </Button>
    </div>
  )
}
