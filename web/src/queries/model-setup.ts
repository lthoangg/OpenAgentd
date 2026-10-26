import type { QueryClient } from '@tanstack/react-query'
import { queryKeys } from './keys'

/**
 * Refetch what connecting a provider or setting the default model changes:
 * the providers list, every workspace's agent registry (the lead's model),
 * and the agent files.
 */
export function invalidateModelSetup(queryClient: QueryClient): Promise<unknown> {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: queryKeys.settings.providers() }),
    queryClient.invalidateQueries({ queryKey: queryKeys.agents() }),
    queryClient.invalidateQueries({ queryKey: queryKeys.agentFiles.registry() }),
  ])
}
