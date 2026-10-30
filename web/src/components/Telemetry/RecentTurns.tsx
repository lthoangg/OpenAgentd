/**
 * Recent turns, newest first. Each row is one ``agent_run`` span and opens
 * its trace. Workspace and model columns drop out while that filter is set
 * (every row would repeat it). Paged with "Load more"; the list is short
 * enough that virtualization is not worth its weight.
 */
import { useState } from 'react'
import { ChevronRight } from 'lucide-react'
import type { TraceListItem } from '@/api/client'
import { Button } from '@/components/ui/button'
import { Chip } from '@/components/ui/chip'
import { SectionCard, SectionCardHeader } from '@/components/ui/section-card'
import { Skeleton } from '@/components/ui/skeleton'
import { formatCompact, formatMs, formatSpend, timeAgo } from '@/utils/telemetryFormat'
import { workspaceName } from './model'
import { ModelId, shortDateTime } from './ModelId'

export interface RecentTurnsProps {
  turns: TraceListItem[]
  total: number
  status: 'pending' | 'error' | 'success'
  hasMore: boolean
  loadingMore: boolean
  onLoadMore: () => void
  onRetry: () => void
  onOpen: (traceId: string) => void
  /** Only failed turns are listed (the filter bar's "Failed only"). */
  errorsOnly: boolean
  showWorkspace: boolean
  showModel: boolean
  /** On when the rows come from more than one agent (a lead and its sub-agents). */
  showAgent?: boolean
}

const TH = 'px-3 py-1.5 text-[11px] font-medium text-(--color-text-muted) whitespace-nowrap'
const TD = 'px-3 py-2 whitespace-nowrap'

export function RecentTurns({
  turns,
  total,
  status,
  hasMore,
  loadingMore,
  onLoadMore,
  onRetry,
  onOpen,
  errorsOnly,
  showWorkspace,
  showModel,
  showAgent = false,
}: RecentTurnsProps) {
  // Captured once per mount so relative times do not churn on every render.
  const [now] = useState(() => Date.now())

  return (
    <SectionCard>
      <SectionCardHeader className="flex items-center justify-between gap-2 py-1">
        <span>Recent turns</span>
        <span className="font-normal normal-case tracking-normal text-(--color-text-subtle)">
          {errorsOnly ? 'Failed only' : 'Newest first'}
        </span>
      </SectionCardHeader>

      {status === 'error' && turns.length === 0 ? (
        <div role="alert" className="flex flex-col items-center gap-2 px-3 py-6 text-center">
          <p className="text-xs text-(--color-text-muted)">Couldn&apos;t load turns. Check the server connection.</p>
          <Button type="button" size="sm" onClick={onRetry}>Retry</Button>
        </div>
      ) : status === 'pending' && turns.length === 0 ? (
        <div aria-busy="true" aria-label="Loading turns" className="flex flex-col gap-2 p-3">
          {Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-6 w-full" />)}
        </div>
      ) : turns.length === 0 ? (
        <p className="px-3 py-6 text-center text-xs text-(--color-text-muted)">
          {errorsOnly ? 'No failed turns in this range.' : 'No turns in this range.'}
        </p>
      ) : (
        <>
          {/* Phones: one labelled card per turn instead of a wide table. */}
          <ul className="divide-y divide-(--color-border)/40 md:hidden" aria-label="Recent turns">
            {turns.map((turn) => (
              <TurnCard key={turn.span_id} turn={turn} now={now} onOpen={onOpen} showModel={showModel} />
            ))}
          </ul>
          <div className="hidden overflow-x-auto md:block">
            <table className="w-full min-w-[520px] text-xs">
              <thead>
                <tr className="border-b border-(--color-border)/60 text-left">
                  <th scope="col" className={TH}>When</th>
                  {showAgent && <th scope="col" className={TH}>Agent</th>}
                  {showWorkspace && <th scope="col" className={TH}>Workspace</th>}
                  {showModel && <th scope="col" className={TH}>Model</th>}
                  <th scope="col" className={`${TH} text-right`}>Duration</th>
                  <th scope="col" className={`${TH} text-right`}>Tokens in / out</th>
                  <th scope="col" className={`${TH} text-right`}>Cost</th>
                  <th scope="col" className={TH}>Status</th>
                  <th scope="col" className={TH}><span className="sr-only">Open</span></th>
                </tr>
              </thead>
              <tbody>
                {turns.map((turn) => (
                  <TurnRow
                    key={turn.span_id}
                    turn={turn}
                    now={now}
                    onOpen={onOpen}
                    showWorkspace={showWorkspace}
                    showModel={showModel}
                    showAgent={showAgent}
                  />
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex items-center justify-between gap-2 border-t border-(--color-border) px-3 py-1.5 text-[11px] text-(--color-text-subtle)">
            <span>
              Showing {formatCompact(turns.length)} of {formatCompact(total)} turns
            </span>
            {hasMore && (
              <Button type="button" size="sm" variant="ghost" onClick={onLoadMore} disabled={loadingMore}>
                {loadingMore ? 'Loading…' : `Show ${Math.min(25, Math.max(0, total - turns.length)) || 25} more`}
              </Button>
            )}
          </div>
        </>
      )}
    </SectionCard>
  )
}

function TurnRow({
  turn,
  now,
  onOpen,
  showWorkspace,
  showModel,
  showAgent,
}: {
  turn: TraceListItem
  now: number
  onOpen: (traceId: string) => void
  showWorkspace: boolean
  showModel: boolean
  showAgent: boolean
}) {
  const when = timeAgo(turn.start_ms, now)
  const model = turn.provider_model ?? turn.model
  const open = () => onOpen(turn.trace_id)
  return (
    // The row stays a table row (screen readers keep row/cell navigation);
    // the button in the first cell is the keyboard and assistive-tech path,
    // and a click anywhere else on the row is a mouse shortcut to it.
    <tr
      onClick={open}
      className="group cursor-pointer border-b border-(--color-border)/40 transition-colors duration-(--motion-instant) last:border-b-0 hover:bg-(--bg-page) focus-within:bg-(--bg-page)"
    >
      <td className={TD}>
        <span className="flex items-center gap-2">
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation()
              open()
            }}
            aria-label={`Open turn from ${when}${turn.error ? ', failed' : ''}`}
            className="rounded-xs text-left focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-(--focus-ring)"
          >
            <span className="block text-(--color-text-2) tabular-nums">{shortDateTime(turn.start_ms)}</span>
            <span className="block text-[11px] leading-tight text-(--color-text-subtle)">{when}</span>
          </button>
        </span>
      </td>
      {showAgent && <td className={`${TD} max-w-36 truncate text-(--color-text-2)`}>{turn.agent_name ?? '-'}</td>}
      {showWorkspace && (
        <td className={`${TD} max-w-44 truncate text-(--color-text-2)`}>
          {turn.workspace === undefined ? '-' : workspaceName(turn.workspace)}
        </td>
      )}
      {showModel && (
        <td className={`${TD} max-w-56 text-[11px] text-(--color-text-muted)`}>
          {model ? <ModelId id={model} /> : '-'}
        </td>
      )}
      <td className={`${TD} text-right tabular-nums text-(--color-text-2)`}>{formatMs(turn.duration_ms)}</td>
      <td className={`${TD} text-right font-mono text-[11px] tabular-nums text-(--color-text-muted)`}>
        {formatCompact(turn.input_tokens)} / {formatCompact(turn.output_tokens)}
      </td>
      <td className={`${TD} text-right font-mono text-[11px] tabular-nums text-(--color-text)`}>
        {formatSpend(turn.estimated_cost_usd)}
      </td>
      <td className={TD}>
        {turn.error ? <Chip tone="error">failed</Chip> : <Chip tone="success">ok</Chip>}
      </td>
      <td className="w-8 px-2 py-2 text-right">
        <ChevronRight size={14} aria-hidden="true" className="inline text-(--color-text-subtle) transition-colors group-hover:text-(--color-text-muted)" />
      </td>
    </tr>
  )
}

/** One turn on a phone: when and status, then model, duration, tokens, cost. */
function TurnCard({
  turn,
  now,
  onOpen,
  showModel,
}: {
  turn: TraceListItem
  now: number
  onOpen: (traceId: string) => void
  showModel: boolean
}) {
  const when = timeAgo(turn.start_ms, now)
  const model = turn.provider_model ?? turn.model
  return (
    <li>
      <button
        type="button"
        onClick={() => onOpen(turn.trace_id)}
        aria-label={`Open turn from ${when}${turn.error ? ', failed' : ''}`}
        className="flex min-h-14 w-full flex-col gap-1 px-3 py-2.5 text-left text-xs transition-colors hover:bg-(--bg-page) focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-(--focus-ring)"
      >
        <span className="flex items-center justify-between gap-2">
          <span className="text-(--color-text-2) tabular-nums">
            {shortDateTime(turn.start_ms)} <span className="text-(--color-text-subtle)">· {when}</span>
          </span>
          {turn.error ? <Chip tone="error">failed</Chip> : <Chip tone="success">ok</Chip>}
        </span>
        <span className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-(--color-text-muted)">
          {showModel && model && <ModelId id={model} />}
          <span className="font-mono tabular-nums"><span className="text-(--color-text-subtle)">dur</span> {formatMs(turn.duration_ms)}</span>
          <span className="font-mono tabular-nums">
            <span className="text-(--color-text-subtle)">in/out</span> {formatCompact(turn.input_tokens)}/{formatCompact(turn.output_tokens)}
          </span>
          <span className="font-mono tabular-nums"><span className="text-(--color-text-subtle)">cost</span> {formatSpend(turn.estimated_cost_usd)}</span>
        </span>
      </button>
    </li>
  )
}
