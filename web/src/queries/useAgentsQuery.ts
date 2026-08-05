import { useQuery } from '@tanstack/react-query'
import { teamAgentsQueryOptions } from './team-agents'

/** Team mode — GET /team/agents */
export function useTeamAgentsQuery(workspace?: string | null, enabled = true) {
  return useQuery({
    // Shared cache entry with useTeamStatusQuery, including its `staleTime`
    // baseline. See ``team-agents.ts``.
    ...teamAgentsQueryOptions(workspace),
    enabled,
  })
}
