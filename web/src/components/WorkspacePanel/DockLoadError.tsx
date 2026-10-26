import { Button } from '@/components/ui/button'

/**
 * A dock tab's failed load: the error line plus a Retry, so a dropped
 * request is one click away from recovering instead of a dead end.
 */
export function DockLoadError({ message, onRetry, retrying = false }: {
  message: string
  onRetry: () => void
  retrying?: boolean
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 px-3 py-4">
      <p className="text-xs text-(--color-error)" role="alert">{message}</p>
      <Button size="xs" onClick={onRetry} disabled={retrying}>
        Retry
      </Button>
    </div>
  )
}
