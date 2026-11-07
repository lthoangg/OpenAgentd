import { useMemo, useRef } from 'react'
import { MessageCircle } from 'lucide-react'
import type { SessionResponse } from '@/api/types'
import { useFlipReorder } from '@/hooks/useFlipReorder'
import { useActiveSessionsQuery, useAllSessionsQuery } from '@/queries/useSessionsQuery'
import { SESSION_PAGE_SIZE, nextPageCount } from '@/lib/session-pages'
import { useSidebarViewStore, type SidebarGroupBy } from '@/stores/useSidebarViewStore'
import { groupSessionsByDate, groupSessionsByStatus, nestedUnderSender, type SessionGroup } from '../Sidebar.helpers'
import { SessionGroupHeader } from './SessionGroupHeader'
import { Collapsible } from '@/components/ui/collapsible'
import { EmptyState } from '@/components/ui/empty-state'
import { DraftSessionRow, SessionRow, SessionRowsSkeleton, ShowMoreRow, useStableSessionHandlers, type SessionHandlers } from './SessionRow'

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
 * grouped by status (Needs you · Running · Recent), by date, or not at all.
 * Rows name their workspace. One Show more row at the bottom pages the
 * shared list, so the sidebar keeps its single scroller.
 * A session another workspace's send started sits under its sender's row
 * instead of on its own, when the sender is listed; Needs you still lists
 * it, so a question never hides.
 */
export function FlatSessionGroups({
  groupBy,
  currentSessionId,
  workspaceName,
  draftWorkspace = null,
  editingSessionId = null,
  showDetails = true,
  mobileLongPressActions = false,
  ...handlers
}: SessionHandlers & {
  groupBy: Exclude<SidebarGroupBy, 'project'>
  currentSessionId?: string
  workspaceName: (path: string) => string
  /** The workspace of the open new-session draft, shown on top. */
  draftWorkspace?: string | null
  editingSessionId?: string | null
  showDetails?: boolean
  mobileLongPressActions?: boolean
}) {
  const all = useAllSessionsQuery()
  const active = useActiveSessionsQuery()
  const collapsedGroups = useSidebarViewStore((s) => s.collapsedGroups)
  const toggleGroup = useSidebarViewStore((s) => s.toggleGroupCollapsed)
  const stable = useStableSessionHandlers(handlers)
  // One root for every group, so a row moving between groups slides too.
  const listRef = useRef<HTMLDivElement>(null)
  useFlipReorder(listRef)

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
    const listedIds = new Set([...sessions, ...activeSessions].map((session) => session.id))
    const own = sessions.filter((session) => !nestedUnderSender(session, listedIds))
    if (groupBy === 'status') {
      const active = activeSessions.filter((session) => session.needs_input === true || !nestedUnderSender(session, listedIds))
      return groupSessionsByStatus(own, active)
    }
    if (groupBy === 'date') return groupSessionsByDate(own)
    return own.length > 0 ? [{ id: 'all', label: 'All', sessions: own }] : []
  }, [groupBy, sessions, activeSessions])

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
    <div ref={listRef} className="relative space-y-1 px-1.5 pt-0.5">
      {draftWorkspace && (
        <div className="space-y-px">
          <DraftSessionRow label={workspaceName(draftWorkspace)} />
        </div>
      )}
      {all.isLoading && <SessionRowsSkeleton rows={5} />}
      {groups.length === 0 && !all.isLoading && !draftWorkspace && (
        // The icon sits in the status-mark slot, so the words line up with the titles.
        <EmptyState compact icon={MessageCircle} title="No sessions yet" className="px-1.5 py-1" />
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
              <Collapsible open={!collapsed}>
                <div id={listId} className="space-y-px">{group.sessions.map(renderRow)}</div>
              </Collapsible>
            </section>
          )
        })}
      {all.hasNextPage && (
        <ShowMoreRow loading={all.isFetchingNextPage} count={nextPageCount(all.data, SESSION_PAGE_SIZE)} onLoadMore={() => { void all.fetchNextPage() }} />
      )}
    </div>
  )
}
