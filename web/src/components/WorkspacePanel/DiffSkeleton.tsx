import { Skeleton } from '@/components/ui/skeleton'

/**
 * A diff on its way: a few code-line placeholders (Rulebook 10: loading is a
 * skeleton, not text), named for screen readers as the sidebar's are.
 */
export function DiffSkeleton() {
  return (
    <div role="status" aria-label="Loading diff" className="space-y-2 px-3 py-3">
      <Skeleton className="h-3 w-3/5" />
      <Skeleton className="h-3 w-4/5" />
      <Skeleton className="h-3 w-2/5" />
      <Skeleton className="h-3 w-1/2" />
    </div>
  )
}
