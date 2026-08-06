import { useEffect, useRef } from 'react'
import type React from 'react'
import { Loader2, Pencil, Trash2 } from 'lucide-react'
import { useCodingWorkspaceSessionsQuery } from '@/queries/useSessionsQuery'
import type { SessionResponse } from '@/api/types'
import { formatRelativeDate } from '@/utils/format'
import { LongPressButton } from '@/components/ui/long-press-button'

function isModifiedPrimaryClick(event: React.MouseEvent): boolean {
  return event.button === 0 && (event.metaKey || event.ctrlKey)
}

export function WorkspaceSessionList({
  path,
  currentSessionId,
  runningSessions,
  collapsed = false,
  mobileLongPressActions = false,
  className = 'max-h-[7.75rem] space-y-0.5 overflow-y-auto py-0.5 pl-5 pr-2',
  onSessionSelect,
  onSessionDelete,
  onSessionEdit,
  onSessionLongPress,
  onSessionContextActions,
}: {
  path: string
  currentSessionId?: string
  runningSessions?: SessionResponse[]
  collapsed?: boolean
  mobileLongPressActions?: boolean
  className?: string
  onSessionSelect: (session: SessionResponse, workspacePath: string, event?: React.MouseEvent) => void
  onSessionDelete: (e: React.MouseEvent, session: SessionResponse) => void
  onSessionEdit: (session: SessionResponse) => void
  onSessionLongPress: (session: SessionResponse) => void
  onSessionContextActions: (session: SessionResponse, event: React.MouseEvent) => void
}) {
  const sessions = useCodingWorkspaceSessionsQuery(path, !collapsed)
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = sessions
  const workspaceSessions = collapsed
    ? (runningSessions ?? [])
    : (sessions.data?.pages.flatMap((page) => page.data) ?? [])
  const listRef = useRef<HTMLDivElement>(null)
  const loadMoreRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const sentinel = loadMoreRef.current
    if (!sentinel || collapsed) return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting && hasNextPage && !isFetchingNextPage) {
          void fetchNextPage()
        }
      },
      { root: listRef.current, threshold: 0.1 },
    )
    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [hasNextPage, isFetchingNextPage, fetchNextPage, collapsed])

  return (
    <div ref={listRef} className={className}>
      {workspaceSessions.length === 0 && !collapsed && !sessions.isLoading && (
        <p className="px-2 py-1 text-xs text-(--color-text-subtle)">No sessions yet.</p>
      )}
      {workspaceSessions.map((session) => {
        const isCurrent = session.id === currentSessionId
        // `needs_input` implies `running`, so it has to be checked first — a
        // suspended turn is busy waiting for this user, not busy working.
        const needsInput = session.needs_input === true
        const isRunning = session.running === true && !needsInput
        const sessionTitle = session.title || 'Untitled'
        const sessionDate = formatRelativeDate(session.created_at)
        return (
          <div key={session.id} className="group relative">
            <LongPressButton
              enabled={mobileLongPressActions}
              onLongPress={() => onSessionLongPress(session)}
              type="button"
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
              title={`${sessionTitle} · ${sessionDate}`}
              className={`flex min-h-6 w-full items-center gap-1.5 rounded px-2 py-0.5 text-left text-xs transition-colors ${
                isCurrent
                  ? 'text-(--color-text)'
                  : 'text-(--color-text-2) hover:text-(--color-text)'
              }`}
            >
              <span
                className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                  needsInput
                    ? 'animate-pulse bg-(--color-warning)'
                    : isRunning
                      ? 'session-title-breathe bg-(--color-accent)'
                      : 'border border-(--color-text-subtle)'
                }`}
                aria-label={needsInput ? 'Session needs your input' : isRunning ? 'Session running' : undefined}
                aria-hidden={needsInput || isRunning ? undefined : true}
              />
              <span className={`min-w-0 flex-1 truncate ${isCurrent ? 'font-semibold text-(--color-text)' : 'font-medium'} ${isRunning ? 'session-title-breathe text-(--color-text)' : ''}`}>{sessionTitle}</span>

            </LongPressButton>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation()
                onSessionEdit(session)
              }}
              className={`absolute right-6 top-1/2 flex -translate-y-1/2 items-center justify-center rounded p-1 text-(--color-text-subtle) opacity-0 transition-all hover:bg-(--bg-key) hover:text-(--color-text) group-hover:opacity-100 group-focus-within:opacity-100 ${mobileLongPressActions ? 'hidden' : 'pointer-coarse:opacity-100'}`}
              aria-label={`Edit session ${session.title || 'Untitled'}`}
            >
              <Pencil size={11} />
            </button>
            <button
              type="button"
              onClick={(e) => onSessionDelete(e, session)}
              className={`absolute right-1 top-1/2 flex -translate-y-1/2 items-center justify-center rounded p-1 text-(--color-text-subtle) opacity-0 transition-all hover:bg-(--color-error-subtle) hover:text-(--color-error) group-hover:opacity-100 group-focus-within:opacity-100 ${mobileLongPressActions ? 'hidden' : 'pointer-coarse:opacity-100'}`}
              aria-label={`Delete session ${session.title || 'Untitled'}`}
            >
              <Trash2 size={11} />
            </button>
          </div>
        )
      })}
      {!collapsed && <div ref={loadMoreRef} className="h-1" aria-hidden />}
      {!collapsed && isFetchingNextPage && (
        <div className="flex items-center justify-center py-1 text-(--color-accent)" aria-label="Loading more sessions">
          <Loader2 size={11} className="animate-spin" aria-hidden="true" />
        </div>
      )}
    </div>
  )
}
