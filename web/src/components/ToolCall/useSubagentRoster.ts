import { useContext, useMemo } from 'react'
import { QueryClient, QueryClientContext, useQuery } from '@tanstack/react-query'

import { listSubagents } from '@/api/client'
import type { LiveSubagent } from '@/api/types'
import { queryKeys } from '@/queries/keys'
import { useAgentStore } from '@/stores/useAgentStore'

/**
 * Stands in for the app's client where there is none (a transcript rendered
 * on its own), so the query below can be called unconditionally and stay off.
 */
const NO_CLIENT = new QueryClient()

/**
 * The open session's live subagents by handle: the roster the sidebar shares
 * (same key, so one request), which holds each member's session, state and
 * start. A team tool result is a snapshot from when the call ran; the roster
 * is how a row learns where its member is now. ``null`` until it loads, and
 * always without a query client or session.
 */
export function useSubagentRoster(enabled: boolean): Map<string, LiveSubagent> | null {
  const client = useContext(QueryClientContext)
  const sessionId = useAgentStore((state) => state.sessionId)
  const { data } = useQuery(
    {
      queryKey: queryKeys.session.subagents(sessionId ?? ''),
      queryFn: () => listSubagents(sessionId!),
      enabled: enabled && Boolean(client && sessionId),
      staleTime: 5000,
    },
    client ?? NO_CLIENT,
  )
  return useMemo(() => {
    const members = data?.live_members ?? data?.subagents
    return members ? new Map(members.map((member) => [member.member_id, member])) : null
  }, [data])
}
