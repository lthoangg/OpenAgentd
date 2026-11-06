import { useEffect, useRef, useState } from 'react'
import type React from 'react'
import { useDebouncedValue } from '@tanstack/react-pacer'
import { Search } from 'lucide-react'
import type { SessionResponse } from '@/api/types'
import { SearchBar } from '@/components/ui/search-bar'
import { EmptyState } from '@/components/ui/empty-state'
import { ROW_TEXT_ACTION } from '@/components/ui/list-row'
import { useSessionSearchQuery, useSessionsQuery } from '@/queries/useSessionsQuery'
import { useUnreadStore } from '@/stores/useUnreadStore'
import { CompactSessionRow } from './CompactSessionRow'
import { sessionStatus } from './SessionStatusMark'

/** Rows in the phone's "Recently opened" list before anything is typed. */
const RECENT_LIMIT = 8

/** Session title search across every workspace; shown in place of the tree. */
export function SessionSearch({
  currentSessionId,
  focusKey,
  workspaceName,
  onSessionSelect,
  onClose,
  cancel = false,
}: {
  currentSessionId?: string
  /** Bump to move focus back into the field (a search request while already open). */
  focusKey: number
  workspaceName: (path: string) => string
  onSessionSelect: (session: SessionResponse, workspacePath: string, event?: React.MouseEvent) => void
  onClose: () => void
  /**
   * A Cancel button beside the field that calls ``onClose``: the phone's
   * Sessions screen has no header Search toggle to close it with.
   */
  cancel?: boolean
}) {
  const [text, setText] = useState('')
  const [query] = useDebouncedValue(text.trim(), { wait: 200 })
  const { data, isFetching } = useSessionSearchQuery(query)
  const unreadIds = useUnreadStore((state) => state.ids)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [focusKey])

  // Filtered here too: an older server ignores ``q`` and sends a normal page.
  const needle = query.toLowerCase()
  const results = needle
    ? (data?.pages.flatMap((page) => page.data) ?? []).filter(
        (session) => session.workspace && (session.title ?? '').toLowerCase().includes(needle),
      )
    : []
  const hasMore = data?.pages.at(-1)?.has_more === true
  // The phone opens search as its own screen: before a query it offers the
  // latest sessions (activity order) rather than an empty pane.
  const { data: recentData } = useSessionsQuery()
  const recent = cancel && !text.trim()
    ? (recentData?.pages.flatMap((page) => page.data) ?? []).filter((session) => session.workspace).slice(0, RECENT_LIMIT)
    : []
  const renderRow = (session: SessionResponse) => (
    <li key={session.id}>
      <CompactSessionRow
        session={session}
        status={sessionStatus(session, unreadIds.includes(session.id))}
        isCurrent={session.id === currentSessionId}
        workspaceName={workspaceName(session.workspace ?? '')}
        onSelect={(event) => onSessionSelect(session, session.workspace ?? '', event)}
      />
    </li>
  )

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        className={cancel
          // The phone: iOS's search bar, the field easing in and Cancel
          // sliding in beside it, on the page's own inset.
          ? 'flex shrink-0 items-center gap-2 px-3 pt-1 pb-2 animate-in fade-in-0 slide-in-from-top-1 animation-duration-(--motion-base) ease-(--ease-out)'
          : 'shrink-0 px-1.5 pb-1'}
      >
        <SearchBar
          ref={inputRef}
          wrapperClassName={cancel ? 'min-w-0 flex-1' : undefined}
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder="Search sessions"
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault()
              event.stopPropagation()
              onClose()
            } else if (event.key === 'Enter' && results[0]) {
              event.preventDefault()
              onSessionSelect(results[0], results[0].workspace ?? '')
            }
          }}
        />
        {cancel && (
          <button
            type="button"
            onClick={onClose}
            className="flex min-h-(--phone-control) shrink-0 items-center px-1 text-sm font-medium text-(--color-accent) animate-in fade-in-0 slide-in-from-right-3 animation-duration-(--motion-base) ease-(--ease-out) active:opacity-60"
          >
            Cancel
          </button>
        )}
      </div>
      <div role="region" aria-label="Search results" className={cancel ? 'min-h-0 flex-1 overflow-y-auto px-3 pb-2 animate-in fade-in-0 animation-duration-(--motion-base)' : 'min-h-0 flex-1 overflow-y-auto px-1.5 pb-2'}>
        {needle && !isFetching && results.length === 0 && (
          <EmptyState
            compact
            icon={Search}
            title={`No sessions match "${query}"`}
            className="px-1.5 py-1"
            action={(
              <button
                type="button"
                className={`${ROW_TEXT_ACTION} -ml-2`}
                onClick={() => {
                  setText('')
                  inputRef.current?.focus()
                }}
              >
                Clear search
              </button>
            )}
          />
        )}
        {recent.length > 0 && (
          <>
            <h3 id="session-search-recent" className="px-1.5 pt-2 pb-1 text-meta font-medium text-(--color-text-subtle)">Recently opened</h3>
            <ul aria-labelledby="session-search-recent" className="space-y-px">{recent.map(renderRow)}</ul>
          </>
        )}
        <ul className="space-y-px">{results.map(renderRow)}</ul>
        {hasMore && (
          <p className="px-1.5 py-1 text-meta text-(--color-text-subtle)">Showing the newest matches; type more to narrow.</p>
        )}
      </div>
    </div>
  )
}
