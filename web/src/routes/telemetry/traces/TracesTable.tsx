/**
 * Recent traces table — header rendered by ``TracesSection``.  Each row is
 * clickable; the parent owns the selection state.
 */

import { useRef, useState } from 'react'
import { ChevronRight, Copy } from 'lucide-react'
import type { TraceListItem } from '@/api/client'
import {
  formatCompact,
  formatMs,
  formatPercent,
  formatShortId,
  formatUsd,
  timeAgo,
} from '@/utils/telemetryFormat'
import { Td, Th } from '../primitives'
import { useIsMobile } from '@/hooks/use-mobile'
import { usePlatform } from '@/hooks/use-platform'
import { mediumHapticFeedback } from '@/lib/haptics'

const TRACE_LONG_PRESS_MS = 520
const TRACE_LONG_PRESS_MOVE_TOLERANCE = 10

export function TracesTable({
  traces,
  onSelect,
  embedded = false,
}: {
  traces: TraceListItem[]
  onSelect: (traceId: string) => void
  embedded?: boolean
}) {
  // "Now" is captured once per TracesTable mount via a lazy useState initializer
  // — keeps the render pure (no Date.now() call during render) while still
  // giving fresh labels whenever the table unmounts/remounts on refetch.
  const [now] = useState(() => Date.now())
  const table = (
    <table className="min-w-[720px] w-full text-xs">
      <thead className="sticky top-0 z-10">
        <tr className="border-b border-(--color-border) bg-(--bg-key)">
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
      <tbody>
        {traces.map((trace) => (
          <TraceRow key={trace.span_id} trace={trace} now={now} onSelect={onSelect} />
        ))}
      </tbody>
    </table>
  )

  if (embedded) return table

  return (
    <div className="overflow-x-auto rounded-lg border border-(--color-border) bg-(--bg-card)">
      {table}
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
        className="cursor-pointer border-b border-(--color-border) transition-colors last:border-b-0 hover:bg-(--bg-key)/40 focus:bg-(--bg-key)/40 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-(--focus-ring)"
      >
        <Td>
          <span title={new Date(trace.start_ms).toLocaleString()}>
            {timeAgo(trace.start_ms, now)}
          </span>
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
            <span className="rounded bg-(--color-error-subtle) px-1.5 py-0.5 text-[10px] font-medium text-(--color-error)">
              error
            </span>
          ) : (
            <span className="text-(--color-text-muted)">ok</span>
          )}
        </Td>
        <Td align="right">
          <span className="inline-flex h-8 w-8 items-center justify-center rounded-md text-(--color-text-muted) md:h-6 md:w-6">
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
                className="fixed min-w-44 rounded-lg border border-(--color-border) bg-(--bg-card) p-1 text-sm text-(--color-text) shadow-xl"
                style={{ left: actionsPoint.x, top: actionsPoint.y }}
                onClick={(event) => event.stopPropagation()}
              >
                <button
                  type="button"
                  role="menuitem"
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-(--bg-key) focus-visible:bg-(--bg-key) focus-visible:outline-none"
                  onClick={() => {
                    setActionsPoint(null)
                    openTrace()
                  }}
                >
                  <ChevronRight size={14} aria-hidden="true" />
                  Open trace
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-(--bg-key) focus-visible:bg-(--bg-key) focus-visible:outline-none"
                  onClick={() => {
                    setActionsPoint(null)
                    void copyTraceId()
                  }}
                >
                  <Copy size={14} aria-hidden="true" />
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
