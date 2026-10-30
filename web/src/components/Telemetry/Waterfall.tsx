/**
 * Span waterfall: the trace's span tree as rows on a shared time ruler.
 * Each row is a type chip, the raw span name in mono, a short summary
 * (model and output tokens, agent, check verdict, error type), the bar, and
 * the duration in a right-aligned column. Tree construction and layout
 * math live in ``@/utils/traceTree``; this module only renders.
 */

import { memo, useMemo } from 'react'
import type { SpanDetail } from '@/api/client'
import {
  buildSpanTree,
  categorizeSpan,
  computeBounds,
  flattenTree,
  spanBarPosition,
  type SpanCategory,
  type SpanNode,
} from '@/utils/traceTree'
import { formatInt, formatMs } from '@/utils/telemetryFormat'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { CATEGORY_ORDER, SpanTypeChip, categoryBarClass, categoryDescription } from './categories'
import { modelName } from './model'

/** Name, bar and duration columns, shared by the header and every row. */
const COLS =
  'grid grid-cols-[minmax(0,1fr)_4.5rem] items-center gap-x-3 md:grid-cols-[minmax(16rem,22rem)_minmax(8rem,1fr)_4.5rem]'
/** Faint quarter lines behind the bars, matching the ruler ticks (desktop only: phones have no ruler). */
const QUARTER_LINES =
  'md:[background-image:repeating-linear-gradient(to_right,transparent_0_calc(25%_-_1px),var(--color-border-subtle)_calc(25%_-_1px)_25%)]'

function attrString(attrs: Record<string, unknown>, key: string): string | null {
  const v = attrs[key]
  return typeof v === 'string' && v !== '' ? v : null
}

function attrNumber(attrs: Record<string, unknown>, key: string): number | null {
  const raw = attrs[key]
  if (raw === null || raw === undefined || raw === '') return null
  const n = typeof raw === 'number' ? raw : Number(raw)
  return Number.isFinite(n) ? n : null
}

/** The few words after the span name: what this span was about. */
export function spanSummary(span: SpanDetail, category: SpanCategory): string | null {
  const a = span.attributes
  const errorType = attrString(a, 'error.type')
  if (span.status === 'ERROR') return errorType ?? 'failed'
  const model = attrString(a, 'gen_ai.response.model') ?? attrString(a, 'gen_ai.request.model')
  // Skip what the raw name already says (`chat <model>`, `agent_run <agent>`).
  const fresh = (part: string | null | undefined) => (part && !span.name.includes(part) ? part : null)
  const join = (...parts: Array<string | null | undefined>) => parts.filter(Boolean).join(' · ') || null
  switch (category) {
    case 'agent_run':
      return fresh(attrString(a, 'gen_ai.agent.name'))
    case 'chat': {
      const out = attrNumber(a, 'gen_ai.usage.output_tokens')
      return join(fresh(model && modelName(model)), out !== null ? `out ${formatInt(out)}` : null)
    }
    case 'goal': {
      const met = a['goal_check.met']
      return join(met === true ? 'met' : met === false ? 'not yet' : null, fresh(model && modelName(model)))
    }
    case 'summarization':
    case 'title':
      return fresh(model && modelName(model))
    default:
      return null
  }
}

/** Time to first token as a share of the span, for the hatched lead-in on model calls. */
function waitShare(span: SpanDetail): number {
  const ttftS = attrNumber(span.attributes, 'gen_ai.response.time_to_first_chunk')
  if (ttftS === null || ttftS <= 0 || span.duration_ms <= 0) return 0
  return Math.min(100, ((ttftS * 1000) / span.duration_ms) * 100)
}

/** A ruler tick: "0 s", "3.0 s", or ms for sub-second traces. */
function tickLabel(ms: number, totalMs: number): string {
  if (totalMs < 1000) return `${Math.round(ms)} ms`
  if (ms === 0) return '0 s'
  return `${(ms / 1000).toFixed(totalMs >= 20_000 ? 0 : 1)} s`
}

export function Waterfall({
  spans,
  selectedSpanId,
  onSelectSpan,
}: {
  spans: SpanDetail[]
  selectedSpanId: string | null
  onSelectSpan: (id: string) => void
}) {
  // Tree is stable for the lifetime of the query payload — memoize.
  const { bounds, rows, present, anyError, anyWait } = useMemo(() => {
    const tree = buildSpanTree(spans)
    const cats = new Set(spans.map((s) => categorizeSpan(s.name)))
    return {
      bounds: computeBounds(spans),
      rows: flattenTree(tree),
      present: CATEGORY_ORDER.filter((c) => cats.has(c)),
      anyError: spans.some((s) => s.status === 'ERROR'),
      anyWait: spans.some((s) => waitShare(s) > 0),
    }
  }, [spans])

  if (rows.length === 0) {
    return <p className="p-6 text-center text-xs text-(--color-text-muted)">This trace contains no spans.</p>
  }

  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => tickLabel(f * bounds.duration_ms, bounds.duration_ms))

  return (
    <div className="flex shrink-0 flex-col gap-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[11px] text-(--color-text-muted)">
        <span>
          {rows.length} span{rows.length === 1 ? '' : 's'} · trace duration{' '}
          <span className="font-mono text-(--color-text-2)">{formatMs(bounds.duration_ms)}</span>
        </span>
        <ul aria-label="Span types" className="flex flex-wrap items-center gap-1.5">
          {present.map((c) => (
            <li key={c} title={categoryDescription(c)}>
              <SpanTypeChip category={c} />
            </li>
          ))}
          {anyError && (
            <li title="The span ended with an error.">
              <SpanTypeChip category="other" error />
            </li>
          )}
        </ul>
        {anyWait && <span className="max-md:hidden">Hatched: waiting for the first token</span>}
      </div>
      <div className="overflow-x-auto rounded-sm border border-(--color-border) bg-(--bg-card)">
        <div>
          <div
            className={cn(COLS, 'h-7 border-b border-(--color-border-subtle) px-3 font-mono text-[11px] text-(--color-text-muted) select-none')}
          >
            <span>Span</span>
            <span
              aria-label={`Time from trace start, 0 to ${formatMs(bounds.duration_ms)}`}
              className="flex justify-between tabular-nums max-md:hidden"
            >
              {ticks.map((t, i) => (
                <span key={i} aria-hidden="true">
                  {t}
                </span>
              ))}
            </span>
            <span className="text-right">Duration</span>
          </div>
          <div>
            {rows.map((node) => (
              <WaterfallRow
                key={node.span.span_id}
                node={node}
                bounds={bounds}
                selected={selectedSpanId === node.span.span_id}
                onSelect={onSelectSpan}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

/** Memoized with a shared ``onSelect``: a selection change re-renders two rows. */
const WaterfallRow = memo(function WaterfallRow({
  node,
  bounds,
  selected,
  onSelect,
}: {
  node: SpanNode
  bounds: { start_ms: number; end_ms: number; duration_ms: number }
  selected: boolean
  onSelect: (spanId: string) => void
}) {
  const { span } = node
  const { leftPct, widthPct } = spanBarPosition(span, bounds)
  const category = categorizeSpan(span.name)
  const isError = span.status === 'ERROR'
  const summary = spanSummary(span, category)
  const wait = category === 'chat' && !isError ? waitShare(span) : 0

  return (
    <button
      type="button"
      onClick={() => onSelect(span.span_id)}
      aria-pressed={selected}
      aria-label={`${span.name}${summary ? `, ${summary}` : ''}, ${isError ? 'error' : 'ok'}, duration ${formatMs(span.duration_ms)}`}
      className={cn(
        COLS,
        'min-h-9 w-full px-3 pt-1.5 text-left md:pt-0 text-xs transition-colors hover:bg-(--bg-key)/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-(--focus-ring) md:min-h-7',
        selected && 'bg-(--bg-key)',
      )}
    >
      <span className="flex min-w-0 items-center gap-2" style={{ paddingLeft: `${node.depth * 14}px` }}>
        <SpanTypeChip category={category} error={isError} />
        <Tooltip className="min-w-0">
          <TooltipTrigger
            render={
              <span className="flex min-w-0 items-baseline gap-1.5 whitespace-nowrap">
                <span className="truncate font-mono font-medium text-(--color-text)">{span.name}</span>
                {summary && (
                  <span className={cn('max-w-[60%] shrink-0 truncate text-[11px]', isError ? 'text-(--color-error)' : 'text-(--color-text-muted)')}>
                    {summary}
                  </span>
                )}
              </span>
            }
          />
          <TooltipContent>
            <span className="font-mono">{span.name}</span>
            {summary && <span className="block opacity-70">{summary}</span>}
          </TooltipContent>
        </Tooltip>
      </span>
      <span
        className={cn(
          'relative order-last col-span-2 mb-2 h-3 md:order-none md:col-span-1 md:mb-0 md:h-full md:min-h-7 md:self-stretch',
          QUARTER_LINES,
        )}
      >
        <span
          className={cn('absolute top-1/2 h-2.5 -translate-y-1/2 overflow-hidden rounded-xs', categoryBarClass(category, isError))}
          style={{ left: `${leftPct}%`, width: `${widthPct}%` }}
        >
          {wait > 0 && (
            <span
              aria-hidden="true"
              className="absolute inset-y-0 left-0"
              style={{
                width: `${wait}%`,
                backgroundImage: 'repeating-linear-gradient(45deg, transparent 0 3px, rgb(0 0 0 / 0.35) 3px 5px)',
              }}
            />
          )}
        </span>
      </span>
      <span className={cn('text-right font-mono tabular-nums', isError ? 'text-(--color-error)' : 'text-(--color-text-2)')}>
        {formatMs(span.duration_ms)}
      </span>
    </button>
  )
})
