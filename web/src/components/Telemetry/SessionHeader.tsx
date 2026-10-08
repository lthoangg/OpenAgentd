/**
 * Heading for the per-session view (session filter set): which session the
 * numbers below describe, where it ran, and a way back into it. The numbers
 * include the session's sub-agent sessions, so the heading says how many.
 */
import { useState } from 'react'
import { MessageSquare } from 'lucide-react'
import type { SessionUsage } from '@/api/client'
import { formatShortId, timeAgo } from '@/utils/telemetryFormat'
import { modelName, sessionName, workspaceName } from './model'

export function SessionHeader({
  sessionId,
  row,
  subAgentCount = 0,
  onOpenSession,
}: {
  sessionId: string
  /** ``null`` while loading, or when the session has no turns in the range. */
  row: SessionUsage | null
  /** Sub-agent sessions with usage in the range, counted in the totals. */
  subAgentCount?: number
  onOpenSession?: (sessionId: string) => void
}) {
  const [now] = useState(() => Date.now())
  const facts = row
    ? [
        row.workspace !== null ? workspaceName(row.workspace) : null,
        row.model ? modelName(row.model) : null,
        `active ${timeAgo(row.last_active_ms, now)}`,
      ].filter((part): part is string => part !== null)
    : []
  // Only a row proves the session still exists; without one (no turns in the
  // range, or purged) it may be gone.
  const canOpen = onOpenSession !== undefined && row !== null && row.deleted !== true
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div className="min-w-0">
        <h3 className="truncate text-sm font-semibold text-(--color-text)">
          {row ? sessionName(row) : `Session ${formatShortId(sessionId)}`}
        </h3>
        {facts.length > 0 && <p className="truncate text-xs text-(--color-text-muted)">{facts.join(', ')}</p>}
        {subAgentCount > 0 && (
          <p className="text-xs text-(--color-text-muted)">
            Totals include {subAgentCount} sub-agent {subAgentCount === 1 ? 'session' : 'sessions'}.
          </p>
        )}
        {row?.deleted && <p className="text-xs text-(--color-text-muted)">This session was deleted; its usage is still counted.</p>}
      </div>
      {canOpen && (
        <button
          type="button"
          onClick={() => onOpenSession(sessionId)}
          className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-sm border border-(--color-border) bg-(--bg-card) px-2.5 text-xs text-(--color-text-2) transition-colors hover:bg-(--bg-key) hover:text-(--color-text) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring)/40"
        >
          <MessageSquare size={13} aria-hidden="true" />
          Open session
        </button>
      )}
    </div>
  )
}
