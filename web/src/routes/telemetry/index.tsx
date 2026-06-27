/**
 * /telemetry — standalone top-level page.
 *
 * Two modes driven by local state:
 *   - No trace selected: aggregates (totals, latency, breakdowns) + traces list.
 *   - Trace selected: waterfall view with optional span attribute side panel.
 *
 * All data comes from OTEL span JSONL files, aggregated through DuckDB on the
 * backend.  When the `[otel]` extra isn't installed the backend returns a
 * structured 503 that we surface as a dedicated empty state.
 */

import { useMemo, useState } from 'react'
import { ArrowLeft } from 'lucide-react'
import {
  useObservabilitySummaryQuery,
  useInfiniteTracesQuery,
  useTraceDetailQuery,
} from '@/queries'
import { useIsMobile } from '@/hooks/use-mobile'
import { formatShortId } from '@/utils/telemetryFormat'
import { ErrorState, LoadingState, PageHeader } from './chrome'
import { SummaryView } from './summary/SummaryView'
import { TracesSection } from './traces/TracesSection'
import { SpanDetailPanel } from './waterfall/SpanDetailPanel'
import { Waterfall } from './waterfall/Waterfall'

type WindowDays = 1 | 7 | 30 | 90

const RANGES: { value: WindowDays; label: string }[] = [
  { value: 1, label: '24 h' },
  { value: 7, label: '7 d' },
  { value: 30, label: '30 d' },
  { value: 90, label: '90 d' },
]

const TRACE_PAGE_SIZE = 25

export function TelemetryPage() {
  const [days, setDays] = useState<WindowDays>(7)
  const [selectedTraceId, setSelectedTraceId] = useState<string | null>(null)

  return (
    <main id="main" className="mobile-safe-shell mobile-viewport flex h-dvh flex-col overflow-hidden bg-(--bg-page) text-(--color-text)">
      {selectedTraceId ? (
        <TraceDetailRoute
          traceId={selectedTraceId}
          onBack={() => setSelectedTraceId(null)}
        />
      ) : (
        <SummaryRoute
          days={days}
          onChangeDays={setDays}
          onSelectTrace={setSelectedTraceId}
        />
      )}
    </main>
  )
}

// ── Summary route ────────────────────────────────────────────────────────────

function SummaryRoute({
  days,
  onChangeDays,
  onSelectTrace,
}: {
  days: WindowDays
  onChangeDays: (d: WindowDays) => void
  onSelectTrace: (traceId: string) => void
}) {
  const summary = useObservabilitySummaryQuery(days)
  const traces = useInfiniteTracesQuery(days, TRACE_PAGE_SIZE)
  const isFetching = summary.isFetching || traces.isFetching
  const traceRows = useMemo(
    () => traces.data?.pages.flatMap((page) => page.traces) ?? [],
    [traces.data],
  )
  const traceTotal = traces.data?.pages[0]?.total ?? traceRows.length

  function changeDays(nextDays: WindowDays) {
    onChangeDays(nextDays)
  }

  function loadMoreTraces() {
    if (!traces.hasNextPage || traces.isFetchingNextPage) return
    void traces.fetchNextPage()
  }

  return (
    <>
      <PageHeader
        isFetching={isFetching}
        right={
          <>
            <div className="flex items-center gap-0.5 rounded-sm border border-(--color-border) bg-(--bg-card) p-0.5">
              {RANGES.map((r) => (
                <button
                  key={r.value}
                  onClick={() => changeDays(r.value)}
                  className={`rounded-xs border border-transparent px-2 py-1 text-[11px] font-medium transition-colors ${
                    days === r.value
                      ? 'border-(--color-border-strong) bg-(--bg-key) text-(--color-text)'
                      : 'text-(--color-text-muted) hover:bg-(--bg-key)/40 hover:text-(--color-text)'
                  }`}
                >
                  {r.label}
                </button>
              ))}
            </div>
          </>
        }
      />

      <div className="min-h-0 flex-1 overflow-y-auto p-3 sm:p-5">
        {summary.isLoading ? (
          <LoadingState label="Loading span aggregates…" />
        ) : summary.isError ? (
          <ErrorState
            message={String(summary.error)}
            onRetry={() => summary.refetch()}
          />
        ) : summary.data ? (
          <div className="flex flex-col gap-6">
            <SummaryView data={summary.data} />
            <TracesSection
              query={traces}
              traces={traceRows}
              limit={TRACE_PAGE_SIZE}
              total={traceTotal}
              hasNext={traces.hasNextPage}
              onLoadMore={loadMoreTraces}
              onSelectTrace={onSelectTrace}
            />
          </div>
        ) : null}
      </div>
    </>
  )
}

// ── Trace detail route ──────────────────────────────────────────────────────

function TraceDetailRoute({
  traceId,
  onBack,
}: {
  traceId: string
  onBack: () => void
}) {
  const isMobile = useIsMobile()
  const { data, isLoading, isError, error, refetch, isFetching } =
    useTraceDetailQuery(traceId)
  const [selectedSpanId, setSelectedSpanId] = useState<string | null>(null)

  const selectedSpan =
    data?.spans.find((s) => s.span_id === selectedSpanId) ?? null

  return (
    <>
      <PageHeader
        isFetching={isFetching}
        left={
          <button
            onClick={onBack}
            className="flex h-8 w-8 items-center justify-center rounded-sm text-(--color-text-muted) transition-colors hover:bg-(--bg-key) hover:text-(--color-text) sm:h-7 sm:w-7"
            aria-label="Back to list"
          >
            <ArrowLeft size={14} />
          </button>
        }
        subtitle={`Trace ${formatShortId(traceId)}`}
      />

      {/* On mobile: span detail overlays the waterfall full-width (absolute).
          On desktop: span detail is a fixed-width flex sibling on the right. */}
      <div className="relative flex min-h-0 flex-1 overflow-hidden">
        <div className="min-w-0 flex-1 overflow-y-auto p-3 sm:p-5">
          {isLoading ? (
            <LoadingState label="Loading trace…" />
          ) : isError ? (
            <ErrorState
              message={String(error)}
              onRetry={() => refetch()}
            />
          ) : !data ? (
            <div className="rounded-sm border border-(--color-border) bg-(--bg-card) p-6 text-center">
              <p className="text-sm font-medium text-(--color-text)">
                Trace not found
              </p>
              <p className="mt-1 text-xs text-(--color-text-muted)">
                This trace may have expired from the retention window.
              </p>
            </div>
          ) : (
            <Waterfall
              spans={data.spans}
              selectedSpanId={selectedSpanId}
              onSelectSpan={setSelectedSpanId}
            />
          )}
        </div>
        {selectedSpan && (
          isMobile ? (
            // Full-width overlay on mobile
            <div className="absolute inset-0 z-10 overflow-y-auto bg-(--bg-page)">
              <SpanDetailPanel
                span={selectedSpan}
                onClose={() => setSelectedSpanId(null)}
                fullWidth
              />
            </div>
          ) : (
            <SpanDetailPanel
              span={selectedSpan}
              onClose={() => setSelectedSpanId(null)}
            />
          )
        )}
      </div>
    </>
  )
}
