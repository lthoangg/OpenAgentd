import type React from 'react'
import type { SessionResponse } from '@/api/types'
import { needsYouSessions } from '@/lib/active-sessions'
import { useActiveSessionsQuery } from '@/queries/useSessionsQuery'
import { CompactSessionRow } from './CompactSessionRow'
import { SidebarHeading } from './SidebarHeading'

/**
 * Sessions stopped on a question, from every workspace, above the tree. Part
 * of the sidebar's one scroller: no scroll area of its own.
 */
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
    <section aria-label="Needs you" className="shrink-0 pb-1.5">
      <SidebarHeading label="Needs you" count={sessions.length} countLabel={`${sessions.length} waiting`} tone="warning" />
      <ul className="space-y-px px-1.5">
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
