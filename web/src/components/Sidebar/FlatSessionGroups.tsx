import { useMemo } from 'react'
import type { SessionResponse, SessionSort } from '@/api/types'
import { useActiveSessionsQuery, useAllSessionsQuery } from '@/queries/useSessionsQuery'
import { useSidebarViewStore, type SidebarGroupBy } from '@/stores/useSidebarViewStore'
import { groupSessionsByDate, groupSessionsByStatus, type SessionGroup } from '../Sidebar.helpers'
import { SessionGroupHeader } from './SessionGroupHeader'
import { DraftSessionRow, SessionRow, ShowMoreRow, useStableSessionHandlers, type SessionHandlers } from './SessionRow'

function uniqueById(sessions: readonly SessionResponse[]): SessionResponse[] {
  const seen = new Set<string>()
  return sessions.filter((session) => {
    if (seen.has(session.id)) return false
    seen.add(session.id)
    return true
  })
}

/**
 * The sidebar's flat views: every session across workspaces in one list,
 * grouped by status (Needs you · Working · Recent), by date, or not at all.
 * Rows name their workspace. One Show more row at the bottom pages the
 * shared list, so the sidebar keeps its single scroller.
 */
export function FlatSessionGroups({
  groupBy,
  sortBy,
  currentSessionId,
  workspaceName,
  draftWorkspace = null,
  editingSessionId = null,
  showDetails = true,
  mobileLongPressActions = false,
  ...handlers
}: SessionHandlers & {
  groupBy: Exclude<SidebarGroupBy, 'project'>
  sortBy: SessionSort
  currentSessionId?: string
  workspaceName: (path: string) => string
  /** The workspace of the open new-session draft, shown on top. */
  draftWorkspace?: string | null
  editingSessionId?: string | null
  showDetails?: boolean
  mobileLongPressActions?: boolean
}) {
  const all = useAllSessionsQuery(sortBy)
  const active = useActiveSessionsQuery()
  const collapsedGroups = useSidebarViewStore((s) => s.collapsedGroups)
  const toggleGroup = useSidebarViewStore((s) => s.toggleGroupCollapsed)
  const stable = useStableSessionHandlers(handlers)

  // A session that moved while paging (activity order) can show up twice.
  const sessions = useMemo(
    () => uniqueById((all.data?.pages.flatMap((page) => page.data) ?? []).filter((s) => !s.parent_session_id && Boolean(s.workspace))),
    [all.data],
  )
  const activeSessions = useMemo(
    () => (active.data?.pages.flatMap((page) => page.data) ?? []).filter((s) => !s.parent_session_id && Boolean(s.workspace)),
    [active.data],
  )
  const groups: SessionGroup[] = useMemo(() => {
    if (groupBy === 'status') return groupSessionsByStatus(sessions, activeSessions)
    if (groupBy === 'date') return groupSessionsByDate(sessions, sortBy)
    return sessions.length > 0 ? [{ id: 'all', label: 'All', sessions }] : []
  }, [groupBy, sessions, activeSessions, sortBy])

  const renderRow = (session: SessionResponse) => (
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
  )

  return (
    <div className="space-y-1 px-1.5 pt-0.5">
      {draftWorkspace && (
        <div className="space-y-px">
          <DraftSessionRow label={workspaceName(draftWorkspace)} />
        </div>
      )}
      {groups.length === 0 && !all.isLoading && !draftWorkspace && (
        <p className="flex h-6 items-center pl-6 text-[11px] text-(--color-text-subtle)">No sessions yet.</p>
      )}
      {groupBy === 'none'
        ? groups[0] && <div className="space-y-px">{groups[0].sessions.map(renderRow)}</div>
        : groups.map((group) => {
          const key = `${groupBy}:${group.id}`
          const collapsed = collapsedGroups.includes(key)
          const listId = `sidebar-group-${groupBy}-${group.id}`
          return (
            <section key={group.id} aria-label={group.label}>
              <div className="-mx-1.5">
                <SessionGroupHeader
                  label={group.label}
                  count={group.sessions.length}
                  collapsed={collapsed}
                  onToggle={() => toggleGroup(key)}
                  controls={listId}
                  tone={group.id === 'needs_input' ? 'warning' : 'subtle'}
                />
              </div>
              {!collapsed && <div id={listId} className="space-y-px">{group.sessions.map(renderRow)}</div>}
            </section>
          )
        })}
      {all.hasNextPage && (
        <ShowMoreRow loading={all.isFetchingNextPage} onLoadMore={() => { void all.fetchNextPage() }} />
      )}
    </div>
  )
}
