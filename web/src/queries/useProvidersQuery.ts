import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import {
  installSeed,
  getProviderUsage,
  listProviderModels,
  listProviders,
  saveProvider,
  testProvider,
  type ProviderModelsResponse,
  type ProviderSaveRequest,
  type ProviderTestResponse,
} from '@/api/client'
import { queryKeys } from './keys'

export function useProvidersQuery() {
  return useQuery({
    queryKey: queryKeys.settings.providers(),
    queryFn: listProviders,
    staleTime: 30_000,
  })
}

export function useSaveProviderMutation() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: ({ providerId, body }: { providerId: string; body: ProviderSaveRequest }) =>
      saveProvider(providerId, body),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: queryKeys.settings.providers() })
      void client.invalidateQueries({ queryKey: queryKeys.agentFiles.registry() })
    },
  })
}

export function useProviderModelsMutation() {
  return useMutation<ProviderModelsResponse, Error, { providerId: string; apiKey?: string; extra?: Record<string, string> }>({
    mutationFn: ({ providerId, apiKey, extra }) =>
      listProviderModels(providerId, { api_key: apiKey, extra }),
  })
}

export function useProviderUsageQuery(providerId: string, enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.settings.providerUsage(providerId),
    queryFn: () => getProviderUsage(providerId),
    enabled,
    refetchInterval: enabled ? 60_000 : false,
    staleTime: 30_000,
  })
}

export function useTestProviderMutation() {
  return useMutation<ProviderTestResponse, Error, { providerId: string; apiKey?: string; model: string; extra?: Record<string, string> }>({
    mutationFn: ({ providerId, apiKey, model, extra }) =>
      testProvider(providerId, { api_key: apiKey, model, extra }),
  })
}

export function useInstallSeedMutation() {
  return useMutation({ mutationFn: installSeed })
}
