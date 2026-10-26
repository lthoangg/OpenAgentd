/**
 * Loading shape for the telemetry overview: filter bar, stat strip, chart,
 * and a breakdown row, so the first fetch does not shift layout.
 */
import { Skeleton } from '@/components/ui/skeleton'

export function TelemetrySkeleton({ withFilterBar = true }: { withFilterBar?: boolean }) {
  return (
    <div aria-busy="true" aria-label="Loading telemetry" className="oa-fade-in-late flex min-h-0 flex-1 flex-col">
      {withFilterBar && (
        <div className="flex h-11 shrink-0 items-center gap-2 border-b border-(--color-border) px-3 sm:px-4">
          <Skeleton className="h-6 w-40" />
          <Skeleton className="h-6 w-28" />
          <Skeleton className="h-6 w-28" />
        </div>
      )}
      <div className="flex flex-col gap-4 p-3 sm:p-4">
        <div className="grid grid-cols-2 gap-px overflow-hidden rounded-sm border border-(--color-border) md:grid-cols-5">
          {Array.from({ length: 5 }, (_, i) => (
            <div key={i} className="flex flex-col gap-2 bg-(--bg-card) p-3">
              <Skeleton className="h-3 w-16" />
              <Skeleton className="h-5 w-20" />
            </div>
          ))}
        </div>
        <Skeleton className="h-40 w-full" />
        <div className="grid gap-4 lg:grid-cols-2">
          <Skeleton className="h-32 w-full" />
          <Skeleton className="h-32 w-full" />
        </div>
      </div>
    </div>
  )
}
