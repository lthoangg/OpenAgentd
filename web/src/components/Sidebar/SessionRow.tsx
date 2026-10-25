import { memo, useEffect, useMemo, useRef, useState } from 'react'
import type React from 'react'
import { ChevronRight, GitBranch, Loader2, MoreHorizontal, Pin, PinOff, SquarePen } from 'lucide-react'
import { useSessionSubagentsQuery } from '@/queries/useSessionsQuery'
import type { SessionResponse } from '@/api/types'
import { useUnreadStore } from '@/stores/useUnreadStore'
import { formatRelativeDate } from '@/utils/format'
import { useCompactRelative } from '@/hooks/useCompactRelative'
import { sessionActivityTime } from '../Sidebar.helpers'
import { LongPressButton } from '@/components/ui/long-press-button'
import { InlineTitleInput } from '@/components/ui/inline-title-input'
import { AnimatedTitle, useTitleWash } from '@/components/ui/animated-title'
import { Skeleton } from '@/components/ui/skeleton'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { isDeleteKey, isMenuKey, isRenameKey, menuPointFor } from '@/lib/focus/item-keys'
import { sessionPrefetchProps } from '@/lib/session-prefetch-row'
import { SessionStatusMark, sessionStatus } from './SessionStatusMark'
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
  const status = sessionStatus(session, unread)
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
                {pinned && <span className="sr-only">, pinned</span>}
              </LongPressButton>
            }
          />
          <TooltipContent>{[sessionTitle, contextLabel, checkoutName, sessionDate].filter(Boolean).join(' · ')}</TooltipContent>
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
            className={`ml-1 ${rowChipClass(!isExpanded && hasActiveWork)}`}
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
        {contextLabel && !isEditing && (
          <span
            data-context-label
            className={`ml-1 min-w-8 max-w-24 shrink-2 truncate font-mono text-[11px] text-(--color-text-subtle) ${ageVisibility}`}
            aria-hidden="true"
          >
            {contextLabel}
          </span>
        )}
        {pinned && !isEditing && (
          <span className={`ml-1 flex shrink-0 items-center text-(--color-text-subtle) ${metaVisibility}`} aria-hidden="true">
            <Pin size={11} />
          </span>
        )}
        {sessionAge && !isEditing && (
          <span className={`shrink-0 pl-1 pr-1 text-[11px] tabular-nums text-(--color-text-subtle) ${ageVisibility}`} aria-hidden="true">
            {sessionAge}
          </span>
        )}
        <div className={`shrink-0 items-center ${isEditing ? 'hidden' : actionsVisibility}`}>
          {canPin && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation()
                onSessionPinToggle?.(session)
              }}
              className={ROW_ACTION}
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
              <div key={sub.session_id} className={`group/sub flex h-6 items-center rounded-sm pr-1 pointer-coarse:h-(--spacing-list-row) ${isSubCurrent ? 'bg-(--bg-key)/60' : 'hover:bg-(--bg-key)/35'}`}>
                <Tooltip className="min-w-0 flex-1">
                <TooltipTrigger
                  className="w-full min-w-0"
                  render={
                    <button
                      type="button"
                      data-sidebar-session=""
                      aria-current={isSubCurrent ? 'page' : undefined}
                      {...(isSubCurrent ? {} : sessionPrefetchProps(sub.session_id, session.workspace))}
                      onKeyDown={(e) => {
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
                      className={`flex h-6 w-full min-w-0 items-center gap-1.5 rounded-sm px-1.5 text-left text-xs transition-colors pointer-coarse:h-(--spacing-list-row) ${
                        isSubCurrent
                          ? 'text-(--color-text) font-semibold'
                          : 'text-(--color-text-2) hover:text-(--color-text)'
                      }`}
                    >
                      <SessionStatusMark
                        status={isSubWaiting ? 'needs_input' : isSubWorking ? 'running' : 'idle'}
                        label={isSubWaiting ? 'Subagent waiting for lead' : 'Subagent working'}
                      />
                      {/* Capped: a handle can fall back to the session id. */}
                      <span className="max-w-[45%] shrink-0 truncate font-mono text-[11px] font-semibold text-(--color-text)">
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
      )}
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
      className="flex h-6 w-full items-center gap-1.5 rounded-sm px-1.5 text-left text-[11px] text-(--color-text-muted) transition-colors hover:bg-(--bg-key)/35 hover:text-(--color-text) disabled:cursor-default pointer-coarse:h-(--spacing-list-row)"
      aria-label={loading ? 'Loading more sessions' : 'Show more sessions'}
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
      {label && <span className="max-w-[40%] shrink-0 truncate font-mono text-[11px] text-(--color-text-subtle)">{label}</span>}
    </div>
  )
}
