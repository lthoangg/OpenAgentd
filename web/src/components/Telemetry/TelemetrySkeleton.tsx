/**
 * Loading shape for the Usage overview: filter bar, stat strip, chart,
 * and a breakdown row, so the first fetch does not shift layout.
 */
import { cn } from '@/lib/utils'
import { Skeleton } from '@/components/ui/skeleton'

export function TelemetrySkeleton({ withFilterBar = true }: { withFilterBar?: boolean }) {
  return (
    <div aria-busy="true" aria-label="Loading usage" className="oa-fade-in-late flex min-h-0 flex-1 flex-col">
      {withFilterBar && (
        <div className="flex h-11 shrink-0 items-center gap-2 border-b border-(--color-border) px-3 sm:px-4">
          <Skeleton className="h-6 w-40" />
          <Skeleton className="h-6 w-28" />
          <Skeleton className="h-6 w-28" />
        </div>
      )}
      <div className="flex flex-col gap-4 p-3 sm:p-4">
        <div className="grid grid-cols-2 gap-px overflow-hidden rounded-sm border border-(--color-border) md:grid-cols-4 xl:grid-cols-7">
          {Array.from({ length: 7 }, (_, i) => (
            <div
              key={i}
              // Same spans as the real tiles: no empty slot at 2 or 4 columns.
              className={cn('flex flex-col gap-2 bg-(--bg-card) p-3', i === 0 && 'col-span-2 md:col-span-1', i === 6 && 'md:col-span-2 xl:col-span-1')}
            >
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
