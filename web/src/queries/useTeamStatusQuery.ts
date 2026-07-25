import { useQuery } from '@tanstack/react-query'
import { shapeTeamStatus } from '@/api/client'
import { teamAgentsQueryOptions } from './team-agents'
import type { TeamStatusResponse } from '@/api/types'

/**
 * "Is team mode available?" probe for the home page.
 *
 * Shares the `GET /team/agents` cache entry with `useTeamAgentsQuery` and
 * projects it with `select` — it used to hold its own key, which meant the home
 * page and the chat header each paid for a separate (agent-glob + frontmatter
 * re-parse) request for identical data.
 */
export function useTeamStatusQuery() {
  return useQuery({
    ...teamAgentsQueryOptions(),
    // A missing/unavailable team is an expected answer here, not a fault worth
    // retrying — the caller only needs to know whether team mode exists.
    retry: false,
    staleTime: Infinity,
    select: (data): TeamStatusResponse | null => shapeTeamStatus(data),
  })
}
