import type { QueryClient } from '@tanstack/react-query'
import { getCodingWorkspaceTree, listProviders, listTeamSessions } from '@/api/client'
import { queryKeys } from '@/queries/keys'
import { teamAgentsQueryOptions } from '@/queries/team-agents'
import { preloadHeavyRenderers } from '@/lib/optimistic-preload'

const SESSION_PAGE_SIZE = 20

/** Warm data needed by the coding workspace entry surface. */
export function preloadConnectedApp(client: QueryClient): void {
  // Warm heavy rendering chunks (markdown, mermaid, pdfjs) during idle time.
  preloadHeavyRenderers()

  // Warms the single /session/agents entry read by both the home-page team probe
  // and the chat header. See ``queries/team-agents.ts``.
  void client.prefetchQuery({
    ...teamAgentsQueryOptions(),
    staleTime: Infinity,
  })
  void client.prefetchQuery({
    queryKey: queryKeys.settings.providers(),
    queryFn: listProviders,
    staleTime: 30_000,
  })
  void client.prefetchQuery({
    queryKey: queryKeys.coding.tree(),
    queryFn: getCodingWorkspaceTree,
    staleTime: 30_000,
  })
  void client.prefetchInfiniteQuery({
    queryKey: queryKeys.team.sessions.workspace('__all_coding__'),
    queryFn: ({ pageParam }: { pageParam: string | null }) =>
      listTeamSessions(pageParam, SESSION_PAGE_SIZE),
    initialPageParam: null as string | null,
  })
}
