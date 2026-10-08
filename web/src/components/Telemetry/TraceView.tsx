/**
 * One turn in detail: a fact strip (when, where, which model, how long, how
 * much), then the span waterfall with the selected span's attributes beside
 * it (over it on phones).
 */
import { useMemo, useState, type ReactNode } from 'react'
import { Check, Copy, MessageSquare } from 'lucide-react'
import { Skeleton } from '@/components/ui/skeleton'
import { useIsMobile } from '@/hooks/use-mobile'
import { useTraceDetailQuery } from '@/queries'
import { formatFullDateTime } from '@/utils/format'
import { formatCompact, formatMs, formatShortId, formatSpend } from '@/utils/telemetryFormat'
import { modelName, traceSummary, workspaceName } from './model'
import { SpanDetailPanel } from './SpanDetailPanel'
import { Waterfall } from './Waterfall'

const ACTION_CLASS =
  'inline-flex h-7 shrink-0 items-center gap-1.5 rounded-sm border border-(--color-border) bg-(--bg-card) px-2.5 text-xs text-(--color-text-2) transition-colors hover:bg-(--bg-key) hover:text-(--color-text) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring)/40'

function Fact({ label, children, title }: { label: string; children: ReactNode; title?: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5 bg-(--bg-card) px-3 py-2">
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
  const [selectedSpanId, setSelectedSpanId] = useState<string | null>(null)
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
        <p className="text-sm font-medium text-(--color-text)">Could not load this trace</p>
        <button type="button" onClick={() => void refetch()} className={ACTION_CLASS}>
          Retry
        </button>
      </div>
    )
  }

  if (!data || !summary) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-1 p-6 text-center">
        <p className="text-sm font-medium text-(--color-text)">Trace not found</p>
        <p className="text-xs text-(--color-text-muted)">It may be older than the selected range or past retention.</p>
      </div>
    )
  }

  return (
    <div className="relative flex min-h-0 flex-1 overflow-hidden">
      <div className="flex min-w-0 flex-1 flex-col gap-4 overflow-y-auto p-3 sm:p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="min-w-0 truncate text-xs text-(--color-text-muted)">
            {summary.agentName && <span className="font-medium text-(--color-text)">{summary.agentName}</span>}
            {summary.agentName && ' - '}
            <span className="font-mono">{formatShortId(traceId)}</span>
          </p>
          <div className="flex items-center gap-2">
            <button type="button" onClick={() => void copyTraceId()} className={ACTION_CLASS}>
              {copied ? <Check size={13} aria-hidden="true" /> : <Copy size={13} aria-hidden="true" />}
              {copied ? 'Copied' : 'Copy trace ID'}
            </button>
            {summary.sessionId && onOpenSession && (
              <button type="button" onClick={() => onOpenSession(summary.sessionId!)} className={ACTION_CLASS}>
                <MessageSquare size={13} aria-hidden="true" />
                Open session
              </button>
            )}
          </div>
        </div>

        <dl
          aria-label="Turn summary"
          className="grid grid-cols-2 gap-px overflow-hidden rounded-sm border border-(--color-border) bg-(--color-border) sm:grid-cols-4 lg:grid-cols-7"
        >
          <Fact label="Started" title={formatFullDateTime(new Date(summary.startMs))}>
            {formatFullDateTime(new Date(summary.startMs))}
          </Fact>
          <Fact label="Workspace" title={summary.workspace ?? undefined}>
            {summary.workspace === undefined ? '-' : workspaceName(summary.workspace)}
          </Fact>
          <Fact label="Model" title={summary.providerModel ?? undefined}>
            <span className="font-mono">{summary.providerModel ? modelName(summary.providerModel) : '-'}</span>
          </Fact>
          <Fact label="Duration">{formatMs(summary.durationMs)}</Fact>
          <Fact label="Tokens">
            {formatCompact(summary.inputTokens)} in, {formatCompact(summary.outputTokens)} out
          </Fact>
          <Fact label="Cost">{formatSpend(summary.cost)}</Fact>
          <Fact label="Status">
            {summary.failed ? <span className="font-medium text-(--color-error)">Failed</span> : 'Completed'}
          </Fact>
        </dl>

        <Waterfall spans={data.spans} selectedSpanId={selectedSpanId} onSelectSpan={setSelectedSpanId} />
      </div>
      {selectedSpan &&
        (isMobile ? (
          <div className="absolute inset-0 z-10 overflow-y-auto bg-(--bg-page)">
            <SpanDetailPanel span={selectedSpan} onClose={() => setSelectedSpanId(null)} fullWidth />
          </div>
        ) : (
          <SpanDetailPanel span={selectedSpan} onClose={() => setSelectedSpanId(null)} />
        ))}
    </div>
  )
}
