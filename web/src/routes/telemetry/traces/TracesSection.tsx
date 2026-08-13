/**
 * Recent-traces section: wraps ``TracesTable`` with loading/error/empty
 * states keyed off the TanStack Query result.
 */

import { useState } from 'react'
import type { TraceListItem } from '@/api/client'
import { EmptyTable, SectionCard, SectionCardHeader } from '../primitives'
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
  const [scrollElement, setScrollElement] = useState<HTMLDivElement | null>(null)

  return (
    <SectionCard>
      <SectionCardHeader className="flex flex-wrap items-center justify-between gap-2 py-1.5">
        <span>Recent traces</span>
        {total > 0 && (
          <span className="text-[10px] font-normal tracking-normal text-(--color-text-muted)">
            Showing {Math.min(traces.length, total)} of {total}
          </span>
        )}
      </SectionCardHeader>

      {isInitialLoading ? (
        <EmptyTable label="Loading traces…" />
      ) : query.isError ? (
        <EmptyTable label={`Could not load traces: ${String(query.error)}`} />
      ) : total === 0 ? (
        <EmptyTable label="No traces in this window." />
      ) : (
        <div
          ref={setScrollElement}
          className="max-h-[34rem] overflow-y-auto"
          onScroll={(event) => {
            const el = event.currentTarget
            if (el.scrollTop + el.clientHeight >= el.scrollHeight - 80) {
              onLoadMore()
            }
          }}
        >
          <TracesTable
            traces={traces}
            onSelect={onSelectTrace}
            embedded
            scrollElement={scrollElement}
          />
          {hasNext && (
            <div className="border-t border-(--color-border) px-3 py-2 text-center text-[11px] text-(--color-text-muted)">
              {query.isFetching ? 'Loading more traces…' : `Scroll to load ${limit} more`}
            </div>
          )}
        </div>
      )}
    </SectionCard>
  )
}
