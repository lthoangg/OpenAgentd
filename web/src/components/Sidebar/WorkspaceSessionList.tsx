import { memo, useEffect, useMemo, useRef, useState } from 'react'
import type React from 'react'
import { ChevronRight, GitBranch, Loader2, Pencil, Trash2 } from 'lucide-react'
import { useWorkspaceSessionsQuery, useSessionSubagentsQuery } from '@/queries/useSessionsQuery'
import type { SessionResponse } from '@/api/types'
import { useUnreadStore } from '@/stores/useUnreadStore'
import { formatCompactRelative, formatRelativeDate } from '@/utils/format'
import { LongPressButton } from '@/components/ui/long-press-button'
import { InlineTitleInput } from '@/components/ui/inline-title-input'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { isDeleteKey, isMenuKey, isRenameKey, menuPointFor } from '@/lib/focus/item-keys'
import { SessionStatusMark, sessionStatus } from './SessionStatusMark'
import { LIST_ROW_GEOMETRY, listRowSurface, listRowText } from '@/components/ui/list-row'

function isModifiedPrimaryClick(event: React.MouseEvent): boolean {
  return event.button === 0 && (event.metaKey || event.ctrlKey)
}

/** Where a session's context menu opens: the pointer, or the row for keys. */
export type MenuPoint = Pick<React.MouseEvent, 'clientX' | 'clientY'>

/** Inline row action: in-flow (never overlays the title), 24px target. */
const ROW_ACTION =
  'flex h-6 w-6 shrink-0 items-center justify-center rounded-xs text-(--color-text-subtle) transition-colors hover:bg-(--bg-key) hover:text-(--color-text) pointer-coarse:size-9'

function WorkspaceSessionRowView({
  session,
  isCurrent,
  isEditing,
  currentSessionId,
  path,
  checkoutName,
  mobileLongPressActions,
  onSessionSelect,
  onSessionDelete,
  onSessionEdit,
  onSessionRename,
  onSessionRenameCancel,
  onSessionLongPress,
  onSessionContextActions,
}: {
  session: SessionResponse
  isCurrent: boolean
  isEditing: boolean
  currentSessionId?: string
  path: string
  /** Worktree the session runs in, when the list spans several checkouts. */
  checkoutName: string | null
  mobileLongPressActions: boolean
  onSessionSelect: (session: SessionResponse, workspacePath: string, event?: React.MouseEvent) => void
  onSessionDelete: (e: React.SyntheticEvent, session: SessionResponse) => void
  onSessionEdit: (session: SessionResponse) => void
  onSessionRename: (session: SessionResponse, title: string) => void
  onSessionRenameCancel: () => void
  onSessionLongPress: (session: SessionResponse) => void
  onSessionContextActions: (session: SessionResponse, at: MenuPoint) => void
}) {
  const unread = useUnreadStore((state) => state.ids.includes(session.id))
  const status = sessionStatus(session, unread)
  const sessionTitle = session.title || 'Untitled'
  const sessionDate = formatRelativeDate(session.created_at)
  const sessionAge = formatCompactRelative(session.updated_at ?? session.created_at)
  // Touch without long-press sheets has no hover: keep actions visible there.
  const actionsVisibility = mobileLongPressActions
    ? 'hidden'
    : 'hidden group-hover/row:flex group-focus-within/row:flex pointer-coarse:flex'
  const ageVisibility = mobileLongPressActions
    ? ''
    : 'group-hover/row:hidden group-focus-within/row:hidden pointer-coarse:hidden'

  const isChildSessionCurrent = Boolean(
    currentSessionId && session.subagents?.some((s) => s.id === currentSessionId)
  )
  const isTargetSession = isCurrent || currentSessionId === session.id || isChildSessionCurrent
  const { data: subagentsData } = useSessionSubagentsQuery(session.id, isTargetSession)
  const liveMembers = subagentsData?.live_members ?? subagentsData?.subagents
  const subagents = (isTargetSession && liveMembers !== undefined)
    ? liveMembers
    : (session.subagents && session.subagents.length > 0
        ? session.subagents.map((s) => ({
            session_id: s.id,
            member_id: s.agent_name || s.id,
            profile: s.agent_name || 'member',
            title: s.title || s.agent_name || s.id,
            status: s.running ? 'working' : s.needs_input ? 'waiting_lead' : 'completed',
            created_at: s.created_at,
            has_pending_question: s.needs_input === true,
          }))
        : (liveMembers ?? []))

  const hasSubagents = subagents.length > 0
  const isChildActive = subagents.some((sub) => sub.session_id === currentSessionId)
  const hasWaitingSubagent = subagents.some(
    (sub) => sub.status === 'waiting_lead' || sub.has_pending_question
  )
  const hasWorkingSubagent = subagents.some((sub) => sub.status === 'working')
  const hasActiveWork = hasWaitingSubagent || hasWorkingSubagent

  const [expandedOverride, setExpandedOverride] = useState<boolean | null>(null)
  const isExpanded =
    isChildActive ||
    (expandedOverride !== null
      ? expandedOverride
      : (isCurrent || hasActiveWork))
  const subagentToggleLabel = `${isExpanded ? 'Collapse' : 'Expand'} ${subagents.length} subagents`

  // Keyboard shortcuts for the hover-revealed row actions.
  const handleRowKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (isRenameKey(event)) {
      event.preventDefault()
      onSessionEdit(session)
    } else if (isDeleteKey(event)) {
      event.preventDefault()
      onSessionDelete(event, session)
    } else if (isMenuKey(event) && !mobileLongPressActions) {
      event.preventDefault()
      onSessionContextActions(session, menuPointFor(event.currentTarget))
    } else if (hasSubagents && event.key === 'ArrowRight' && !isExpanded) {
      event.preventDefault()
      setExpandedOverride(true)
    } else if (hasSubagents && event.key === 'ArrowLeft' && isExpanded && !isChildActive) {
      // Otherwise Left moves up to the workspace (Sidebar handles it).
      event.preventDefault()
      setExpandedOverride(false)
    }
  }

  return (
    <div className="space-y-px">
      <div
        data-session-row
        className={`group/row flex h-(--spacing-list-row) items-center rounded-sm pr-1 transition-colors duration-(--motion-instant) ${listRowSurface(isCurrent)}`}
      >
        {/* The title keeps its natural width (basis auto) so, when space
            runs out, the worktree tag beside it gives way first. */}
        <div className="min-w-0 flex-[1_1_auto]">
        {isEditing ? (
          <div className="flex h-(--spacing-list-row) min-w-0 items-center gap-1.5 px-1.5 text-xs">
            <SessionStatusMark status={status} />
            <InlineTitleInput
              initial={session.title || ''}
              label="Session title"
              onSubmit={(title) => onSessionRename(session, title)}
              onCancel={onSessionRenameCancel}
              className="h-6 flex-1 font-medium"
            />
          </div>
        ) : (
        <Tooltip className="w-full">
          <TooltipTrigger
            className="w-full"
            render={
              <LongPressButton
                enabled={mobileLongPressActions}
                onLongPress={() => onSessionLongPress(session)}
                type="button"
                data-sidebar-session=""
                aria-current={isCurrent ? 'page' : undefined}
                onKeyDown={handleRowKeyDown}
                onMouseDown={(e) => {
                  if (!isModifiedPrimaryClick(e)) return
                  onSessionSelect(session, path, e)
                }}
                onClick={(e) => {
                  if (isModifiedPrimaryClick(e)) return
                  onSessionSelect(session, path, e)
                }}
                onDoubleClick={(e) => {
                  e.stopPropagation()
                  onSessionEdit(session)
                }}
                onContextMenu={(e) => {
                  if (mobileLongPressActions) return
                  e.preventDefault()
                  onSessionContextActions(session, e)
                }}
                className={`${LIST_ROW_GEOMETRY} transition-colors ${listRowText(isCurrent)}`}
              >
                <SessionStatusMark status={status} />
                <span className={`min-w-0 flex-1 truncate ${isCurrent ? 'font-semibold text-(--color-text)' : 'font-medium'} ${status !== 'idle' ? 'text-(--color-text)' : ''}`}>{sessionTitle}</span>
                {checkoutName && <span className="sr-only">{`, in worktree ${checkoutName}`}</span>}
              </LongPressButton>
            }
          />
          <TooltipContent>{[sessionTitle, checkoutName, sessionDate].filter(Boolean).join(' · ')}</TooltipContent>
        </Tooltip>
        )}
        </div>
        {/* Subagents fold behind a count pill beside the title, so rows
            without any keep no chevron gutter before it. */}
        {hasSubagents && !isEditing && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              e.preventDefault()
              setExpandedOverride(!isExpanded)
            }}
            className="ml-1 inline-flex h-5 shrink-0 items-center gap-0.5 rounded-full bg-(--bg-key) pl-1.5 pr-1 font-mono text-[11px] leading-4 text-(--color-text-subtle) transition-colors hover:text-(--color-text) pointer-coarse:h-9 pointer-coarse:px-2.5"
            aria-expanded={isExpanded}
            aria-label={subagentToggleLabel}
            title={subagentToggleLabel}
          >
            {!isExpanded && hasActiveWork && (
              <SessionStatusMark
                status={hasWaitingSubagent ? 'needs_input' : 'running'}
                label={hasWaitingSubagent ? 'Subagent waiting for lead' : 'Subagent working'}
              />
            )}
            <span>{subagents.length}</span>
            <ChevronRight
              size={11}
              className={`shrink-0 transition-transform duration-(--motion-fast) ${isExpanded ? 'rotate-90' : ''}`}
              aria-hidden="true"
            />
          </button>
        )}
        {/* Meta slot: the worktree tag and age read at rest; hover/focus
            swaps them for the row actions in the same place, so neither
            covers the title. The tag is its own flex item with an explicit
            minimum, so it shrinks (faster than the title) instead of
            holding its full width. */}
        {checkoutName && !isEditing && (
          <span className={`ml-1 inline-flex min-w-12 max-w-24 shrink-2 items-center gap-0.5 font-mono text-[11px] text-(--color-text-subtle) ${ageVisibility}`} aria-hidden="true">
            <GitBranch size={11} className="shrink-0 text-(--accent-orange-text)" aria-hidden="true" />
            <span data-checkout-tag className="truncate">{checkoutName}</span>
          </span>
        )}
        {sessionAge && !isEditing && (
          <span className={`shrink-0 pl-1 pr-1 text-[11px] tabular-nums text-(--color-text-subtle) ${ageVisibility}`} aria-hidden="true">
            {sessionAge}
          </span>
        )}
        <div className={`shrink-0 items-center ${isEditing ? 'hidden' : actionsVisibility}`}>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              onSessionEdit(session)
            }}
            className={ROW_ACTION}
            aria-label={`Edit session ${session.title || 'Untitled'}`}
          >
            <Pencil size={11} aria-hidden="true" />
          </button>
          <button
            type="button"
            onClick={(e) => onSessionDelete(e, session)}
            className={`${ROW_ACTION} hover:bg-(--color-error-subtle) hover:text-(--color-error)`}
            aria-label={`Delete session ${session.title || 'Untitled'}`}
          >
            <Trash2 size={11} aria-hidden="true" />
          </button>
        </div>
      </div>

      {hasSubagents && isExpanded && (
        // Flat, no guide: subagent marks line up under the lead's title.
        <div className="space-y-px py-0.5 pl-[18px]">
          {subagents.map((sub) => {
            const isSubCurrent = sub.session_id === currentSessionId
            const subTitle = sub.title ? sub.title.replace(/^[^:]+:\s*/, '') : sub.member_id
            const isSubWorking = sub.status === 'working'
            const isSubWaiting = sub.status === 'waiting_lead' || sub.has_pending_question
            const subSessionPayload: SessionResponse = {
              id: sub.session_id,
              parent_session_id: session.id,
              title: `${sub.member_id}: ${subTitle}`,
              workspace: session.workspace,
              interaction_mode: 'code',
              running: isSubWorking,
              needs_input: isSubWaiting,
              created_at: sub.created_at ?? null,
              agent_name: sub.member_id,
              updated_at: null,
            }
            return (
              <div key={sub.session_id} className={`group/sub flex h-6 items-center rounded-sm pr-1 pointer-coarse:h-11 ${isSubCurrent ? 'bg-(--bg-key)/60' : 'hover:bg-(--bg-key)/35'}`}>
                <Tooltip className="min-w-0 flex-1">
                <TooltipTrigger
                  className="w-full min-w-0"
                  render={
                    <button
                      type="button"
                      data-sidebar-session=""
                      aria-current={isSubCurrent ? 'page' : undefined}
                      onKeyDown={(e) => {
                        if (!isDeleteKey(e)) return
                        e.preventDefault()
                        onSessionDelete(e, subSessionPayload)
                      }}
                      onClick={(e) => {
                        onSessionSelect(subSessionPayload, path, e)
                      }}
                      className={`flex h-6 w-full min-w-0 items-center gap-1.5 rounded-sm px-1.5 text-left text-xs transition-colors pointer-coarse:h-11 ${
                        isSubCurrent
                          ? 'text-(--color-text) font-semibold'
                          : 'text-(--color-text-2) hover:text-(--color-text)'
                      }`}
                    >
                      <SessionStatusMark
                        status={isSubWaiting ? 'needs_input' : isSubWorking ? 'running' : 'idle'}
                        label={isSubWaiting ? 'Subagent waiting for lead' : 'Subagent working'}
                      />
                      <span className="shrink-0 font-mono text-[11px] font-semibold text-(--color-text)">
                        {sub.member_id}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-[11px] text-(--color-text-muted)">
                        {subTitle}
                      </span>
                    </button>
                  }
                />
                <TooltipContent>
                  {`${sub.member_id}: ${subTitle} · ${
                    isSubWaiting ? 'Waiting for lead decision' : isSubWorking ? 'Working' : 'Completed'
                  }`}
                </TooltipContent>
              </Tooltip>
              <button
                type="button"
                onClick={(e) => onSessionDelete(e, subSessionPayload)}
                className={`${ROW_ACTION} h-5 w-5 hover:bg-(--color-error-subtle) hover:text-(--color-error) ${mobileLongPressActions ? 'hidden' : 'hidden group-hover/sub:flex group-focus-within/sub:flex pointer-coarse:flex'}`}
                aria-label={`Delete subagent session ${sub.member_id}`}
              >
                <Trash2 size={11} aria-hidden="true" />
              </button>
            </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

/** Memoized: the sidebar re-renders often; unchanged session rows need not. */
const WorkspaceSessionRow = memo(WorkspaceSessionRowView)

type SessionHandlers = Pick<
  React.ComponentProps<typeof WorkspaceSessionRowView>,
  | 'onSessionSelect' | 'onSessionDelete' | 'onSessionEdit' | 'onSessionRename' | 'onSessionRenameCancel'
  | 'onSessionLongPress' | 'onSessionContextActions'
>

const noop = () => {}

export function WorkspaceSessionList({
  path,
  paths,
  checkoutNames,
  currentSessionId,
  runningSessions,
  editingSessionId = null,
  collapsed = false,
  mobileLongPressActions = false,
  className = 'space-y-px py-0.5',
  onSessionSelect,
  onSessionDelete,
  onSessionEdit,
  onSessionRename = noop,
  onSessionRenameCancel = noop,
  onSessionLongPress,
  onSessionContextActions,
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
  mobileLongPressActions?: boolean
  className?: string
  onSessionSelect: (session: SessionResponse, workspacePath: string, event?: React.MouseEvent) => void
  onSessionDelete: (e: React.SyntheticEvent, session: SessionResponse) => void
  onSessionEdit: (session: SessionResponse) => void
  onSessionRename?: (session: SessionResponse, title: string) => void
  onSessionRenameCancel?: () => void
  onSessionLongPress: (session: SessionResponse) => void
  onSessionContextActions: (session: SessionResponse, at: MenuPoint) => void
}) {
  const multiCheckout = paths !== undefined && paths.length > 1
  const sessions = useWorkspaceSessionsQuery(multiCheckout ? paths : path, !collapsed)
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = sessions
  // An older server ignores the multi-checkout filter and sends every
  // workspace's sessions, so keep only the listed checkouts.
  const listed = (session: SessionResponse) => !multiCheckout || paths.includes(session.workspace ?? '')
  const workspaceSessions = collapsed
    ? (runningSessions ?? [])
    : (sessions.data?.pages.flatMap((page) => page.data).filter(listed) ?? [])

  // The sidebar passes inline callbacks; rows get stable wrappers that call
  // the latest ones, so ``memo`` can skip rows whose session did not change.
  const handlersRef = useRef<SessionHandlers>({ onSessionSelect, onSessionDelete, onSessionEdit, onSessionRename, onSessionRenameCancel, onSessionLongPress, onSessionContextActions })
  useEffect(() => {
    handlersRef.current = { onSessionSelect, onSessionDelete, onSessionEdit, onSessionRename, onSessionRenameCancel, onSessionLongPress, onSessionContextActions }
  })
  const handlers = useMemo<SessionHandlers>(() => ({
    onSessionSelect: (session, workspacePath, event) => handlersRef.current.onSessionSelect(session, workspacePath, event),
    onSessionDelete: (event, session) => handlersRef.current.onSessionDelete(event, session),
    onSessionEdit: (session) => handlersRef.current.onSessionEdit(session),
    onSessionRename: (session, title) => handlersRef.current.onSessionRename(session, title),
    onSessionRenameCancel: () => handlersRef.current.onSessionRenameCancel(),
    onSessionLongPress: (session) => handlersRef.current.onSessionLongPress(session),
    onSessionContextActions: (session, event) => handlersRef.current.onSessionContextActions(session, event),
  }), [])

  // Paging is an explicit row rather than an IntersectionObserver inside a
  // nested scroll box: the sidebar keeps a single scroller and every session
  // page is one deliberate click (or Enter) away.
  return (
    <div className={className}>
      {workspaceSessions.length === 0 && !collapsed && !sessions.isLoading && (
        <p className="flex h-6 items-center pl-6 text-[11px] text-(--color-text-subtle)">No sessions yet.</p>
      )}
      {workspaceSessions.map((session) => {
        const isCurrent = session.id === currentSessionId
        const workspace = session.workspace || path
        return (
          <WorkspaceSessionRow
            key={session.id}
            session={session}
            isCurrent={isCurrent}
            isEditing={session.id === editingSessionId}
            currentSessionId={currentSessionId}
            path={workspace}
            checkoutName={checkoutNames?.get(workspace) ?? null}
            mobileLongPressActions={mobileLongPressActions}
            {...handlers}
          />
        )
      })}
      {!collapsed && hasNextPage && (
        <button
          type="button"
          onClick={() => { if (!isFetchingNextPage) void fetchNextPage() }}
          disabled={isFetchingNextPage}
          className="flex h-6 w-full items-center gap-1.5 rounded-sm px-1.5 text-left text-[11px] text-(--color-text-muted) transition-colors hover:bg-(--bg-key)/35 hover:text-(--color-text) disabled:cursor-default"
          aria-label={isFetchingNextPage ? 'Loading more sessions' : 'Show more sessions'}
        >
          {/* The status-mark slot, so the label lines up with the titles. */}
          <span className="flex size-3 shrink-0 items-center justify-center" aria-hidden="true">
            {isFetchingNextPage && <Loader2 size={11} className="animate-spin" />}
          </span>
          {isFetchingNextPage ? 'Loading…' : 'Show more'}
        </button>
      )}
    </div>
  )
}
