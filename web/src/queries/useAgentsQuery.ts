import { useQuery } from '@tanstack/react-query'
import { TEAM_AGENTS_STALE_MS, teamAgentsQueryOptions } from './team-agents'

/** Team mode — GET /team/agents */
export function useTeamAgentsQuery(workspace?: string | null, enabled = true) {
  return useQuery({
    // Shared cache entry with useTeamStatusQuery. See ``team-agents.ts``.
    ...teamAgentsQueryOptions(workspace),
    enabled,
    staleTime: TEAM_AGENTS_STALE_MS,
  })
}
