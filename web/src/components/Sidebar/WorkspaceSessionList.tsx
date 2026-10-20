import type React from 'react'
import { useRef } from 'react'
import { useWorkspaceSessionsQuery } from '@/queries/useSessionsQuery'
import { useFlipReorder } from '@/hooks/useFlipReorder'
import type { SessionResponse } from '@/api/types'
import { DraftSessionRow, SessionRow, ShowMoreRow, useStableSessionHandlers, type MenuPoint } from './SessionRow'

export type { MenuPoint } from './SessionRow'

const noop = () => {}

export function WorkspaceSessionList({
  path,
  paths,
  checkoutNames,
  currentSessionId,
  runningSessions,
  editingSessionId = null,
  collapsed = false,
  showDetails = true,
  draftActive = false,
  mobileLongPressActions = false,
  className = 'space-y-px py-0.5',
  onSessionSelect,
  onSessionDelete,
  onSessionEdit,
  onSessionRename = noop,
  onSessionRenameCancel = noop,
  onSessionLongPress,
  onSessionContextActions,
  onSessionPinToggle,
}: {
  path: string
  /**
   * Every checkout the list spans (a repository and its worktrees). Omit for
   * a single workspace, which lists ``path`` alone.
   */
  paths?: readonly string[]
  /** Worktree names by path; sessions there carry the name as a tag. */
  checkoutNames?: ReadonlyMap<string, string>
  currentSessionId?: string
  runningSessions?: SessionResponse[]
  /** The session whose title is being edited in place, if any. */
  editingSessionId?: string | null
  collapsed?: boolean
  showDetails?: boolean
  /** A new-session draft for this workspace is open: show it on top. */
  draftActive?: boolean
  mobileLongPressActions?: boolean
  className?: string
  onSessionSelect: (session: SessionResponse, workspacePath: string, event?: React.MouseEvent) => void
  onSessionDelete: (e: React.SyntheticEvent, session: SessionResponse) => void
  onSessionEdit: (session: SessionResponse) => void
  onSessionRename?: (session: SessionResponse, title: string) => void
  onSessionRenameCancel?: () => void
  onSessionLongPress: (session: SessionResponse) => void
  onSessionContextActions: (session: SessionResponse, at: MenuPoint) => void
  onSessionPinToggle?: (session: SessionResponse) => void
}) {
  const multiCheckout = paths !== undefined && paths.length > 1
  const sessions = useWorkspaceSessionsQuery(multiCheckout ? paths : path, !collapsed)
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = sessions
  // An older server ignores the multi-checkout filter and sends every
  // workspace's sessions, so keep only the listed checkouts.
  const listed = (session: SessionResponse) => !multiCheckout || paths.includes(session.workspace ?? '')
  // Collapsed, only working sessions show; pinned ones already sit in Pinned.
  const workspaceSessions = collapsed
    ? (runningSessions ?? []).filter((session) => !session.pinned_at)
    : (sessions.data?.pages.flatMap((page) => page.data).filter(listed) ?? [])

  const handlers = useStableSessionHandlers({ onSessionSelect, onSessionDelete, onSessionEdit, onSessionRename, onSessionRenameCancel, onSessionLongPress, onSessionContextActions, onSessionPinToggle })
  const listRef = useRef<HTMLDivElement>(null)
  useFlipReorder(listRef)

  return (
    <div ref={listRef} className={className ? `relative ${className}` : 'relative'}>
      {draftActive && <DraftSessionRow />}
      {workspaceSessions.length === 0 && !collapsed && !sessions.isLoading && !draftActive && (
        <p className="flex h-6 items-center pl-6 text-[11px] text-(--color-text-subtle)">No sessions yet.</p>
      )}
      {workspaceSessions.map((session) => {
        const isCurrent = session.id === currentSessionId
        const workspace = session.workspace || path
        return (
          <SessionRow
            key={session.id}
            session={session}
            isCurrent={isCurrent}
            isEditing={session.id === editingSessionId}
            currentSessionId={currentSessionId}
            path={workspace}
            checkoutName={checkoutNames?.get(workspace) ?? null}
            showDetails={showDetails}
            mobileLongPressActions={mobileLongPressActions}
            {...handlers}
          />
        )
      })}
      {!collapsed && hasNextPage && (
        <ShowMoreRow loading={isFetchingNextPage} onLoadMore={() => { void fetchNextPage() }} />
      )}
    </div>
  )
}
