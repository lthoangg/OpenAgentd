import { useEffect, useRef, useState } from 'react'
import type React from 'react'
import { useDebouncedValue } from '@tanstack/react-pacer'
import { Search } from 'lucide-react'
import type { SessionResponse } from '@/api/types'
import { SearchBar } from '@/components/ui/search-bar'
import { EmptyState } from '@/components/ui/empty-state'
import { ROW_TEXT_ACTION } from '@/components/ui/list-row'
import { MatchMarks } from '@/components/ui/match-marks'
import { useCompactRelative } from '@/hooks/useCompactRelative'
import { useSessionSearchQuery, useSessionsQuery } from '@/queries/useSessionsQuery'
import { useUnreadStore } from '@/stores/useUnreadStore'
import { sessionActivityTime } from '../Sidebar.helpers'
import { CompactSessionRow } from './CompactSessionRow'
import { sessionStatus } from './SessionStatusMark'

/** Rows in the phone's "Recently opened" list before anything is typed. */
const RECENT_LIMIT = 8

/** When a result was last used, where the tree shows a row's age. */
function SessionAge({ session }: { session: SessionResponse }) {
  const age = useCompactRelative(sessionActivityTime(session))
  return age ? <span className="shrink-0 pl-1 text-meta tabular-nums text-(--color-text-muted)">{age}</span> : null
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`
}

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
  const resultsRef = useRef<HTMLDivElement>(null)

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
  // Off the phone, matches sit under their workspace (in the order their
  // newest match arrived), with the match marked: titles alike across
  // workspaces read apart, and the rows show their age instead.
  const grouped = !cancel
  const groups: { path: string; sessions: SessionResponse[] }[] = []
  if (grouped) {
    for (const session of results) {
      const path = session.workspace ?? ''
      const group = groups.find((entry) => entry.path === path)
      if (group) group.sessions.push(session)
      else groups.push({ path, sessions: [session] })
    }
  }
  const renderGroupedRow = (session: SessionResponse) => (
    <li key={session.id}>
      <CompactSessionRow
        session={session}
        status={sessionStatus(session, unreadIds.includes(session.id))}
        isCurrent={session.id === currentSessionId}
        workspaceName={workspaceName(session.workspace ?? '')}
        title={<span data-search-title=""><MatchMarks text={session.title || 'Untitled'} words={[needle]} /></span>}
        meta={<SessionAge session={session} />}
        walkable
        onSelect={(event) => onSessionSelect(session, session.workspace ?? '', event)}
      />
    </li>
  )
  const firstResult = () => resultsRef.current?.querySelector<HTMLElement>('[data-sidebar-session]') ?? null

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
          filled={cancel}
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
            } else if (event.key === 'ArrowDown' && grouped && firstResult()) {
              event.preventDefault()
              firstResult()?.focus()
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
      <div
        ref={resultsRef}
        role="region"
        aria-label="Search results"
        className={cancel ? 'min-h-0 flex-1 overflow-y-auto px-3 pb-2 animate-in fade-in-0 animation-duration-(--motion-base)' : 'min-h-0 flex-1 overflow-y-auto px-1.5 pb-2'}
        onKeyDown={(event) => {
          // ↑ from the first result goes back to the field; the sidebar walks the rest.
          if (event.key === 'ArrowUp' && event.target === firstResult()) {
            event.preventDefault()
            inputRef.current?.focus()
          }
        }}
      >
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
            <h3 id="session-search-recent" className="pl-6 pr-1.5 pt-2 pb-1 text-meta font-medium text-(--color-text-subtle)">Recently opened</h3>
            <ul aria-labelledby="session-search-recent" className="space-y-px">{recent.map(renderRow)}</ul>
          </>
        )}
        {grouped ? (
          results.length > 0 && (
            <>
              <p className="pl-6 pr-1.5 pt-1 pb-1 text-meta text-(--color-text-muted)">
                {plural(results.length, 'result')} · {plural(groups.length, 'workspace')}
              </p>
              {groups.map((group) => {
                const name = workspaceName(group.path)
                return (
                  <section key={group.path}>
                    <h3 className="truncate pl-6 pr-1.5 pt-2 pb-1 text-meta font-medium text-(--color-text-subtle)">
                      {name} · {group.sessions.length}
                    </h3>
                    <ul aria-label={`${name}, ${plural(group.sessions.length, 'session')}`} className="space-y-px">
                      {group.sessions.map(renderGroupedRow)}
                    </ul>
                  </section>
                )
              })}
            </>
          )
        ) : (
          <ul className="space-y-px">{results.map(renderRow)}</ul>
        )}
        {hasMore && (
          <p className="px-1.5 py-1 text-meta text-(--color-text-subtle)">Showing the newest matches; type more to narrow.</p>
        )}
      </div>
    </div>
  )
}
