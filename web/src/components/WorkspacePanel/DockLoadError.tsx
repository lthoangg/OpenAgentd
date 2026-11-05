import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

/**
 * A dock tab's failed load: the error line plus a Retry, so a dropped
 * request is one click away from recovering instead of a dead end.
 */
export function DockLoadError({ message, onRetry, retrying = false, className }: {
  message: string
  onRetry: () => void
  retrying?: boolean
  /** Replaces the default inset (``px-3 py-4``) where the error sits in a padded card. */
  className?: string
}) {
  return (
    <div className={cn('flex flex-wrap items-center gap-2', className ?? 'px-3 py-4')}>
      <p className="text-xs text-(--color-error)" role="alert">{message}</p>
      <Button size="xs" onClick={onRetry} disabled={retrying}>
        Retry
      </Button>
    </div>
  )
}
