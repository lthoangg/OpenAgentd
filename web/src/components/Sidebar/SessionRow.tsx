import { memo, useEffect, useMemo, useRef, useState } from 'react'
import type React from 'react'
import { ArrowUpRight, ChevronRight, CornerLeftUp, GitBranch, Loader2, MoreHorizontal, Pin, PinOff, SquarePen, Target } from 'lucide-react'
import { useSessionSubagentsQuery } from '@/queries/useSessionsQuery'
import type { SessionResponse } from '@/api/types'
import { useUnreadStore } from '@/stores/useUnreadStore'
import { formatRelativeDate } from '@/utils/format'
import { workspaceLabel } from '@/utils/workspace'
import { useCompactRelative } from '@/hooks/useCompactRelative'
import { sessionActivityTime } from '../Sidebar.helpers'
import { LongPressButton } from '@/components/ui/long-press-button'
import { InlineTitleInput } from '@/components/ui/inline-title-input'
import { AnimatedTitle, useTitleWash } from '@/components/ui/animated-title'
import { Skeleton } from '@/components/ui/skeleton'
import { Collapsible } from '@/components/ui/collapsible'
import { isDeleteKey, isMenuKey, isRenameKey, menuPointFor } from '@/lib/focus/item-keys'
import { sessionPrefetchProps } from '@/lib/session-prefetch-row'
import { SessionStateWord, SessionStatusMark, sessionStateWord, sessionStatus } from './SessionStatusMark'
import { LIST_ROW_GEOMETRY, ROW_ACTION, listRowSurface, listRowText, rowActionsReveal, rowChipClass } from '@/components/ui/list-row'

function isModifiedPrimaryClick(event: React.MouseEvent): boolean {
  return event.button === 0 && (event.metaKey || event.ctrlKey)
}

/** Where a session's context menu opens: the pointer, or the row for keys. */
export type MenuPoint = Pick<React.MouseEvent, 'clientX' | 'clientY'>

/** The row's actions menu opens under its More button, like a dropdown. */
function menuBelow(button: HTMLElement): MenuPoint {
  const rect = button.getBoundingClientRect()
  return { clientX: rect.left, clientY: rect.bottom + 4 }
}

/**
 * A session another workspace ran for this row's session: the workspace in
 * mono, then the title, like a subagent row. Selecting it opens that
 * session in its own workspace.
 */
function LinkedSessionRow({
  session,
  isCurrent,
  mobileLongPressActions,
  onSelect,
  onContextActions,
}: {
  session: SessionResponse
  isCurrent: boolean
  mobileLongPressActions: boolean
  onSelect: (session: SessionResponse, event: React.MouseEvent) => void
  onContextActions: (session: SessionResponse, at: MenuPoint) => void
}) {
  const unread = useUnreadStore((state) => state.ids.includes(session.id))
  const failed = useUnreadStore((state) => state.failed.includes(session.id))
  const status = sessionStatus(session, unread, failed)
  const title = session.title || 'Untitled'
  const where = workspaceLabel(session.workspace ?? '')
  const stateWord = sessionStateWord(status)
  return (
    <div data-linked-session={session.id} className={`group/sub flex h-6 items-center rounded-sm pr-1 pointer-coarse:h-(--spacing-list-row) ${isCurrent ? 'bg-(--bg-key)/60' : 'hover:bg-(--bg-key)/35'}`}>
      <button
        type="button"
        title={[title, where, stateWord].filter(Boolean).join(' · ')}
        data-sidebar-session=""
        aria-current={isCurrent ? 'page' : undefined}
        aria-label={`${title}, in ${where}${stateWord ? `, ${stateWord}` : ''}`}
        {...(isCurrent ? {} : sessionPrefetchProps(session.id, session.workspace))}
        onKeyDown={(e) => {
          if (isMenuKey(e) && !mobileLongPressActions) {
            e.preventDefault()
            onContextActions(session, menuPointFor(e.currentTarget))
          }
        }}
        onClick={(e) => onSelect(session, e)}
        onContextMenu={(e) => {
          if (mobileLongPressActions) return
          e.preventDefault()
          onContextActions(session, e)
        }}
        className={`flex h-6 w-full min-w-0 flex-1 items-center gap-1.5 rounded-sm px-1.5 text-left text-xs transition-colors pointer-coarse:h-(--spacing-list-row) ${
          isCurrent ? 'font-semibold text-(--color-text)' : 'text-(--color-text-2) hover:text-(--color-text)'
        }`}
      >
        <SessionStatusMark status={status} />
        <span data-linked-workspace className="max-w-[45%] shrink-0 truncate font-mono text-meta font-semibold text-(--color-text)">
          {where}
        </span>
        <span className="min-w-0 flex-1 truncate text-meta text-(--color-text-muted)">{title}</span>
      </button>
      <button
        type="button"
        onClick={(e) => onContextActions(session, menuBelow(e.currentTarget))}
        className={`${ROW_ACTION} ${mobileLongPressActions ? 'hidden' : rowActionsReveal('sub')}`}
        aria-haspopup="menu"
        aria-label={`More actions for ${title}`}
        title="More"
      >
        <MoreHorizontal size={12} aria-hidden="true" />
      </button>
    </div>
  )
}

function SessionRowView({
  session,
  isCurrent,
  isEditing,
  currentSessionId,
  path,
  checkoutName,
  contextLabel = null,
  showDetails = true,
  mobileLongPressActions,
  onSessionSelect,
  onSessionDelete,
  onSessionEdit,
  onSessionRename,
  onSessionRenameCancel,
  onSessionLongPress,
  onSessionContextActions,
  onSessionPinToggle,
}: {
  session: SessionResponse
  isCurrent: boolean
  isEditing: boolean
  currentSessionId?: string
  path: string
  /** Worktree the session runs in, when the list spans several checkouts. */
  checkoutName: string | null
  /** Where the session lives (workspace name), for lists across workspaces. */
  contextLabel?: string | null
  /** Show the age, worktree tag and workspace label at rest. */
  showDetails?: boolean
  mobileLongPressActions: boolean
  onSessionSelect: (session: SessionResponse, workspacePath: string, event?: React.MouseEvent) => void
  onSessionDelete: (e: React.SyntheticEvent, session: SessionResponse) => void
  onSessionEdit: (session: SessionResponse) => void
  onSessionRename: (session: SessionResponse, title: string) => void
  onSessionRenameCancel: () => void
  onSessionLongPress: (session: SessionResponse) => void
  onSessionContextActions: (session: SessionResponse, at: MenuPoint) => void
  /** Pin or unpin; omit to leave the row without a pin action. */
  onSessionPinToggle?: (session: SessionResponse) => void
}) {
  const unread = useUnreadStore((state) => state.ids.includes(session.id))
  const failed = useUnreadStore((state) => state.failed.includes(session.id))
  const status = sessionStatus(session, unread, failed)
  const sessionTitle = session.title || 'Untitled'
  const rowRef = useRef<HTMLDivElement>(null)
  useTitleWash(rowRef, session.id, sessionTitle)
  const sessionDate = formatRelativeDate(session.created_at)
  const sessionAge = useCompactRelative(sessionActivityTime(session))
  const pinned = Boolean(session.pinned_at)
  // Only top-level sessions can be pinned.
  const canPin = Boolean(onSessionPinToggle) && !session.parent_session_id
  const pinLabel = `${pinned ? 'Unpin' : 'Pin'} session ${sessionTitle}`
  // Touch without long-press sheets has no hover: keep actions visible there.
  const actionsVisibility = mobileLongPressActions ? 'hidden' : rowActionsReveal('row')
  const metaVisibility = mobileLongPressActions
    ? ''
    : 'group-hover/row:hidden group-focus-within/row:hidden pointer-coarse:hidden'
  // Touch shows ⋯ at all times and drops the meta for it, but the pin mark
  // is small and says why the row is where it is, so it stays.
  const pinMarkVisibility = mobileLongPressActions ? '' : 'group-hover/row:hidden group-focus-within/row:hidden'
  // The state word is the row's state in words, so "Show details" off does
  // not hide it. It gives way to the actions like the pin mark does, and
  // stays on touch, where the title truncates before it does.
  const stateWord = sessionStateWord(status)
  // "Show details" off hides the at-rest meta; the tooltip still carries it.
  const ageVisibility = showDetails ? metaVisibility : 'hidden'

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
            // Waiting first: a subagent asking its lead keeps its turn open,
            // so it reports `running` as well.
            status: s.needs_input ? 'waiting_lead' : s.running ? 'working' : 'completed',
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

  // Subagents start folded behind the count pill (its dot still shows
  // activity); only an open subagent forces its lead's list open.
  const [expandedOverride, setExpandedOverride] = useState<boolean | null>(null)
  const isExpanded = isChildActive || (expandedOverride ?? false)
  const subagentToggleLabel = `${isExpanded ? 'Collapse' : 'Expand'} ${subagents.length} subagents`

  // Sessions other workspaces ran for this one fold behind their own count
  // pill; opening one of them keeps the group open.
  const linked = session.linked_sessions ?? []
  const hasLinked = linked.length > 0
  const isLinkedCurrent = Boolean(currentSessionId) && linked.some((s) => s.id === currentSessionId)
  const [linkedOverride, setLinkedOverride] = useState<boolean | null>(null)
  const isLinkedExpanded = isLinkedCurrent || (linkedOverride ?? false)
  const linkedWaiting = linked.some((s) => s.needs_input === true)
  const linkedWorking = linked.some((s) => s.needs_input !== true && sessionStatus(s, false) === 'running')
  const linkedToggleLabel = `${isLinkedExpanded ? 'Collapse' : 'Expand'} ${linked.length} ${linked.length === 1 ? 'session' : 'sessions'} in other workspaces`
  const sentFrom = session.sent_from ?? null
  const sentFromName = sentFrom ? workspaceLabel(sentFrom.workspace) : null
  const selectLinked = (target: SessionResponse, event: React.MouseEvent) => onSessionSelect(target, target.workspace ?? path, event)

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
    // data-flip-id: the list slides this row (and its subagents) when it moves.
    <div className="space-y-px" data-flip-id={session.id}>
      <div
        ref={rowRef}
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
        // A ``title``, drawn by the app's title layer: a long session list
        // mounted a full tooltip component per row.
        <LongPressButton
                title={[sessionTitle, stateWord, contextLabel, checkoutName, sessionDate].filter(Boolean).join(' · ')}
                enabled={mobileLongPressActions}
                onLongPress={() => onSessionLongPress(session)}
                type="button"
                data-sidebar-session=""
                aria-current={isCurrent ? 'page' : undefined}
                {...(isCurrent ? {} : sessionPrefetchProps(session.id, session.workspace))}
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
                <AnimatedTitle
                  text={sessionTitle}
                  sessionId={session.id}
                  className={`flex-1 ${isCurrent ? 'font-semibold text-(--color-text)' : 'font-medium'} ${status !== 'idle' ? 'text-(--color-text)' : ''}`}
                />
                {checkoutName && <span className="sr-only">{`, in worktree ${checkoutName}`}</span>}
                {contextLabel && <span className="sr-only">{`, in ${contextLabel}`}</span>}
                {sentFromName && <span className="sr-only">{`, sent from ${sentFromName}`}</span>}
                {pinned && <span className="sr-only">, pinned</span>}
                {session.goal_status && <span className="sr-only">{`, goal ${session.goal_status}`}</span>}
              </LongPressButton>
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
            className={`ml-1 ${rowChipClass(!isExpanded && hasActiveWork)}`}
            aria-expanded={isExpanded}
            aria-label={subagentToggleLabel}
            title={subagentToggleLabel}
          >
            {!isExpanded && hasActiveWork && (
              <SessionStatusMark
                status={hasWaitingSubagent ? 'needs_input' : 'running'}
                label={hasWaitingSubagent ? 'Subagent waiting for the main agent' : 'Subagent working'}
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
        {/* Sessions other workspaces ran for this one, behind their own
            pill: the arrow says they live elsewhere. */}
        {hasLinked && !isEditing && (
          <button
            type="button"
            data-linked-toggle=""
            onClick={(e) => {
              e.stopPropagation()
              e.preventDefault()
              setLinkedOverride(!isLinkedExpanded)
            }}
            className={`ml-1 ${rowChipClass(!isLinkedExpanded && (linkedWaiting || linkedWorking))}`}
            aria-expanded={isLinkedExpanded}
            aria-label={linkedToggleLabel}
            title={linkedToggleLabel}
          >
            {!isLinkedExpanded && (linkedWaiting || linkedWorking) && (
              <SessionStatusMark
                status={linkedWaiting ? 'needs_input' : 'running'}
                label={linkedWaiting ? 'A session in another workspace needs you' : 'A session in another workspace is running'}
              />
            )}
            <ArrowUpRight size={11} className="shrink-0" aria-hidden="true" />
            <span>{linked.length}</span>
            <ChevronRight
              size={11}
              className={`shrink-0 transition-transform duration-(--motion-fast) ${isLinkedExpanded ? 'rotate-90' : ''}`}
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
          <span className={`ml-1 inline-flex min-w-12 max-w-24 shrink-2 items-center gap-0.5 font-mono text-meta text-(--color-text-muted) ${ageVisibility}`} aria-hidden="true">
            <GitBranch size={11} className="shrink-0 text-(--accent-orange-text)" aria-hidden="true" />
            <span data-checkout-tag className="truncate">{checkoutName}</span>
          </span>
        )}
        {contextLabel && !isEditing && (
          <span
            data-context-label
            className={`ml-1 min-w-8 max-w-24 shrink-2 truncate font-mono text-meta text-(--color-text-muted) ${ageVisibility}`}
            aria-hidden="true"
          >
            {contextLabel}
          </span>
        )}
        {/* Where the work came from: stays put on hover (it is a link),
            and opens the session that sent it. */}
        {sentFrom && sentFromName && !isEditing && (
          <button
            type="button"
            data-sent-from={sentFrom.session_id}
            onClick={(e) => {
              e.stopPropagation()
              onSessionSelect(
                { id: sentFrom.session_id, workspace: sentFrom.workspace, title: sentFrom.title ?? null, agent_name: null, created_at: null, updated_at: null },
                sentFrom.workspace,
                e,
              )
            }}
            className="ml-1 inline-flex min-w-8 max-w-24 shrink-2 items-center gap-0.5 rounded-xs font-mono text-meta text-(--color-text-muted) hover:text-(--color-text) focus-visible:outline-2 focus-visible:outline-(--focus-ring)"
            aria-label={`Open the session that sent this, in ${sentFromName}`}
            title={`Sent from ${sentFrom.title ? `“${sentFrom.title}” in ` : ''}${sentFromName}`}
          >
            <CornerLeftUp size={11} className="shrink-0" aria-hidden="true" />
            <span className="truncate">{sentFromName}</span>
          </button>
        )}
        {pinned && !isEditing && (
          <span data-pin-mark="" className={`ml-1 flex shrink-0 items-center text-(--color-text-muted) ${pinMarkVisibility}`} aria-hidden="true">
            <Pin size={11} />
          </span>
        )}
        {session.goal_status && !isEditing && (
          <span
            data-goal-status={session.goal_status}
            className={`ml-1 flex shrink-0 items-center ${session.goal_status === 'active' ? 'text-(--color-text-2)' : 'text-(--color-text-muted)'} ${metaVisibility}`}
            title={session.goal_status === 'active' ? 'Working toward a goal' : 'Goal paused'}
            aria-hidden="true"
          >
            <Target size={11} />
          </span>
        )}
        {!isEditing && (stateWord
          ? <SessionStateWord status={status} className={pinMarkVisibility} />
          : sessionAge && (
            <span className={`shrink-0 pl-1 pr-1 text-meta tabular-nums text-(--color-text-muted) ${ageVisibility}`} aria-hidden="true">
              {sessionAge}
            </span>
          ))}
        <div className={`shrink-0 items-center ${isEditing ? 'hidden' : actionsVisibility}`}>
          {canPin && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation()
                onSessionPinToggle?.(session)
              }}
              // Touch: Pin is in the row's More menu, so the title keeps the room.
              className={`${ROW_ACTION} pointer-coarse:hidden`}
              aria-label={pinLabel}
              title={pinned ? 'Unpin' : 'Pin'}
            >
              {pinned ? <PinOff size={11} aria-hidden="true" /> : <Pin size={11} aria-hidden="true" />}
            </button>
          )}
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              onSessionContextActions(session, menuBelow(e.currentTarget))
            }}
            className={ROW_ACTION}
            aria-haspopup="menu"
            aria-label={`More actions for ${sessionTitle}`}
            title="More"
          >
            <MoreHorizontal size={12} aria-hidden="true" />
          </button>
        </div>
      </div>

      {/* Flat, no guide: subagent marks line up under the lead's title. The
          rows fold open and shut (height motion). */}
      <Collapsible open={hasSubagents && isExpanded}>
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
              <div key={sub.session_id} className={`group/sub flex h-6 items-center rounded-sm pr-1 pointer-coarse:h-(--spacing-list-row) ${isSubCurrent ? 'bg-(--bg-key)/60' : 'hover:bg-(--bg-key)/35'}`}>
                    <button
                      type="button"
                      title={`${sub.member_id}: ${subTitle} · ${
                        isSubWaiting ? 'Waiting for main agent' : isSubWorking ? 'Working' : 'Completed'
                      }`}
                      data-sidebar-session=""
                      aria-current={isSubCurrent ? 'page' : undefined}
                      {...(isSubCurrent ? {} : sessionPrefetchProps(sub.session_id, session.workspace))}
                      onKeyDown={(e) => {
                        if (isMenuKey(e) && !mobileLongPressActions) {
                          e.preventDefault()
                          onSessionContextActions(subSessionPayload, menuPointFor(e.currentTarget))
                          return
                        }
                        if (!isDeleteKey(e)) return
                        e.preventDefault()
                        onSessionDelete(e, subSessionPayload)
                      }}
                      onClick={(e) => {
                        onSessionSelect(subSessionPayload, path, e)
                      }}
                      onContextMenu={(e) => {
                        if (mobileLongPressActions) return
                        e.preventDefault()
                        onSessionContextActions(subSessionPayload, e)
                      }}
                      className={`flex h-6 w-full min-w-0 flex-1 items-center gap-1.5 rounded-sm px-1.5 text-left text-xs transition-colors pointer-coarse:h-(--spacing-list-row) ${
                        isSubCurrent
                          ? 'text-(--color-text) font-semibold'
                          : 'text-(--color-text-2) hover:text-(--color-text)'
                      }`}
                    >
                      <SessionStatusMark
                        status={isSubWaiting ? 'needs_input' : isSubWorking ? 'running' : 'idle'}
                        label={isSubWaiting ? 'Subagent waiting for the main agent' : 'Subagent working'}
                      />
                      {/* Capped: a handle can fall back to the session id. */}
                      <span className="max-w-[45%] shrink-0 truncate font-mono text-meta font-semibold text-(--color-text)">
                        {sub.member_id}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-meta text-(--color-text-muted)">
                        {subTitle}
                      </span>
                    </button>
              <button
                type="button"
                onClick={(e) => onSessionContextActions(subSessionPayload, menuBelow(e.currentTarget))}
                className={`${ROW_ACTION} ${mobileLongPressActions ? 'hidden' : rowActionsReveal('sub')}`}
                aria-haspopup="menu"
                aria-label={`More actions for subagent ${sub.member_id}`}
                title="More"
              >
                <MoreHorizontal size={12} aria-hidden="true" />
              </button>
            </div>
            )
          })}
        </div>
      </Collapsible>

      {/* Sessions other workspaces ran for this one, down the whole chain. */}
      <Collapsible open={hasLinked && isLinkedExpanded}>
        <div className="space-y-px py-0.5 pl-[18px]" data-linked-sessions="">
          {linked.map((item) => (
            <LinkedSessionRow
              key={item.id}
              session={item}
              isCurrent={item.id === currentSessionId}
              mobileLongPressActions={mobileLongPressActions}
              onSelect={selectLinked}
              onContextActions={onSessionContextActions}
            />
          ))}
        </div>
      </Collapsible>
    </div>
  )
}

/** Memoized: the sidebar re-renders often; unchanged session rows need not. */
export const SessionRow = memo(SessionRowView)

export type SessionHandlers = Pick<
  React.ComponentProps<typeof SessionRowView>,
  | 'onSessionSelect' | 'onSessionDelete' | 'onSessionEdit' | 'onSessionRename' | 'onSessionRenameCancel'
  | 'onSessionLongPress' | 'onSessionContextActions' | 'onSessionPinToggle'
>

/**
 * The sidebar passes inline callbacks; rows get stable wrappers that call
 * the latest ones, so ``memo`` can skip rows whose session did not change.
 */
export function useStableSessionHandlers(latest: SessionHandlers): SessionHandlers {
  const handlersRef = useRef<SessionHandlers>(latest)
  useEffect(() => {
    handlersRef.current = latest
  })
  // Rows show a pin action only when the caller handles pins.
  const handlesPins = Boolean(latest.onSessionPinToggle)
  return useMemo<SessionHandlers>(() => ({
    onSessionSelect: (session, workspacePath, event) => handlersRef.current.onSessionSelect(session, workspacePath, event),
    onSessionDelete: (event, session) => handlersRef.current.onSessionDelete(event, session),
    onSessionEdit: (session) => handlersRef.current.onSessionEdit(session),
    onSessionRename: (session, title) => handlersRef.current.onSessionRename(session, title),
    onSessionRenameCancel: () => handlersRef.current.onSessionRenameCancel(),
    onSessionLongPress: (session) => handlersRef.current.onSessionLongPress(session),
    onSessionContextActions: (session, event) => handlersRef.current.onSessionContextActions(session, event),
    ...(handlesPins
      ? { onSessionPinToggle: (session: SessionResponse) => handlersRef.current.onSessionPinToggle?.(session) }
      : {}),
  }), [handlesPins])
}

/**
 * Paging is an explicit row rather than an IntersectionObserver inside a
 * nested scroll box: the sidebar keeps a single scroller and every session
 * page is one deliberate click (or Enter) away.
 */
export function ShowMoreRow({ loading, onLoadMore }: { loading: boolean; onLoadMore: () => void }) {
  return (
    <button
      type="button"
      onClick={() => { if (!loading) onLoadMore() }}
      disabled={loading}
      className="flex h-6 w-full items-center gap-1.5 rounded-sm px-1.5 text-left text-meta text-(--color-text-muted) transition-colors hover:bg-(--bg-key)/35 hover:text-(--color-text) disabled:cursor-default pointer-coarse:h-(--spacing-list-row)"
      aria-busy={loading || undefined}
    >
      {/* The status-mark slot, so the label lines up with the titles. */}
      <span className="flex size-3 shrink-0 items-center justify-center" aria-hidden="true">
        {loading && <Loader2 size={11} className="animate-spin" />}
      </span>
      {loading ? 'Loading…' : 'Show more'}
    </button>
  )
}

const SKELETON_TITLE_WIDTHS = ['w-3/4', 'w-1/2', 'w-2/3']

/**
 * Placeholder rows while a session list loads: row geometry, a status-mark
 * dot and a title bar, so the real rows land without the list jumping.
 */
export function SessionRowsSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div role="status" aria-label="Loading sessions" data-session-skeleton className="oa-fade-in-late space-y-px">
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} aria-hidden="true" className="flex h-(--spacing-list-row) items-center gap-1.5 px-1.5">
          <span className="flex size-3 shrink-0 items-center justify-center">
            <Skeleton className="size-1.5 rounded-full" />
          </span>
          <Skeleton className={`h-2.5 ${SKELETON_TITLE_WIDTHS[index % SKELETON_TITLE_WIDTHS.length]}`} />
        </div>
      ))}
    </div>
  )
}

/**
 * The open new-session draft: current, not saved yet, so it has no actions.
 * It becomes a real row when the first message creates the session.
 */
export function DraftSessionRow({ label = null }: { label?: string | null }) {
  return (
    <div
      data-draft-session
      aria-current="page"
      className={`${LIST_ROW_GEOMETRY} ${listRowSurface(true)} ${listRowText(true)}`}
    >
      <span className="flex size-3 shrink-0 items-center justify-center text-(--color-text-subtle)" aria-hidden="true">
        <SquarePen size={11} />
      </span>
      <span className="min-w-0 flex-1 truncate font-semibold italic">New session</span>
      {label && <span className="max-w-[40%] shrink-0 truncate font-mono text-meta text-(--color-text-muted)">{label}</span>}
    </div>
  )
}
