import type React from 'react'
import type { SessionResponse } from '@/api/types'
import { needsYouSessions } from '@/lib/active-sessions'
import { useActiveSessionsQuery } from '@/queries/useSessionsQuery'
import { CompactSessionRow } from './CompactSessionRow'

/** Sessions stopped on a question, from every workspace, above the tree. */
export function NeedsYouSection({
  currentSessionId,
  workspaceName,
  onSessionSelect,
}: {
  currentSessionId?: string
  workspaceName: (path: string) => string
  onSessionSelect: (session: SessionResponse, workspacePath: string, event?: React.MouseEvent) => void
}) {
  const { data } = useActiveSessionsQuery()
  const sessions = needsYouSessions(data)
  if (sessions.length === 0) return null

  return (
    <section aria-label="Needs you" className="shrink-0 border-b border-(--color-border-subtle) pb-1.5">
      <div className="flex h-8 items-center gap-1.5 pl-3 pr-1.5 text-[11px] leading-none">
        <span className="label-caps text-(--color-text-subtle)">Needs you</span>
        <span className="tabular-nums text-(--color-warning)">{sessions.length}</span>
      </div>
      <ul className="max-h-48 space-y-px overflow-y-auto px-1.5">
        {sessions.map((session) => (
          <li key={session.id}>
            <CompactSessionRow
              session={session}
              status="needs_input"
              isCurrent={session.id === currentSessionId}
              workspaceName={workspaceName(session.workspace ?? '')}
              onSelect={(event) => onSessionSelect(session, session.workspace ?? '', event)}
            />
          </li>
        ))}
      </ul>
    </section>
  )
}
