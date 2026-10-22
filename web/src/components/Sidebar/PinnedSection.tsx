import { useId } from 'react'
import { usePinnedSessionsQuery } from '@/queries/useSessionsQuery'
import { useSidebarViewStore } from '@/stores/useSidebarViewStore'
import { SessionGroupHeader } from './SessionGroupHeader'
import { Collapsible } from '@/components/ui/collapsible'
import { SessionRow, useStableSessionHandlers, type SessionHandlers } from './SessionRow'

/**
 * Pinned sessions from every workspace, above Needs you and the session
 * list, each with the name of the workspace it lives in. Hidden when
 * nothing is pinned.
 */
export function PinnedSection({
  currentSessionId,
  workspaceName,
  editingSessionId = null,
  showDetails = true,
  mobileLongPressActions = false,
  ...handlers
}: SessionHandlers & {
  currentSessionId?: string
  workspaceName: (path: string) => string
  editingSessionId?: string | null
  showDetails?: boolean
  mobileLongPressActions?: boolean
}) {
  const { data } = usePinnedSessionsQuery()
  const collapsed = useSidebarViewStore((s) => s.pinnedCollapsed)
  const setCollapsed = useSidebarViewStore((s) => s.setPinnedCollapsed)
  const stable = useStableSessionHandlers(handlers)
  const listId = useId()
  const sessions = (data?.pages.flatMap((page) => page.data) ?? []).filter((session) => !session.parent_session_id)
  if (sessions.length === 0) return null

  return (
    <section aria-label="Pinned" className="shrink-0 border-b border-(--color-border-subtle) pb-1.5">
      <SessionGroupHeader
        label="Pinned"
        count={sessions.length}
        collapsed={collapsed}
        onToggle={() => setCollapsed(!collapsed)}
        controls={listId}
        tall
      />
      <Collapsible open={!collapsed}>
        <div id={listId} className="max-h-48 space-y-px overflow-y-auto px-1.5">
          {sessions.map((session) => (
            <SessionRow
              key={session.id}
              session={session}
              isCurrent={session.id === currentSessionId}
              isEditing={session.id === editingSessionId}
              currentSessionId={currentSessionId}
              path={session.workspace ?? ''}
              checkoutName={null}
              contextLabel={workspaceName(session.workspace ?? '')}
              showDetails={showDetails}
              mobileLongPressActions={mobileLongPressActions}
              {...stable}
            />
          ))}
        </div>
      </Collapsible>
    </section>
  )
}
