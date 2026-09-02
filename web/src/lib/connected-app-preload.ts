import type { QueryClient } from '@tanstack/react-query'
import { getCodingWorkspaceTree, listProviders, listSessions } from '@/api/client'
import { queryKeys } from '@/queries/keys'
import { agentRegistryQueryOptions } from '@/queries/agent-registry'
import { preloadHeavyRenderers } from '@/lib/optimistic-preload'

const SESSION_PAGE_SIZE = 20

/** Warm data needed by the coding workspace entry surface. */
export function preloadConnectedApp(client: QueryClient): void {
  // Warm heavy rendering chunks (markdown, mermaid, pdfjs) during idle time.
  preloadHeavyRenderers()

  // Warms the single /agent/agents entry read by both the home-page agent probe
  // and the chat header. See ``queries/agent-registry.ts``.
  void client.prefetchQuery({
    ...agentRegistryQueryOptions(),
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
    queryKey: queryKeys.session.sessions.workspace('__all_coding__'),
    queryFn: ({ pageParam }: { pageParam: string | null }) =>
      listSessions(pageParam, SESSION_PAGE_SIZE),
    initialPageParam: null as string | null,
  })
}
