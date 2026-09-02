/**
 * Shared query options for `GET /agent/agents`.
 *
 * That endpoint is not cheap: on every request the backend runs
 * refreshes the single agent metadata cache after configuration changes.
 * and `refresh_idle_agents()` (per-agent config-drift check), so its cost scales
 * with the number of configured agents. It therefore needs exactly one cache
 * entry per workspace, shared by every consumer.
 *
 * Consumers: the chat header capabilities panel (`useAgentsQuery`), the home
 * page's "is agent mode available" probe (`useAgentStatusQuery`, which derives its
 * own shape via `select` off this same entry), and the agent store's
 * `loadAgentStatus()`.
 *
 * The store deliberately holds no TanStack imports, so it calls the plain
 * `listSessionAgents()` client function instead of reading this cache. Those two
 * paths fire in the same window when a session opens (`loadSession()` →
 * `loadAgentStatus()` while the header mounts), which is why `listSessionAgents()`
 * coalesces concurrent in-flight requests — see `api/client/agent.ts`.
 */
import { listSessionAgents } from '@/api/client'
import type { AgentRegistryResponse } from '@/api/types'
import { queryKeys } from './keys'

export const AGENT_REGISTRY_STALE_MS = 30_000

export function agentRegistryQueryOptions(workspace?: string | null, sessionId?: string | null) {
  return {
    queryKey: [...queryKeys.agentRegistry(workspace), sessionId ?? ''],
    queryFn: (): Promise<AgentRegistryResponse> => {
      if (!workspace) throw new Error('Coding workspace is required')
      return listSessionAgents(workspace, sessionId)
    },
    // Baseline freshness policy lives here so every consumer of this shared
    // entry inherits it. `staleTime` is per-observer in TanStack Query, so a
    // consumer that spreads these options and omits it used to silently fall
    // back to the global 5-minute default instead of this endpoint's own
    // budget. Consumers may still override deliberately after the spread —
    // `useAgentStatusQuery` pins `Infinity` because "does agent mode exist" is
    // effectively immutable for the process lifetime.
    staleTime: AGENT_REGISTRY_STALE_MS,
  }
}
