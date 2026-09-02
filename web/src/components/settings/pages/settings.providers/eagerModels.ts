import type { QueryClient } from '@tanstack/react-query'
import { listProviderModels, type ProvidersListBody } from '@/api/client'
import { queryKeys } from '@/queries'

export async function eagerlyWarmProviderModels(
  providers: ProvidersListBody['providers'],
  queryClient: QueryClient,
) {
  const pending = providers.filter((provider) =>
    provider.is_configured &&
    !provider.is_disconnected &&
    !queryClient.getQueryData(queryKeys.settings.providerModels(provider.id)),
  )
  if (pending.length === 0) return

  await Promise.allSettled(pending.map(async (provider) => {
    const listed = await listProviderModels(provider.id, {})
    queryClient.setQueryData(queryKeys.settings.providerModels(provider.id), listed)
    queryClient.setQueryData<ProvidersListBody>(queryKeys.settings.providers(), (current) => {
      if (!current) return current
      return {
        ...current,
        providers: current.providers.map((item) =>
          item.id === provider.id
            ? { ...item, cached_models: listed.models, model_costs: listed.model_costs }
            : item,
        ),
      }
    })
  }))
  void queryClient.invalidateQueries({ queryKey: queryKeys.agentFiles.registry() })
}
