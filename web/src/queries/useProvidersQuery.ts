import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import {
  disconnectOauthProvider,
  disconnectProvider,
  getProviderUsage,
  listProviderModels,
  listProviders,
  saveProvider,
  saveProviderVisibleModels,
  testProvider,
  type ProviderModelsResponse,
  type ProviderSaveRequest,
  type ProviderTestResponse,
  type ProvidersListBody,
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
    onSuccess: (_data, variables) => {
      void client.invalidateQueries({ queryKey: queryKeys.settings.providers() })
      void client.invalidateQueries({ queryKey: queryKeys.settings.providerUsage(variables.providerId) })
      void client.invalidateQueries({ queryKey: queryKeys.agentFiles.registry() })
    },
  })
}

export function useSaveProviderVisibleModelsMutation() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: ({ providerId, models }: { providerId: string; models: string[] }) =>
      saveProviderVisibleModels(providerId, models),
    onMutate: async ({ providerId, models }) => {
      await client.cancelQueries({ queryKey: queryKeys.settings.providers() })
      const previous = client.getQueryData<ProvidersListBody>(queryKeys.settings.providers())
      client.setQueryData<ProvidersListBody>(queryKeys.settings.providers(), (current) => {
        if (!current) return current
        return {
          ...current,
          providers: current.providers.map((provider) =>
            provider.id === providerId ? { ...provider, visible_models: models } : provider,
          ),
        }
      })
      return { previous }
    },
    onError: (_error, _variables, context) => {
      if (context?.previous) client.setQueryData(queryKeys.settings.providers(), context.previous)
    },
    onSettled: () => {
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

export function useProviderUsageQuery(providerId: string, enabled: boolean, apiKey?: string) {
  return useQuery({
    queryKey: queryKeys.settings.providerUsage(providerId),
    queryFn: () => getProviderUsage(providerId, apiKey),
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

export function useDisconnectProviderMutation() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: ({ providerId, disconnected }: { providerId: string; disconnected: boolean }) =>
      disconnectProvider(providerId, disconnected),
    onMutate: async ({ providerId, disconnected }) => {
      await client.cancelQueries({ queryKey: queryKeys.settings.providers() })
      const previous = client.getQueryData<ProvidersListBody>(queryKeys.settings.providers())
      client.setQueryData<ProvidersListBody>(queryKeys.settings.providers(), (current) => {
        if (!current) return current
        return {
          ...current,
          providers: current.providers.map((p) =>
            p.id === providerId ? { ...p, is_disconnected: disconnected } : p,
          ),
        }
      })
      return { previous }
    },
    onError: (_error, _variables, context) => {
      if (context?.previous) client.setQueryData(queryKeys.settings.providers(), context.previous)
    },
    onSettled: () => {
      void client.invalidateQueries({ queryKey: queryKeys.settings.providers() })
      void client.invalidateQueries({ queryKey: queryKeys.agentFiles.registry() })
    },
  })
}

export function useDisconnectOauthProviderMutation() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (providerId: string) => disconnectOauthProvider(providerId),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: queryKeys.settings.providers() })
      void client.invalidateQueries({ queryKey: queryKeys.agentFiles.registry() })
    },
  })
}
