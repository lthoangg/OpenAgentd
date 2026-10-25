import { useEffect, useRef, useState } from 'react'
import type React from 'react'
import { useDebouncedValue } from '@tanstack/react-pacer'
import type { SessionResponse } from '@/api/types'
import { SearchBar } from '@/components/ui/search-bar'
import { ROW_TEXT_ACTION } from '@/components/ui/list-row'
import { useSessionSearchQuery } from '@/queries/useSessionsQuery'
import { useUnreadStore } from '@/stores/useUnreadStore'
import { CompactSessionRow } from './CompactSessionRow'
import { sessionStatus } from './SessionStatusMark'

/** Session title search across every workspace; shown in place of the tree. */
export function SessionSearch({
  currentSessionId,
  focusKey,
  workspaceName,
  onSessionSelect,
  onClose,
}: {
  currentSessionId?: string
  /** Bump to move focus back into the field (a search request while already open). */
  focusKey: number
  workspaceName: (path: string) => string
  onSessionSelect: (session: SessionResponse, workspacePath: string, event?: React.MouseEvent) => void
  onClose: () => void
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

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 px-1.5 pb-1">
        <SearchBar
          ref={inputRef}
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
      </div>
      <div role="region" aria-label="Search results" className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
        {needle && !isFetching && results.length === 0 && (
          <div className="flex flex-col items-start gap-1 px-1.5 py-1">
            <p className="break-words text-[11px] text-(--color-text-subtle)">No sessions match “{query}”.</p>
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
          </div>
        )}
        <ul className="space-y-px">
          {results.map((session) => (
            <li key={session.id}>
              <CompactSessionRow
                session={session}
                status={sessionStatus(session, unreadIds.includes(session.id))}
                isCurrent={session.id === currentSessionId}
                workspaceName={workspaceName(session.workspace ?? '')}
                onSelect={(event) => onSessionSelect(session, session.workspace ?? '', event)}
              />
            </li>
          ))}
        </ul>
        {hasMore && (
          <p className="px-1.5 py-1 text-[11px] text-(--color-text-subtle)">Showing the newest matches; type more to narrow.</p>
        )}
      </div>
    </div>
  )
}
