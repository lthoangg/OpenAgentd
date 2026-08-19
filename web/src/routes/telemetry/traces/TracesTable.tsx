/**
 * Recent traces table — header rendered by ``TracesSection``.  Each row is
 * clickable; the parent owns the selection state.
 */

import { useRef, useState } from 'react'
import { createColumnHelper, tableFeatures, useTable } from '@tanstack/react-table'
import { useVirtualizer } from '@tanstack/react-virtual'
import { ChevronRight, Copy } from 'lucide-react'
import type { TraceListItem } from '@/api/client'
import { formatFullDateTime } from '@/utils/format'
import {
  formatCompact,
  formatMs,
  formatPercent,
  formatShortId,
  formatUsd,
  timeAgo,
} from '@/utils/telemetryFormat'
import { Td, Th } from '../primitives'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useIsMobile } from '@/hooks/use-mobile'
import { usePlatform } from '@/hooks/use-platform'
import { mediumHapticFeedback } from '@/lib/haptics'

const TRACE_LONG_PRESS_MS = 520
const TRACE_LONG_PRESS_MOVE_TOLERANCE = 10
const traceTableFeatures = tableFeatures({})

const columnHelper = createColumnHelper<typeof traceTableFeatures, TraceListItem>()
const traceColumns = [
  columnHelper.accessor('start_ms', { id: 'when', header: 'When' }),
  columnHelper.accessor('session_id', { id: 'session', header: 'Session' }),
  columnHelper.accessor('agent_name', { id: 'agent', header: 'Agent' }),
  columnHelper.accessor((row) => row.provider_model ?? row.model, { id: 'model', header: 'Provider:model' }),
  columnHelper.accessor('duration_ms', { id: 'duration', header: 'Duration' }),
  columnHelper.accessor((row) => `${row.input_tokens}/${row.output_tokens}`, { id: 'tokens', header: 'Input / output' }),
  columnHelper.accessor('cached_tokens', { id: 'cache', header: 'Cache hit' }),
  columnHelper.accessor('estimated_cost_usd', { id: 'cost', header: 'Cost' }),
  columnHelper.accessor('error', { id: 'status', header: 'Status' }),
  columnHelper.display({ id: 'actions' }),
]

export function TracesTable({
  traces,
  onSelect,
  embedded = false,
  scrollElement,
}: {
  traces: TraceListItem[]
  onSelect: (traceId: string) => void
  embedded?: boolean
  scrollElement?: HTMLDivElement | null
}) {
  // "Now" is captured once per TracesTable mount via a lazy useState initializer
  // — keeps the render pure (no Date.now() call during render) while still
  // giving fresh labels whenever the table unmounts/remounts on refetch.
  const [now] = useState(() => Date.now())
  const table = useTable<typeof traceTableFeatures, TraceListItem>({
    features: traceTableFeatures,
    data: traces,
    columns: traceColumns as never,
    getRowId: (trace) => trace.span_id,
  })
  const rows = table.getRowModel().rows
  const shouldVirtualize = embedded && scrollElement !== null && scrollElement !== undefined
  // eslint-disable-next-line react-hooks/incompatible-library
  const rowVirtualizer = useVirtualizer({
    count: shouldVirtualize ? rows.length : 0,
    getScrollElement: () => scrollElement ?? null,
    estimateSize: () => 37,
    overscan: 8,
    useFlushSync: false,
  })
  const virtualRows = shouldVirtualize ? rowVirtualizer.getVirtualItems() : []
  // A newly mounted scroller has no measured viewport until ResizeObserver
  // runs. Keep its rows accessible during that short interval (and in DOM-only
  // unit environments); subsequent virtualizer updates replace them with the
  // visible range.
  const renderedRows =
    shouldVirtualize && virtualRows.length > 0
      ? virtualRows.map((virtualRow) => rows[virtualRow.index])
      : rows
  const tableElement = (
    <table className="min-w-[720px] w-full text-xs">
      <thead className="sticky top-0 z-10">
        <tr className="border-b border-(--color-border)/60 bg-(--bg-key)/25">
          <Th>When</Th>
          <Th>Session</Th>
          <Th>Agent</Th>
          <Th>Provider:model</Th>
          <Th align="right">Duration</Th>
          <Th align="right">Input / output</Th>
          <Th align="right">Cache hit</Th>
          <Th align="right">Cost</Th>
          <Th align="right">Status</Th>
          <Th />
        </tr>
      </thead>
      <tbody data-testid={embedded ? 'virtual-trace-rows' : undefined}>
        {embedded && virtualRows.length > 0 && (
          <tr aria-hidden="true">
            <td colSpan={10} className="p-0" style={{ height: virtualRows[0].start }} />
          </tr>
        )}
        {renderedRows.map((row) => (
          <TraceRow key={row.id} trace={row.original} now={now} onSelect={onSelect} />
        ))}
        {embedded && virtualRows.length > 0 && (
          <tr aria-hidden="true">
            <td
              colSpan={10}
              className="p-0"
              style={{ height: rowVirtualizer.getTotalSize() - virtualRows.at(-1)!.end }}
            />
          </tr>
        )}
      </tbody>
    </table>
  )

  if (embedded) return tableElement

  return (
    <div className="overflow-x-auto rounded border border-(--color-border) bg-(--bg-card)">
      {tableElement}
    </div>
  )
}

function TraceRow({
  trace,
  now,
  onSelect,
}: {
  trace: TraceListItem
  now: number
  onSelect: (traceId: string) => void
}) {
  const isMobile = useIsMobile()
  const { isTauri, os } = usePlatform()
  const isTauriMobile = isTauri && (os === 'ios' || os === 'android')
  const [actionsPoint, setActionsPoint] = useState<{ x: number; y: number } | null>(null)
  const longPressTimerRef = useRef<number | null>(null)
  const longPressStartRef = useRef<{ x: number; y: number } | null>(null)

  const clearLongPress = () => {
    if (longPressTimerRef.current !== null) window.clearTimeout(longPressTimerRef.current)
    longPressTimerRef.current = null
    longPressStartRef.current = null
  }

  const openTrace = () => onSelect(trace.trace_id)
  const copyTraceId = async () => {
    await navigator.clipboard.writeText(trace.trace_id)
  }

  return (
    <>
      <tr
        onClick={openTrace}
        onContextMenu={(event) => {
          if (isTauriMobile) return
          event.preventDefault()
          setActionsPoint({ x: event.clientX, y: event.clientY })
        }}
        onPointerDown={(event) => {
          if (!isMobile || !isTauriMobile || event.pointerType === 'mouse') return
          longPressStartRef.current = { x: event.clientX, y: event.clientY }
          longPressTimerRef.current = window.setTimeout(() => {
            longPressTimerRef.current = null
            longPressStartRef.current = null
            mediumHapticFeedback()
            setActionsPoint({ x: event.clientX, y: event.clientY })
          }, TRACE_LONG_PRESS_MS)
        }}
        onPointerMove={(event) => {
          const start = longPressStartRef.current
          if (!start) return
          if (
            Math.abs(event.clientX - start.x) > TRACE_LONG_PRESS_MOVE_TOLERANCE ||
            Math.abs(event.clientY - start.y) > TRACE_LONG_PRESS_MOVE_TOLERANCE
          ) {
            clearLongPress()
          }
        }}
        onPointerUp={clearLongPress}
        onPointerCancel={clearLongPress}
        onPointerLeave={clearLongPress}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            openTrace()
          }
        }}
        tabIndex={0}
        role="button"
        aria-label={`Open trace ${formatShortId(trace.trace_id)}`}
        className="cursor-pointer border-b border-(--color-border)/40 transition-colors last:border-b-0 hover:bg-(--bg-key)/35 focus:bg-(--bg-key)/40 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-(--focus-ring)/40"
      >
        <Td>
          <Tooltip>
            <TooltipTrigger render={<span>{timeAgo(trace.start_ms, now)}</span>} />
            <TooltipContent>{formatFullDateTime(new Date(trace.start_ms))}</TooltipContent>
          </Tooltip>
        </Td>
        <Td muted mono>
          {trace.session_id ? formatShortId(trace.session_id) : '—'}
        </Td>
        <Td>{trace.agent_name ?? '—'}</Td>
        <Td muted>{trace.provider_model ?? trace.model ?? '—'}</Td>
        <Td align="right">{formatMs(trace.duration_ms)}</Td>
        <Td align="right" muted>
          {formatCompact(trace.input_tokens)} / {formatCompact(trace.output_tokens)}
        </Td>
        <Td align="right" muted>
          {formatPercent(cachePercent(trace.cached_tokens, trace.input_tokens))}
        </Td>
        <Td align="right" muted>{formatUsd(trace.estimated_cost_usd)}</Td>
        <Td align="right">
          {trace.error ? (
            <span className="rounded-xs border border-(--color-error)/20 bg-(--color-error-subtle) px-1.5 py-0.5 text-[10px] font-medium text-(--color-error)">
              error
            </span>
          ) : (
            <span className="text-(--color-text-muted)">ok</span>
          )}
        </Td>
        <Td align="right">
          <span className="inline-flex h-7 w-7 items-center justify-center rounded-sm text-(--color-text-muted) md:h-6 md:w-6">
            <ChevronRight size={15} className="md:h-3.5 md:w-3.5" aria-hidden="true" />
          </span>
        </Td>
      </tr>
      {actionsPoint && (
        <tr className="contents">
          <td className="contents" colSpan={10}>
            <div
              className="fixed inset-0 z-[70]"
              onClick={() => setActionsPoint(null)}
              onContextMenu={(event) => {
                event.preventDefault()
                setActionsPoint(null)
              }}
            >
              <div
                role="menu"
                aria-label={`Actions for trace ${formatShortId(trace.trace_id)}`}
                className="fixed min-w-44 rounded-sm border border-(--color-border) bg-(--bg-card) p-1 text-xs text-(--color-text) shadow-md"
                style={{ left: actionsPoint.x, top: actionsPoint.y }}
                onClick={(event) => event.stopPropagation()}
              >
                <button
                  type="button"
                  role="menuitem"
                  className="flex w-full items-center gap-2 rounded-xs px-2 py-1 text-left text-xs hover:bg-(--bg-key) focus-visible:bg-(--bg-key) focus-visible:outline-none"
                  onClick={() => {
                    setActionsPoint(null)
                    openTrace()
                  }}
                >
                  <ChevronRight size={12} aria-hidden="true" />
                  Open trace
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="flex w-full items-center gap-2 rounded-xs px-2 py-1 text-left text-xs hover:bg-(--bg-key) focus-visible:bg-(--bg-key) focus-visible:outline-none"
                  onClick={() => {
                    setActionsPoint(null)
                    void copyTraceId()
                  }}
                >
                  <Copy size={12} aria-hidden="true" />
                  Copy trace ID
                </button>
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  )
}

function cachePercent(cachedTokens: number, inputTokens: number): number {
  if (inputTokens <= 0) return 0
  return (cachedTokens / inputTokens) * 100
}
