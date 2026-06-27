/**
 * Recent-traces section: wraps ``TracesTable`` with loading/error/empty
 * states keyed off the TanStack Query result.
 */

import type { TraceListItem } from '@/api/client'
import { EmptyTable, SectionHeader } from '../primitives'
import { TracesTable } from './TracesTable'

interface TracesQueryState {
  isLoading: boolean
  isError: boolean
  isFetching: boolean
  error: unknown
}

export function TracesSection({
  query,
  traces,
  limit,
  total,
  hasNext,
  onLoadMore,
  onSelectTrace,
}: {
  query: TracesQueryState
  traces: TraceListItem[]
  limit: number
  total: number
  hasNext: boolean
  onLoadMore: () => void
  onSelectTrace: (traceId: string) => void
}) {
  const isInitialLoading = query.isLoading && traces.length === 0

  return (
    <section>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <SectionHeader>Recent traces</SectionHeader>
        {total > 0 && (
          <span className="text-[11px] text-(--color-text-muted)">
            Showing {Math.min(traces.length, total)} of {total}
          </span>
        )}
      </div>
      {isInitialLoading ? (
        <EmptyTable label="Loading traces…" />
      ) : query.isError ? (
        <EmptyTable label={`Could not load traces: ${String(query.error)}`} />
      ) : total === 0 ? (
        <EmptyTable label="No traces in this window." />
      ) : (
        <div
          className="max-h-[34rem] overflow-y-auto rounded-sm border border-(--color-border) bg-(--bg-card)"
          onScroll={(event) => {
            const el = event.currentTarget
            if (el.scrollTop + el.clientHeight >= el.scrollHeight - 80) {
              onLoadMore()
            }
          }}
        >
          <TracesTable traces={traces} onSelect={onSelectTrace} embedded />
          {hasNext && (
            <div className="border-t border-(--color-border) px-3 py-2 text-center text-[11px] text-(--color-text-muted)">
              {query.isFetching ? 'Loading more traces…' : `Scroll to load ${limit} more`}
            </div>
          )}
        </div>
      )}
    </section>
  )
}
