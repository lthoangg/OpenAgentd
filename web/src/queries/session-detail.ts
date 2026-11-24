/**
 * `GET /agent/sessions/:id` as the app layout reads it: which folder a
 * session belongs to, when the loaded session list does not say.
 */
import type { QueryClient } from '@tanstack/react-query'
import { getSession } from '@/api/client'
import { isMissingSessionError } from '@/lib/session-errors'
import { queryKeys } from './keys'

export function sessionDetailQueryOptions(sessionId: string) {
  return {
    queryKey: queryKeys.session.sessions.detail(sessionId),
    queryFn: () => getSession(sessionId),
    staleTime: 30_000,
    // A session the server does not have will not appear on a retry.
    retry: (failures: number, error: unknown) => !isMissingSessionError(error) && failures < 3,
  }
}

interface CachedSessionPages {
  pages: Array<{
    data: Array<{
      id: string
      workspace?: string | null
      subagents?: Array<{ id: string; workspace?: string | null }>
    }>
  }>
}

/**
 * The folder of `sessionId` as the loaded session list knows it: a row's own,
 * or for a subagent under a row its own or else its lead's.
 */
export function cachedSessionWorkspace(queryClient: QueryClient, sessionId: string): string | null {
  const cached = queryClient.getQueryData<CachedSessionPages>(queryKeys.session.sessions.infinite())
  for (const page of cached?.pages ?? []) {
    for (const session of page.data) {
      if (session.id === sessionId) return session.workspace ?? null
      const sub = session.subagents?.find((candidate) => candidate.id === sessionId)
      if (sub) return sub.workspace ?? session.workspace ?? null
    }
  }
  return null
}
