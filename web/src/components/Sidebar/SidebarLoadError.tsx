import { Loader2, TriangleAlert } from 'lucide-react'
import { EmptyState } from '@/components/ui/empty-state'
import { ROW_TEXT_ACTION } from '@/components/ui/list-row'

/**
 * A sidebar list whose request failed with nothing cached to show: one line
 * and Retry (DESIGN.md → Rulebook 10), so a failed load never reads as an
 * empty list. The caller sets the inset its rows use through `className`.
 */
export function SidebarLoadError({
  title,
  retrying = false,
  onRetry,
  className = 'px-3 py-1',
}: {
  /** "Couldn't load X." */
  title: string
  /** The retry is in flight. */
  retrying?: boolean
  onRetry: () => void
  className?: string
}) {
  return (
    <div role="alert">
      <EmptyState
        compact
        tone="error"
        icon={TriangleAlert}
        title={title}
        className={className}
        action={(
          <button type="button" className={`${ROW_TEXT_ACTION} -ml-2`} disabled={retrying} onClick={onRetry}>
            {retrying && <Loader2 size={12} className="mr-1 animate-spin" aria-hidden="true" />}
            {retrying ? 'Retrying…' : 'Retry'}
          </button>
        )}
      />
    </div>
  )
}
