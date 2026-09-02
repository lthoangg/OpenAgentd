import { useQuery } from '@tanstack/react-query'
import { agentRegistryQueryOptions } from './agent-registry'

/** Agent metadata — GET /agent/agents */
export function useAgentsQuery(workspace?: string | null, enabled = true) {
  return useQuery({
    // Shared cache entry with useAgentStatusQuery, including its `staleTime`
    // baseline. See ``agent-registry.ts``.
    ...agentRegistryQueryOptions(workspace),
    enabled,
  })
}
