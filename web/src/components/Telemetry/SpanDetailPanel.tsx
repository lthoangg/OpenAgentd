/**
 * Side panel for one span: its status and timing, then the attributes it
 * set, grouped by namespace (``gen_ai.*``, ``openagentd.*``, …) with the raw
 * keys kept and a copy button per row. Span bookkeeping (kind, ids) sits in
 * a collapsed group at the end. Null attributes are dropped.
 */

import { useMemo, useState, type ReactNode } from 'react'
import { Check, ChevronRight, Copy, X } from 'lucide-react'
import type { SpanDetail } from '@/api/client'
import { Button } from '@/components/ui/button'
import { Chip } from '@/components/ui/chip'
import { Term } from '@/components/ui/term'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { formatInt, formatMs, formatTps, formatUsd } from '@/utils/telemetryFormat'
import { categorizeSpan } from '@/utils/traceTree'
import { copyText } from '@/components/ChatContextMenu'
import { SpanTypeChip } from './categories'
import { shortDateTimeSeconds } from './ModelId'

const SECTION_LABEL_CLASS = 'mb-1.5 mt-4 text-[11px] font-medium text-(--color-text-muted)'

function Kv({ label, value, mono = true }: { label: ReactNode; value: ReactNode; mono?: boolean }) {
  return (
    <>
      <dt className="text-(--color-text-muted)">{label}</dt>
      <dd className={cn('min-w-0 truncate text-right text-(--color-text) tabular-nums', mono && 'font-mono')}>{value}</dd>
    </>
  )
}

function CopyButton({ value, label }: { value: string; label: string }) {
  const [done, setDone] = useState(false)
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={() => {
        copyText(value)
        setDone(true)
        setTimeout(() => setDone(false), 1500)
      }}
      className="inline-flex size-5 shrink-0 items-center justify-center rounded-xs text-(--color-text-subtle) opacity-0 transition-opacity group-hover:opacity-100 hover:text-(--color-text) focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring) pointer-coarse:size-11 pointer-coarse:opacity-100"
    >
      {done ? <Check size={11} aria-hidden="true" /> : <Copy size={11} aria-hidden="true" />}
    </button>
  )
}

function AttrRow({ k, v }: { k: string; v: string }) {
  return (
    <div className="group grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2 px-2 py-1 font-mono text-[11px] md:grid-cols-[minmax(0,10rem)_minmax(0,1fr)_auto]">
      <dt className="col-start-1 truncate text-(--color-text-muted)" title={k}>
        {k}
      </dt>
      <dd className="col-start-1 truncate text-(--color-text) md:col-start-2 md:row-start-1" title={v}>
        {v}
      </dd>
      <span className="col-start-2 row-span-2 row-start-1 md:col-start-3 md:row-span-1">
        <CopyButton value={v} label={`Copy ${k}`} />
      </span>
    </div>
  )
}

function Group({ title, count, children, collapsible = false }: { title: string; count: number; children: ReactNode; collapsible?: boolean }) {
  const header = (
    <>
      {collapsible && <ChevronRight size={12} aria-hidden="true" className="transition-transform group-open/grp:rotate-90" />}
      <span className="truncate">{title}</span>
      <span className="ml-auto font-sans text-(--color-text-subtle)">{count}</span>
    </>
  )
  const headerClass = 'flex h-7 items-center gap-1.5 bg-(--bg-key)/50 px-2 font-mono text-[11px] font-medium text-(--color-text-2)'
  if (collapsible) {
    return (
      <details className="group/grp overflow-hidden rounded-sm border border-(--color-border-subtle)">
        <summary className={cn(headerClass, 'cursor-pointer list-none pointer-coarse:h-11 [&::-webkit-details-marker]:hidden')}>{header}</summary>
        <dl className="py-1">{children}</dl>
      </details>
    )
  }
  return (
    <section className="overflow-hidden rounded-sm border border-(--color-border-subtle)">
      <h5 className={headerClass}>{header}</h5>
      <dl className="py-1">{children}</dl>
    </section>
  )
}

export function SpanDetailPanel({
  span,
  onClose,
  traceStartMs,
  fullWidth = false,
}: {
  span: SpanDetail
  onClose: () => void
  /** Start of the whole trace, for "Starts at +X s". */
  traceStartMs?: number
  /** When true, renders as a full-width block (mobile overlay) instead of a fixed w-96 sidebar. */
  fullWidth?: boolean
}) {
  const groups = useMemo(() => groupAttributes(span.attributes), [span.attributes])
  const tokens = useMemo(() => extractTokens(span.attributes), [span.attributes])
  const estimatedCost = useMemo(() => extractEstimatedCost(span.attributes), [span.attributes])
  const speed = useMemo(() => extractSpeed(span.attributes), [span.attributes])
  const isError = span.status === 'ERROR'
  const errorType = typeof span.attributes['error.type'] === 'string' ? (span.attributes['error.type'] as string) : null
  const category = categorizeSpan(span.name)
  const offsetMs = traceStartMs === undefined ? null : Math.max(0, span.start_ms - traceStartMs)
  const attrCount = groups.reduce((n, g) => n + g.rows.length, 0)

  const copyJson = () =>
    copyText(
      JSON.stringify(
        {
          name: span.name,
          status: span.status,
          kind: span.kind,
          span_id: span.span_id,
          parent_span_id: span.parent_span_id,
          trace_id: span.trace_id,
          start_ms: span.start_ms,
          duration_ms: span.duration_ms,
          attributes: span.attributes,
        },
        null,
        2,
      ),
    )

  return (
    <aside
      aria-label="Span detail"
      className={`flex shrink-0 flex-col overflow-hidden border-l border-(--color-border) bg-(--bg-page) ${fullWidth ? 'w-full' : 'w-96'}`}
    >
      <div className="flex min-h-11 shrink-0 items-center gap-2 border-b border-(--color-border) bg-(--bg-sidebar) px-3">
        <SpanTypeChip category={category} error={isError} />
        <Tooltip className="min-w-0 flex-1">
          <TooltipTrigger
            render={<h3 className="truncate font-mono text-[13px] font-semibold text-(--color-text)">{span.name}</h3>}
          />
          <TooltipContent>{span.name}</TooltipContent>
        </Tooltip>
        <Chip mono tone={isError ? 'error' : 'neutral'}>
          {span.status || 'UNSET'}
        </Chip>
        {/* On phones the overlay's Back arrow closes the span. */}
        {!fullWidth && (
          <Button variant="ghost" size="icon-dense" onClick={onClose} aria-label="Close span detail">
            <X size={14} />
          </Button>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-3 sm:p-4">
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-xs">
          <Kv label="Duration" value={formatMs(span.duration_ms)} />
          {offsetMs !== null && <Kv label="Starts at" value={`+${(offsetMs / 1000).toFixed(2)} s`} />}
          {speed.firstChunkMs !== null && (
            <Kv label={<Term definition="ttft">First token (TTFT)</Term>} value={formatMs(speed.firstChunkMs)} />
          )}
          {speed.tokensPerSecond !== null && (
            <Kv label={<Term definition="tokPerSec">Output speed</Term>} value={formatTps(speed.tokensPerSecond)} />
          )}
          <Kv label="Started" value={shortDateTimeSeconds(span.start_ms)} mono={false} />
        </dl>

        {isError && (
          <div role="note" className="mt-3 rounded-sm bg-(--color-error-subtle) px-2.5 py-2 text-xs text-(--color-text)">
            <span className="font-medium">This span failed</span>
            {errorType && (
              <>
                {': '}
                <span className="font-mono">{errorType}</span>
              </>
            )}
          </div>
        )}

        {tokens.length > 0 && (
          <>
            <h4 className={SECTION_LABEL_CLASS}>Tokens</h4>
            <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-sm border border-(--color-border) bg-(--color-border)">
              {tokens.map((t) => (
                <div key={t.label} className="bg-(--bg-card) px-2.5 py-1.5">
                  <dt className="text-[11px] text-(--color-text-muted)">{t.label}</dt>
                  <dd className="font-mono text-sm font-semibold tabular-nums text-(--color-text)">{formatInt(t.value)}</dd>
                </div>
              ))}
            </dl>
          </>
        )}

        {estimatedCost !== null && (
          <dl className="mt-3 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 text-xs">
            <Kv label={<Term definition="spendEstimate">Spend (est.)</Term>} value={formatUsd(estimatedCost)} />
          </dl>
        )}

        <div className="mt-4 flex items-center justify-between">
          <h4 className="text-[11px] font-medium text-(--color-text-muted)">
            Attributes <span className="text-(--color-text-subtle)">{attrCount}</span>
          </h4>
          <Button variant="subtle" size="xs" onClick={copyJson}>
            Copy as JSON
          </Button>
        </div>
        <div className="mt-2 flex flex-col gap-2">
          {groups.length === 0 && <p className="text-xs text-(--color-text-muted)">This span set no attributes.</p>}
          {groups.map((g) => (
            <Group key={g.ns} title={g.ns === '' ? 'Other' : `${g.ns}.*`} count={g.rows.length}>
              {g.rows.map(([k, v]) => (
                <AttrRow key={k} k={k} v={v} />
              ))}
            </Group>
          ))}
          <Group title="Span · kind, ids" count={4} collapsible>
            <AttrRow k="kind" v={span.kind || '-'} />
            <AttrRow k="span_id" v={span.span_id} />
            <AttrRow k="parent_span_id" v={span.parent_span_id ?? 'none (root span)'} />
            <AttrRow k="trace_id" v={span.trace_id} />
          </Group>
        </div>
      </div>
    </aside>
  )
}

function extractEstimatedCost(attrs: Record<string, unknown>): number | null {
  const raw = attrs['gen_ai.usage.estimated_cost_usd']
  const n = typeof raw === 'number' ? raw : Number(raw)
  return Number.isFinite(n) && n > 0 ? n : null
}

/** Streaming speed the backend records on `chat` spans; `null` when absent. */
function extractSpeed(attrs: Record<string, unknown>): { firstChunkMs: number | null; tokensPerSecond: number | null } {
  const positive = (raw: unknown) => {
    const n = typeof raw === 'number' ? raw : Number(raw)
    return raw !== undefined && raw !== null && Number.isFinite(n) && n > 0 ? n : null
  }
  const firstChunkS = positive(attrs['gen_ai.response.time_to_first_chunk'])
  return {
    firstChunkMs: firstChunkS === null ? null : firstChunkS * 1000,
    tokensPerSecond: positive(attrs['openagentd.response.output_tokens_per_second']),
  }
}

/**
 * Pull the subset of `gen_ai.usage.*` attributes into a compact display list.
 * Returns an empty array when the span has no token data — the UI uses that
 * to hide the entire section (keeps non-LLM spans uncluttered).
 */
function extractTokens(attrs: Record<string, unknown>): Array<{ label: string; value: number }> {
  const pairs: Array<[string, string]> = [
    ['gen_ai.usage.input_tokens', 'Input'],
    ['gen_ai.usage.output_tokens', 'Output'],
    ['gen_ai.usage.cache_read.input_tokens', 'From cache'],
    ['gen_ai.usage.cache_creation.input_tokens', 'Written to cache'],
    ['gen_ai.usage.reasoning_tokens', 'Reasoning'],
    ['gen_ai.usage.tool_use_tokens', 'Tool use'],
  ]
  const out: Array<{ label: string; value: number }> = []
  for (const [key, label] of pairs) {
    const raw = attrs[key]
    const n = typeof raw === 'number' ? raw : Number(raw)
    if (Number.isFinite(n) && n > 0) out.push({ label, value: n })
  }
  return out
}

/** Namespaces listed first; the rest follow alphabetically, keys without a dot last. */
const NS_ORDER = ['gen_ai', 'openagentd', 'tool', 'session', 'error']

/**
 * Group a possibly-nested attribute bag by the key's first segment
 * (`gen_ai.usage.input_tokens` → `gen_ai`). Nested objects collapse to JSON;
 * null and undefined values are skipped.
 */
export function groupAttributes(obj: Record<string, unknown>): Array<{ ns: string; rows: Array<[string, string]> }> {
  const byNs = new Map<string, Array<[string, string]>>()
  for (const [key, raw] of Object.entries(obj)) {
    if (raw === null || raw === undefined) continue
    const dot = key.indexOf('.')
    const ns = dot > 0 ? key.slice(0, dot) : ''
    byNs.set(ns, [...(byNs.get(ns) ?? []), [key, stringifyAttr(raw)]])
  }
  const rank = (ns: string) => {
    if (ns === '') return Number.MAX_SAFE_INTEGER
    const i = NS_ORDER.indexOf(ns)
    return i >= 0 ? i : NS_ORDER.length
  }
  return [...byNs.entries()]
    .sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b))
    .map(([ns, rows]) => ({ ns, rows: rows.sort(([a], [b]) => a.localeCompare(b)) }))
}

function stringifyAttr(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}
