import { useEffect, useState } from 'react'
import { ArrowUpRight } from 'lucide-react'

import { Chip } from '@/components/ui/chip'
import { listRowClass } from '@/components/ui/list-row'
import { cn } from '@/lib/utils'
import { requestOpenSession } from '@/utils/workspace-messages'
import { subscribeLiveClock } from './liveClock'
import { formatClock, parseStartedAt, subagentStatusView } from './subagentStatus'
import { useSubagentRoster } from './useSubagentRoster'

/**
 * ``mm:ss`` since ``startedAt``, ticking once a second on the shared clock
 * while ``running``; ``null`` otherwise. The subscription ends when the row
 * stops running or unmounts, so a finished row costs no timer.
 */
export function useElapsedClock(startedAt: number | null, running: boolean): string | null {
  const [now, setNow] = useState(() => Date.now())
  const ticking = running && startedAt !== null
  useEffect(() => {
    if (!ticking) return
    setNow(Date.now())
    return subscribeLiveClock(setNow)
  }, [ticking])
  return ticking ? formatClock(now - startedAt) : null
}

export interface SubagentRowProps {
  /** The member's handle, e.g. ``explorer#1``. */
  handle: string
  /** Raw state from the tool result or the live roster. */
  status?: string | null
  /** Its own session, when known: the row then opens it. */
  sessionId?: string | null
  /** When it started (epoch ms); with a running state, a live timer shows. */
  startedAt?: number | null
  /** An open question makes the row read "Needs you". */
  hasPendingQuestion?: boolean
  className?: string
}

/** Opens a subagent's session in the app, from anywhere in the transcript. */
export function openSubagentSession(sessionId: string): void {
  // Subagents live in their lead's workspace: no workspace switch.
  requestOpenSession({ sessionId, workspace: '' })
}

/**
 * One subagent in a team tool result: handle, state in words (a chip), a live
 * elapsed timer while it runs. With a session id the whole row is a button
 * that opens the subagent's session (28px, 36px on touch, like a sidebar row);
 * without one it is the same row, plain.
 */
export function SubagentRow({ handle, status, sessionId, startedAt = null, hasPendingQuestion = false, className }: SubagentRowProps) {
  const view = subagentStatusView(status, hasPendingQuestion)
  const elapsed = useElapsedClock(startedAt, view?.running === true)

  const body = (
    <>
      <span className="min-w-0 truncate font-mono font-medium text-(--color-text)">{handle}</span>
      {view && (
        <Chip tone={view.tone} dot={view.running || view.waiting} data-subagent-status={view.label}>
          {view.label}
        </Chip>
      )}
      <span className="ml-auto flex shrink-0 items-center gap-1.5">
        {elapsed && (
          <span data-subagent-elapsed="" className="font-mono text-meta tabular-nums text-(--color-text-muted)">
            {elapsed}
          </span>
        )}
        {sessionId && <ArrowUpRight size={12} aria-hidden="true" className="text-(--color-text-muted)" />}
      </span>
    </>
  )

  if (!sessionId) {
    return (
      <div data-subagent-row="" className={cn('flex h-(--spacing-list-row) w-full min-w-0 items-center gap-1.5 px-1.5 text-xs', className)}>
        {body}
      </div>
    )
  }

  return (
    <button
      type="button"
      data-subagent-row=""
      aria-label={`Open ${handle} session${view ? `, ${view.label}` : ''}`}
      onClick={() => openSubagentSession(sessionId)}
      className={cn(listRowClass(), 'cursor-pointer focus-visible:outline-2 focus-visible:outline-(--focus-ring)', className)}
    >
      {body}
    </button>
  )
}

/**
 * ``handle``'s row as the live roster has it now: where its session is, its
 * state, when it started. Under a team call, so following a subagent is one
 * click from the transcript.
 */
export function RosterSubagentRow({ handle, className }: { handle: string; className?: string }) {
  const roster = useSubagentRoster(true)
  const live = roster?.get(handle)
  return (
    <SubagentRow
      handle={handle}
      status={live?.status ?? null}
      sessionId={live?.session_id || null}
      startedAt={parseStartedAt(live?.created_at)}
      hasPendingQuestion={live?.has_pending_question === true}
      className={className}
    />
  )
}
