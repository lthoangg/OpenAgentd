/**
 * One turn in detail: a fact strip (when, where, which model, how long, how
 * much), then the span waterfall with the selected span's attributes beside
 * it (over it on phones).
 */
import { useMemo, useState, type ReactNode } from 'react'
import { Check, Copy } from 'lucide-react'
import { Chip } from '@/components/ui/chip'
import { Skeleton } from '@/components/ui/skeleton'
import { Term } from '@/components/ui/term'
import { useIsMobile } from '@/hooks/use-mobile'
import { useTraceDetailQuery } from '@/queries'
import { formatFullDateTime } from '@/utils/format'
import { formatCompact, formatMs, formatShortId, formatSpend } from '@/utils/telemetryFormat'
import { useTelemetryStore } from '@/stores/useTelemetryStore'
import { traceSummary, workspaceName } from './model'
import { ModelId, shortDateTime } from './ModelId'
import { SpanDetailPanel } from './SpanDetailPanel'
import { Waterfall } from './Waterfall'

const ACTION_CLASS =
  'inline-flex h-7 shrink-0 items-center gap-1.5 rounded-sm border pointer-coarse:h-11 pointer-coarse:px-3 border-(--color-border) bg-(--bg-card) px-2.5 text-xs text-(--color-text-2) transition-colors hover:bg-(--bg-key) hover:text-(--color-text) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring)'

function Fact({ label, children, title, className }: { label: ReactNode; children: ReactNode; title?: string; className?: string }) {
  return (
    <div className={`flex min-w-0 flex-col gap-0.5 bg-(--bg-card) px-3 py-2 ${className ?? ''}`}>
      <dt className="text-[11px] text-(--color-text-muted)">{label}</dt>
      <dd className="truncate text-xs text-(--color-text)" title={title}>{children}</dd>
    </div>
  )
}

export function TraceView({
  traceId,
  days,
  onOpenSession,
}: {
  traceId: string
  /** Range the trace was listed in; the lookup scans that window. */
  days: number
  onOpenSession?: (sessionId: string) => void
}) {
  const isMobile = useIsMobile()
  const { data, isPending, isError, refetch } = useTraceDetailQuery(traceId, days)
  const selectedSpanId = useTelemetryStore((s) => s.spanId)
  const setSelectedSpanId = useTelemetryStore((s) => s.selectSpan)
  const setDays = useTelemetryStore((s) => s.setDays)
  const [copied, setCopied] = useState(false)
  const summary = useMemo(() => (data ? traceSummary(data.spans) : null), [data])
  const selectedSpan = data?.spans.find((s) => s.span_id === selectedSpanId) ?? null

  const copyTraceId = async () => {
    try {
      await navigator.clipboard.writeText(traceId)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // Clipboard can be unavailable (insecure context); the id stays visible.
    }
  }

  if (isPending) {
    return (
      <div aria-busy="true" aria-label="Loading trace" className="flex flex-col gap-4 p-3 sm:p-4">
        <Skeleton className="h-14 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    )
  }

  if (isError) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
        <p className="text-sm font-medium text-(--color-text)">Couldn't load this turn</p>
        <button type="button" onClick={() => void refetch()} className={ACTION_CLASS}>
          Retry
        </button>
      </div>
    )
  }

  if (!data || !summary) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
        <p className="text-sm font-medium text-(--color-text)">Trace not found</p>
        <p className="max-w-[48ch] text-xs text-(--color-text-muted)">
          {days < 90
            ? `It isn't in the last ${days === 1 ? '24 hours' : `${days} days`}. It may be older, or past the data retention limit.`
            : 'It may be past the data retention limit.'}
        </p>
        {days < 90 && (
          <button type="button" onClick={() => setDays(90)} className={ACTION_CLASS}>
            Search the last 90 days
          </button>
        )}
      </div>
    )
  }

  return (
    <div className="relative flex min-h-0 flex-1 overflow-hidden">
      <div className="@container flex min-w-0 flex-1 flex-col gap-4 overflow-y-auto p-3 sm:p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="min-w-0 truncate text-xs text-(--color-text-muted)">
            {summary.agentName && <span className="font-mono font-medium text-(--color-text)">{summary.agentName}</span>}
            {summary.agentName && ' · '}
            {shortDateTime(summary.startMs)}
          </p>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void copyTraceId()}
              className={ACTION_CLASS}
              aria-label={copied ? 'Trace ID copied' : 'Copy trace ID'}
              title={`Copy trace ID ${traceId}`}
            >
              {copied ? <Check size={13} aria-hidden="true" /> : <Copy size={13} aria-hidden="true" />}
              {copied ? 'Copied' : <span className="font-mono">trace {formatShortId(traceId)}</span>}
            </button>
            {summary.sessionId && onOpenSession && (
              <button type="button" onClick={() => onOpenSession(summary.sessionId!)} className={ACTION_CLASS}>
                Open session
              </button>
            )}
          </div>
        </div>

        <dl
          aria-label="Turn summary"
          className="grid shrink-0 grid-cols-2 gap-px overflow-hidden rounded-sm border border-(--color-border) bg-(--color-border) @xl:grid-cols-4 @5xl:grid-cols-7"
        >
          <Fact label="Started" title={formatFullDateTime(new Date(summary.startMs))}>
            {shortDateTime(summary.startMs)}
          </Fact>
          <Fact label="Workspace" title={summary.workspace ?? undefined}>
            {summary.workspace === undefined ? '-' : workspaceName(summary.workspace)}
          </Fact>
          <Fact label="Model" title={summary.providerModel ?? undefined}>
            {summary.providerModel ? <ModelId id={summary.providerModel} /> : '-'}
          </Fact>
          <Fact label={<Term definition="turnDuration">Duration</Term>}>
            <span className="font-mono">{formatMs(summary.durationMs)}</span>
          </Fact>
          <Fact label="Tokens in / out">
            <span className="font-mono">
              {formatCompact(summary.inputTokens)} / {formatCompact(summary.outputTokens)}
            </span>
          </Fact>
          <Fact label={<Term definition="spendEstimate">Spend (est.)</Term>}>
            <span className="font-mono">{formatSpend(summary.cost)}</span>
          </Fact>
          {/* Seventh cell: fills the last row so no empty cell shows. */}
          <Fact label="Status" className="col-span-2 @5xl:col-span-1">
            {summary.failed ? <Chip tone="error">failed</Chip> : <Chip tone="success">ok</Chip>}
          </Fact>
        </dl>

        <Waterfall spans={data.spans} selectedSpanId={selectedSpanId} onSelectSpan={setSelectedSpanId} />
      </div>
      {selectedSpan &&
        (isMobile ? (
          <div className="absolute inset-0 z-10 overflow-y-auto bg-(--bg-page)">
            <SpanDetailPanel span={selectedSpan} traceStartMs={summary.startMs} onClose={() => setSelectedSpanId(null)} fullWidth />
          </div>
        ) : (
          <SpanDetailPanel span={selectedSpan} traceStartMs={summary.startMs} onClose={() => setSelectedSpanId(null)} />
        ))}
    </div>
  )
}
