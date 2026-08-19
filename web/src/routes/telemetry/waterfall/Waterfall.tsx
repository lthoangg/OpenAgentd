/**
 * Span waterfall — shows the trace's span tree as horizontal bars positioned
 * along a shared timeline.  Tree construction & layout math live in
 * ``@/utils/traceTree``; this module only renders.
 */

import { useMemo } from 'react'
import type { SpanDetail } from '@/api/client'
import {
  buildSpanTree,
  categorizeSpan,
  computeBounds,
  flattenTree,
  spanBarPosition,
  type SpanNode,
} from '@/utils/traceTree'
import { formatMs } from '@/utils/telemetryFormat'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { EmptyTable } from '../primitives'
import { categoryBarClass, categoryDotClass } from './categories'

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
  const { bounds, rows } = useMemo(() => {
    const tree = buildSpanTree(spans)
    return { bounds: computeBounds(spans), rows: flattenTree(tree) }
  }, [spans])

  if (rows.length === 0) {
    return <EmptyTable label="This trace contains no spans." />
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-baseline justify-between text-xs text-(--color-text-muted)">
        <span>
          {rows.length} span{rows.length === 1 ? '' : 's'}
        </span>
        <span>Total {formatMs(bounds.duration_ms)}</span>
      </div>
      <div className="overflow-x-auto rounded border border-(--color-border) bg-(--bg-card)">
        <div className="min-w-[480px]">
          <div className="flex border-b border-(--color-border)/60 bg-(--bg-key)/25 px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-(--color-text-muted)">
            <div className="w-48 shrink-0 sm:w-64">Span</div>
            <div className="flex-1">Timeline</div>
            <div className="w-20 shrink-0 text-right">Duration</div>
          </div>
          <div className="divide-y divide-(--color-border)/40">
            {rows.map((node) => (
              <WaterfallRow
                key={node.span.span_id}
                node={node}
                bounds={bounds}
                selected={selectedSpanId === node.span.span_id}
                onSelect={() => onSelectSpan(node.span.span_id)}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

function WaterfallRow({
  node,
  bounds,
  selected,
  onSelect,
}: {
  node: SpanNode
  bounds: { start_ms: number; end_ms: number; duration_ms: number }
  selected: boolean
  onSelect: () => void
}) {
  const { leftPct, widthPct } = spanBarPosition(node.span, bounds)
  const category = categorizeSpan(node.span.name)
  const isError = node.span.status === 'ERROR'

  return (
    <button
      type="button"
      onClick={onSelect}
      aria-label={`${node.span.name}, ${category}, ${isError ? 'error' : 'ok'}, duration ${formatMs(node.span.duration_ms)}`}
      className={`flex min-h-10 w-full items-center px-3 py-2 text-left text-xs transition-colors hover:bg-(--bg-key)/30 focus:bg-(--bg-key)/40 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-(--focus-ring)/40 md:min-h-0 ${
        selected ? 'bg-(--bg-key)/50' : ''
      }`}
    >
      <div
        className="flex w-48 shrink-0 items-center gap-1.5 sm:w-64"
        style={{ paddingLeft: `${node.depth * 12}px` }}
      >
        <span
          className={`h-2 w-2 shrink-0 rounded-full ${categoryDotClass(category)}`}
          aria-hidden
        />
        <Tooltip className="min-w-0">
          <TooltipTrigger
            render={
              <span
                className={`truncate font-medium ${
                  isError ? 'text-(--color-error)' : 'text-(--color-text)'
                }`}
              >
                {node.span.name}
              </span>
            }
          />
          <TooltipContent>{node.span.name}</TooltipContent>
        </Tooltip>
      </div>
      <div className="relative h-5 flex-1">
        <div
          className={`absolute top-1/2 h-2 -translate-y-1/2 rounded-sm ${categoryBarClass(
            category,
            isError,
          )}`}
          style={{ left: `${leftPct}%`, width: `${widthPct}%` }}
        />
      </div>
      <div className="w-20 shrink-0 text-right tabular-nums text-(--color-text-2)">
        {formatMs(node.span.duration_ms)}
      </div>
    </button>
  )
}
