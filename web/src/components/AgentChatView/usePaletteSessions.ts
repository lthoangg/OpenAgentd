/**
 * The command palette's Sessions group: session titles across every
 * workspace, found through the queries the sidebar already uses (the recent
 * list it shares with Switch Workspace/Session…, and its title search), so
 * the palette adds no endpoint. Picking one opens it the way those pages and
 * the sidebar do.
 */
import { useMemo, useState } from 'react'
import { useDebouncedValue } from '@tanstack/react-pacer'
import { useNavigate } from '@tanstack/react-router'
import type { SessionResponse } from '@/api/types'
import { useSessionSearchQuery, useSessionsQuery } from '@/queries/useSessionsQuery'
import { formatCompactRelative } from '@/utils/format'
import { workspaceLabel } from '@/utils/workspace'
import { sessionActivityTime } from '../Sidebar.helpers'
import { applySessionSelection } from '../Sidebar.sessions'
import type { PaletteSession, PaletteSessions } from '../CommandPalette'

/** Same pause as the sidebar's session search: one request per typing burst. */
const SEARCH_DEBOUNCE_MS = 200

/**
 * The word to ask the server for. It matches a title as a plain substring, so
 * a query of several words (which may sit anywhere in a title) is searched by
 * its longest word; the palette then keeps the titles holding every word.
 */
export function searchTerm(query: string): string {
  let longest = ''
  for (const word of query.split(/\s+/)) if (word.length > longest.length) longest = word
  return longest
}

/**
 * ``workspace name · age``. The age is the session's last activity; a session
 * without a workspace (older data) shows the age alone.
 */
export function sessionDescription(session: SessionResponse, now: Date): string {
  const workspace = session.workspace ? workspaceLabel(session.workspace) : ''
  const age = formatCompactRelative(sessionActivityTime(session), now)
  return [workspace, age].filter(Boolean).join(' · ')
}

export function usePaletteSessions({ currentSessionId }: { currentSessionId: string | null }): PaletteSessions {
  const navigate = useNavigate()
  const [text, setText] = useState('')
  const wanted = searchTerm(text.trim())
  const [term] = useDebouncedValue(wanted, { wait: SEARCH_DEBOUNCE_MS })
  const { data: recent } = useSessionsQuery()
  const { data: found, isFetching } = useSessionSearchQuery(term)

  const items = useMemo(() => {
    const now = new Date()
    const seen = new Set<string>()
    const out: PaletteSession[] = []
    // Search hits first: they reach past the few pages the sidebar has loaded.
    const pages = [...(term ? found?.pages ?? [] : []), ...(recent?.pages ?? [])]
    for (const page of pages) {
      for (const session of page.data) {
        const title = session.title?.trim()
        // Subagents belong to their parent; the current session is already open.
        if (!title || seen.has(session.id) || session.parent_session_id || session.id === currentSessionId) continue
        seen.add(session.id)
        out.push({
          id: session.id,
          title,
          description: sessionDescription(session, now),
          activityAt: sessionActivityTime(session),
          open: () => applySessionSelection({ session, workspacePath: session.workspace ?? '', navigate }),
        })
      }
    }
    return out
  }, [currentSessionId, found, navigate, recent, term])

  // Loading from the first keystroke: the pause before the request counts too.
  const loading = wanted !== '' && (wanted !== term || isFetching)
  return useMemo(() => ({ items, loading, onSearch: setText }), [items, loading])
}
