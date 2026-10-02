'use client'

import { Button } from '@/components/ui/button'

/**
 * ErrorLine — compact inline error/retry row shared across cards. Pass a
 * custom `message` for form-level errors (defaults to the feed-failure copy).
 */
export function ErrorLine({
  onRetry,
  message,
}: {
  onRetry?: () => void
  message?: string
}) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-md border border-red-500/30 bg-red-500/[0.06] px-3 py-2">
      <p className="flex items-center gap-2 text-xs text-red-400">
        <span
          aria-hidden="true"
          className="h-1.5 w-1.5 shrink-0 rounded-full bg-red-500"
        />
        {message ?? 'Feed unavailable — retrying…'}
      </p>
      {onRetry && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 px-2 text-xs text-primary hover:text-primary"
          onClick={onRetry}
        >
          Retry
        </Button>
      )}
    </div>
  )
}
