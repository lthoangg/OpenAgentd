/**
 * What a dock view shows while its content loads (DESIGN.md → Rulebook 10:
 * loading is a skeleton, not text). Shaped like what will load, so the view
 * does not jump when it arrives: ``DockRowsSkeleton`` for a list (a commit's
 * two lines, a file's name), ``DockLinesSkeleton`` for prose and code.
 *
 * Each is a ``role="status"`` named for what is loading ("Loading commits"),
 * as the sidebar's placeholder rows are; the bars themselves are decorative.
 */
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'

/** Widths that repeat down a column, so the bars read as different lines and names. */
const WIDTHS = ['w-3/5', 'w-4/5', 'w-2/5', 'w-1/2', 'w-2/3']

const width = (index: number) => WIDTHS[index % WIDTHS.length]

/** A few lines of text or code. ``className`` sets the inset (default ``px-3 py-3``). */
export function DockLinesSkeleton({ label, lines = 4, className }: {
  /** What is loading, for screen readers: "Loading the goal". */
  label: string
  lines?: number
  className?: string
}) {
  return (
    <div role="status" aria-label={label} className={cn('space-y-2', className ?? 'px-3 py-3')}>
      {Array.from({ length: lines }, (_, index) => <Skeleton key={index} className={cn('h-3', width(index))} />)}
    </div>
  )
}

/**
 * List rows. One line is a file (a mark and a name, a count at the end), two
 * are a commit (its subject, then who and when). ``className`` sets the
 * wrapper; ``inset`` the rows' side padding (default ``px-3``).
 */
export function DockRowsSkeleton({ label, rows = 5, twoLine = false, inset = 'px-3', className }: {
  label: string
  rows?: number
  twoLine?: boolean
  inset?: string
  className?: string
}) {
  return (
    <div role="status" aria-label={label} className={className}>
      {Array.from({ length: rows }, (_, index) => (
        twoLine ? (
          <div key={index} className={cn('space-y-1.5 py-2.5', inset)}>
            <Skeleton className={cn('h-3', width(index + 1))} />
            <Skeleton className={cn('h-2.5', width(index + 2))} />
          </div>
        ) : (
          <div key={index} className={cn('flex h-(--spacing-list-row) items-center gap-2', inset)}>
            <Skeleton className="size-3 shrink-0" />
            <Skeleton className={cn('h-3', width(index))} />
            <span className="flex-1" aria-hidden="true" />
            <Skeleton className="h-3 w-8 shrink-0" />
          </div>
        )
      ))}
    </div>
  )
}
