/**
 * TanStack Query hooks for the canonical coding-agent file API.
 *
 * On mutation success, invalidates both the agent file cache (settings UI)
 * and the live /agent/agents cache so the agent chat header refreshes its
 * badges after a reload.
 */
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  getCodeAgent,
  updateCodeAgent,
  getRegistry,
  type ProvidersListBody,
} from '@/api/client'
import type { ModelCatalogEntry, RegistryResponse } from '@/api/types'
import { queryKeys } from './keys'

function placeholderRegistryFromProviders(data: ProvidersListBody | undefined): RegistryResponse | undefined {
  if (!data) return undefined

  const models: ModelCatalogEntry[] = []
  for (const provider of data.providers) {
    // Ignore visible selections for models the provider no longer lists: a
    // stale entry would whitelist nothing and hide every remaining model of
    // the provider while the real registry is loading.
    const cached = new Set(provider.cached_models)
    const visible = new Set(provider.visible_models.filter((m) => cached.has(m)))
    for (const model of provider.cached_models) {
      if (visible.size > 0 && !visible.has(model)) continue
      models.push({
        id: `${provider.id}:${model}`,
        provider: provider.id,
        model,
        vision: false,
        output_image: false,
        output_video: false,
        thinking_levels: [],
        summary_trigger_tokens: 0,
        fast_mode: provider.supports_fast_mode ?? false,
      })
    }
  }

  models.sort((a, b) => a.id.localeCompare(b.id))

  return {
    tools: [],
    skills: [],
    providers: data.providers.map((provider) => provider.id).sort(),
    models,
  }
}

/** Settings query for the canonical coding agent. */
export function useCodeAgentQuery() {
  return useQuery({
    queryKey: queryKeys.agentFiles.detail('code'),
    queryFn: getCodeAgent,
    staleTime: 10_000,
  })
}

export function useRegistryQuery() {
  const client = useQueryClient()
  return useQuery({
    queryKey: queryKeys.agentFiles.registry(),
    queryFn: getRegistry,
    placeholderData: () =>
      placeholderRegistryFromProviders(
        client.getQueryData<ProvidersListBody>(queryKeys.settings.providers()),
      ),
    staleTime: Infinity,
    gcTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  })
}

function invalidateAgentFiles(client: ReturnType<typeof useQueryClient>) {
  client.invalidateQueries({ queryKey: queryKeys.agentFiles.all() })
  client.invalidateQueries({ queryKey: queryKeys.agentFiles.registry() })
  // ``agents()`` is a prefix of ``agentRegistry(workspace)``, which is the single
  // shared /agent/agents entry (home-page probe + chat header) — no separate
  // status key to invalidate.
  client.invalidateQueries({ queryKey: queryKeys.agents() })
}

export function useUpdateAgentMutation() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: ({ content }: { content: string }) => updateCodeAgent(content),
    onSuccess: () => {
      invalidateAgentFiles(client)
      client.invalidateQueries({ queryKey: queryKeys.agentFiles.detail('code') })
    },
  })
}
