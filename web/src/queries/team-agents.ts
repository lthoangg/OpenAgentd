/**
 * Shared query options for `GET /team/agents`.
 *
 * That endpoint is not cheap: on every request the backend runs
 * `refresh_blueprints()` (glob every agent `*.md` and re-parse its frontmatter)
 * and `refresh_idle_agents()` (per-agent config-drift check), so its cost scales
 * with the number of configured agents. It therefore needs exactly one cache
 * entry per workspace, shared by every consumer.
 *
 * Consumers: the chat header capabilities panel (`useTeamAgentsQuery`), the home
 * page's "is team mode available" probe (`useTeamStatusQuery`, which derives its
 * own shape via `select` off this same entry), and the team store's
 * `loadTeamStatus()`.
 *
 * The store deliberately holds no TanStack imports, so it calls the plain
 * `listTeamAgents()` client function instead of reading this cache. Those two
 * paths fire in the same window when a session opens (`loadSession()` →
 * `loadTeamStatus()` while the header mounts), which is why `listTeamAgents()`
 * coalesces concurrent in-flight requests — see `api/client/team.ts`.
 */
import { listTeamAgents } from '@/api/client'
import type { TeamAgentsResponse } from '@/api/types'
import { queryKeys } from './keys'

export const TEAM_AGENTS_STALE_MS = 30_000

export function teamAgentsQueryOptions(workspace?: string | null, sessionId?: string | null) {
  return {
    queryKey: [...queryKeys.teamAgents(workspace), sessionId ?? ''],
    queryFn: (): Promise<TeamAgentsResponse> => {
      if (!workspace) throw new Error('Coding workspace is required')
      return listTeamAgents(workspace, sessionId)
    },
    // Baseline freshness policy lives here so every consumer of this shared
    // entry inherits it. `staleTime` is per-observer in TanStack Query, so a
    // consumer that spreads these options and omits it used to silently fall
    // back to the global 5-minute default instead of this endpoint's own
    // budget. Consumers may still override deliberately after the spread —
    // `useTeamStatusQuery` pins `Infinity` because "does team mode exist" is
    // effectively immutable for the process lifetime.
    staleTime: TEAM_AGENTS_STALE_MS,
  }
}
