import { useQuery } from '@tanstack/react-query'
import { shapeAgentStatus } from '@/api/client'
import { agentRegistryQueryOptions } from './agent-registry'
import type { AgentStatusResponse } from '@/api/types'

/**
 * "Is agent mode available?" probe for the home page.
 *
 * Shares the `GET /agent/agents` cache entry with `useAgentsQuery` and
 * projects it with `select` — it used to hold its own key, which meant the home
 * page and the chat header each paid for a separate (agent-glob + frontmatter
 * re-parse) request for identical data.
 */
export function useAgentStatusQuery() {
  return useQuery({
    ...agentRegistryQueryOptions(),
    // A missing/unavailable agent is an expected answer here, not a fault worth
    // retrying — the caller only needs to know whether agent mode exists.
    retry: false,
    staleTime: Infinity,
    select: (data): AgentStatusResponse | null => shapeAgentStatus(data),
  })
}
