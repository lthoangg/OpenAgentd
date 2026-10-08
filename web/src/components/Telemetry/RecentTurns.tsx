/**
 * Recent turns, newest first. Each row is one ``agent_run`` span and opens
 * its trace. Workspace and model columns drop out while that filter is set
 * (every row would repeat it). Paged with "Load more"; the list is short
 * enough that virtualization is not worth its weight.
 */
import { useState } from 'react'
import { ChevronRight } from 'lucide-react'
import type { TraceListItem } from '@/api/client'
import { SectionCard, SectionCardHeader } from '@/components/ui/section-card'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { formatFullDateTime } from '@/utils/format'
import { formatCompact, formatMs, formatSpend, timeAgo } from '@/utils/telemetryFormat'
import { modelName, workspaceName } from './model'

export interface RecentTurnsProps {
  turns: TraceListItem[]
  total: number
  status: 'pending' | 'error' | 'success'
  hasMore: boolean
  loadingMore: boolean
  onLoadMore: () => void
  onRetry: () => void
  onOpen: (traceId: string) => void
  errorsOnly: boolean
  onErrorsOnlyChange: (value: boolean) => void
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
  onErrorsOnlyChange,
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
        <label className="flex cursor-pointer items-center gap-2 font-normal normal-case tracking-normal text-(--color-text-muted)">
          Failed only
          <Switch checked={errorsOnly} onCheckedChange={onErrorsOnlyChange} aria-label="Failed turns only" />
        </label>
      </SectionCardHeader>

      {status === 'error' && turns.length === 0 ? (
        <div className="flex flex-col items-center gap-2 px-3 py-6 text-center">
          <p className="text-xs text-(--color-text-muted)">Could not load turns.</p>
          <button
            type="button"
            onClick={onRetry}
            className="h-7 rounded-sm border border-(--color-border) px-3 text-xs text-(--color-text) transition-colors hover:bg-(--bg-key)"
          >
            Retry
          </button>
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
          <div className="overflow-x-auto">
            <table className="w-full min-w-[520px] text-xs">
              <thead>
                <tr className="border-b border-(--color-border)/60 text-left">
                  <th scope="col" className={TH}>When</th>
                  {showAgent && <th scope="col" className={TH}>Agent</th>}
                  {showWorkspace && <th scope="col" className={TH}>Workspace</th>}
                  {showModel && <th scope="col" className={TH}>Model</th>}
                  <th scope="col" className={`${TH} text-right`}>Duration</th>
                  <th scope="col" className={`${TH} text-right`}>Tokens</th>
                  <th scope="col" className={`${TH} text-right`}>Cost</th>
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
              {formatCompact(turns.length)} of {formatCompact(total)}
            </span>
            {hasMore && (
              <button
                type="button"
                onClick={onLoadMore}
                disabled={loadingMore}
                className="h-6 rounded-sm px-2 text-[11px] font-medium text-(--color-text-muted) transition-colors hover:bg-(--bg-key) hover:text-(--color-text) disabled:opacity-60"
              >
                {loadingMore ? 'Loading…' : 'Load more'}
              </button>
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
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation()
                    open()
                  }}
                  aria-label={`Open turn from ${when}${turn.error ? ', failed' : ''}`}
                  className="rounded-xs text-left text-(--color-text-2) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring)/40"
                >
                  {when}
                </button>
              }
            />
            <TooltipContent>{formatFullDateTime(new Date(turn.start_ms))}</TooltipContent>
          </Tooltip>
          {turn.error && (
            <span className="rounded-xs border border-(--color-error)/20 bg-(--color-error-subtle) px-1.5 text-[11px] font-medium text-(--color-error)">
              Failed
            </span>
          )}
        </span>
      </td>
      {showAgent && <td className={`${TD} max-w-36 truncate text-(--color-text-2)`}>{turn.agent_name ?? '-'}</td>}
      {showWorkspace && (
        <td className={`${TD} max-w-44 truncate text-(--color-text-2)`}>
          {turn.workspace === undefined ? '-' : workspaceName(turn.workspace)}
        </td>
      )}
      {showModel && (
        <td className={`${TD} max-w-52 truncate font-mono text-[11px] text-(--color-text-muted)`}>
          {model ? modelName(model) : '-'}
        </td>
      )}
      <td className={`${TD} text-right tabular-nums text-(--color-text-2)`}>{formatMs(turn.duration_ms)}</td>
      <td className={`${TD} text-right font-mono text-[11px] tabular-nums text-(--color-text-muted)`}>
        {formatCompact(turn.input_tokens)} / {formatCompact(turn.output_tokens)}
      </td>
      <td className={`${TD} text-right font-mono text-[11px] tabular-nums text-(--color-text)`}>
        {formatSpend(turn.estimated_cost_usd)}
      </td>
      <td className="w-8 px-2 py-2 text-right">
        <ChevronRight size={14} aria-hidden="true" className="inline text-(--color-text-subtle) transition-colors group-hover:text-(--color-text-muted)" />
      </td>
    </tr>
  )
}
