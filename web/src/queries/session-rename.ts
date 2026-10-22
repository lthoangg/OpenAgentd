import type { QueryClient } from '@tanstack/react-query'
import type { SessionResponse } from '@/api/types'
import { useAgentStore } from '@/stores/useAgentStore'
import { patchSessionTitle } from '@/stores/cache-invalidation-bridge'
import { queryKeys } from './keys'
import { patchSessionInPageData } from './session-cache'

/** Patch every cached copy of a renamed session; the server does not broadcast renames. */
export function applySessionRename(queryClient: QueryClient, updated: SessionResponse): void {
  queryClient.setQueriesData({ queryKey: queryKeys.session.sessions.all() }, (old) => patchSessionInPageData(old, updated))
  queryClient.setQueryData(queryKeys.session.sessions.detail(updated.id), (old: SessionResponse | undefined) => old ? { ...old, ...updated } : old)
  // The header reads the title from the agent store, not the session lists.
  if (useAgentStore.getState().sessionId === updated.id) useAgentStore.setState({ sessionTitle: updated.title })
}

/** The title a session shows now: the header's for the open one, else the cached row's. */
function shownTitle(queryClient: QueryClient, id: string): string | null {
  const store = useAgentStore.getState()
  if (store.sessionId === id && store.sessionTitle) return store.sessionTitle
  const detail = queryClient.getQueryData<SessionResponse>(queryKeys.session.sessions.detail(id))
  if (detail?.title) return detail.title
  for (const [, data] of queryClient.getQueriesData<{ pages?: Array<{ data: SessionResponse[] }> }>({ queryKey: queryKeys.session.sessions.all() })) {
    const row = data?.pages?.flatMap((page) => page.data).find((session) => session.id === id)
    if (row) return row.title ?? null
  }
  return null
}

/**
 * Show ``title`` everywhere the session appears before the server answers.
 * Returns the undo, which puts back only the title (other fields may have
 * moved on meanwhile).
 */
export function applyOptimisticTitle(queryClient: QueryClient, id: string, title: string): () => void {
  const previous = shownTitle(queryClient, id)
  patchSessionTitle(queryClient, id, title)
  if (useAgentStore.getState().sessionId === id) useAgentStore.setState({ sessionTitle: title })
  return () => {
    if (previous === null) return
    patchSessionTitle(queryClient, id, previous)
    if (useAgentStore.getState().sessionId === id) useAgentStore.setState({ sessionTitle: previous })
  }
}
