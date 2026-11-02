import { useCallback, useEffect, useRef } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import {
  addProviderCredential,
  deleteProviderCredential,
  disconnectOauthProvider,
  orderProviderCredentials,
  updateProviderCredential,
  disconnectProvider,
  getProviderUsage,
  listProviderModels,
  listProviders,
  saveProvider,
  saveProviderVisibleModels,
  testProvider,
  resetProviderUsage,
  type ProviderModelsResponse,
  type ProviderSaveRequest,
  type ProviderTestResponse,
  type ProviderUsageResponse,
  type ProvidersListBody,
} from '@/api/client'
import { ProviderUsageError, parseUsageResponse, toProviderUsageError } from '@/lib/provider-usage'
import { queryKeys } from './keys'
import { invalidateModelSetup } from './model-setup'
import { activeBlock, forgetProviderUsage, holdBlock, releaseBlock, seedLastGood } from './providerUsageCache'

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
    onSuccess: (data, variables) => {
      void client.invalidateQueries({ queryKey: queryKeys.settings.providers() })
      void client.invalidateQueries({ queryKey: queryKeys.settings.providerUsage(variables.providerId) })
      void client.invalidateQueries({ queryKey: queryKeys.agentFiles.registry() })
      // The first provider also gives agents without a model its suggested one.
      if (data.default_model) void invalidateModelSetup(client)
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

// ── Provider usage ───────────────────────────────────────────────────────────

const USAGE_POLL_MS = 60_000
const USAGE_STALE_MS = 30_000
/** Past the retry time by this much, so the probe never lands a hair early. */
const PROBE_SLACK_MS = 250
const MAX_TIMER_MS = 2 ** 31 - 1

/**
 * One account's (or, without `credentialId`, the provider's) usage.
 *
 * - No retry loops; one polite poll a minute, and none once the answer cannot
 *   change by asking again (unsupported, needs sign-in).
 * - While the provider says to wait, nothing reaches the daemon: not focus,
 *   not a manual refetch, not the poll. One probe is scheduled for when the
 *   wait ends. A sign-in that needs attention is the same until it is renewed.
 * - Only `refresh` (the Refresh button) asks the daemon to skip its cache.
 * - A failed refresh never erases numbers already held.
 */
export function useProviderUsageQuery(providerId: string, enabled: boolean, credentialId?: string) {
  const client = useQueryClient()
  const queryKey = queryKeys.settings.providerUsage(providerId, credentialId)
  const forceRef = useRef(false)
  /** Nothing in the background may ask again: blocked, or the provider has no usage at all. */
  const quiet = () => {
    if (activeBlock(client, queryKey)) return true
    const error = client.getQueryState<ProviderUsageResponse, unknown>(queryKey)?.error
    return error instanceof ProviderUsageError && error.kind === 'unsupported'
  }
  const query = useQuery<ProviderUsageResponse, ProviderUsageError>({
    queryKey,
    queryFn: async () => {
      // Read and clear first, so a press that is blocked below cannot leave force on for a later poll.
      const force = forceRef.current
      forceRef.current = false
      const held = activeBlock(client, queryKey)
      if (held) {
        // The cached reading may have been dropped while the block stayed: put the snapshot back.
        seedLastGood(client, queryKey, held)
        throw held
      }
      try {
        const data = parseUsageResponse(await getProviderUsage(providerId, credentialId, force))
        releaseBlock(client, queryKey)
        return data
      } catch (cause) {
        const error = toProviderUsageError(cause, Date.now(), { scoped: Boolean(credentialId) })
        if (error.kind === 'rate_limited' || error.kind === 'credentials') holdBlock(client, queryKey, error)
        seedLastGood(client, queryKey, error)
        throw error
      }
    },
    enabled,
    retry: false,
    staleTime: () => (activeBlock(client, queryKey) ? Infinity : USAGE_STALE_MS),
    refetchInterval: () => (!enabled || quiet() ? false : USAGE_POLL_MS),
    refetchOnWindowFocus: () => !quiet(),
    refetchOnReconnect: () => !quiet(),
  })

  const retryAt = query.error instanceof ProviderUsageError && query.error.kind === 'rate_limited' ? query.error.retryAtMs : null
  const { refetch } = query
  useEffect(() => {
    if (!enabled || retryAt === null) return undefined
    let timer: number | undefined
    // A wait longer than a timer can hold is slept in stretches, then probed once.
    const arm = () => {
      const wait = retryAt - Date.now() + PROBE_SLACK_MS
      if (wait <= 0) {
        void refetch({ cancelRefetch: false })
        return
      }
      timer = window.setTimeout(arm, Math.min(wait, MAX_TIMER_MS))
    }
    const first = retryAt - Date.now() + PROBE_SLACK_MS
    if (first <= 0) return undefined
    arm()
    return () => window.clearTimeout(timer)
  }, [enabled, retryAt, refetch])

  const refresh = useCallback(async () => {
    forceRef.current = true
    try {
      return await refetch()
    } finally {
      forceRef.current = false
    }
  }, [refetch])

  return { ...query, refresh }
}
export function useResetProviderUsageMutation() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: ({ providerId, credentialId }: { providerId: string; credentialId?: string }) => resetProviderUsage(providerId, credentialId),
    onSuccess: (data, { providerId, credentialId }) => {
      // Only the account that was reset: the other profiles' usage did not change.
      const key = queryKeys.settings.providerUsage(providerId, credentialId)
      client.setQueryData(key, parseUsageResponse(data))
      void client.invalidateQueries({ queryKey: key, exact: true })
      void client.invalidateQueries({ queryKey: queryKeys.settings.providers() })
    },
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
  const invalidate = useInvalidateProviderCredentials()
  const client = useQueryClient()
  return useMutation({
    mutationFn: ({ providerId, credentialId }: { providerId: string; credentialId?: string }) => disconnectOauthProvider(providerId, credentialId),
    onSuccess: (_data, { providerId, credentialId }) => {
      // The sign-in is gone: what was held for it describes nothing now.
      forgetProviderUsage(client, providerId, credentialId)
      invalidate(providerId, { usage: false })
    },
  })
}

/** Every credential change refreshes the provider list (it carries the
 *  credentials) and the model registry the agents read. `usage: false` for a
 *  change that does not alter any account's usage (rename, order, disable). */
function useInvalidateProviderCredentials() {
  const client = useQueryClient()
  return (providerId: string, options: { usage?: boolean } = {}) => {
    void client.invalidateQueries({ queryKey: queryKeys.settings.providers() })
    if (options.usage ?? true) void client.invalidateQueries({ queryKey: queryKeys.settings.providerUsage(providerId) })
    void client.invalidateQueries({ queryKey: queryKeys.agentFiles.registry() })
  }
}

export function useAddProviderCredentialMutation() {
  const invalidate = useInvalidateProviderCredentials()
  const client = useQueryClient()
  return useMutation({
    mutationFn: ({ providerId, label, apiKey, extra }: { providerId: string; label?: string; apiKey?: string; extra?: Record<string, string> }) =>
      addProviderCredential(providerId, { label, api_key: apiKey, extra }),
    onSuccess: (data, { providerId }) => {
      invalidate(providerId)
      if (data.default_model) void invalidateModelSetup(client)
    },
  })
}

export function useUpdateProviderCredentialMutation() {
  const invalidate = useInvalidateProviderCredentials()
  return useMutation({
    mutationFn: ({ providerId, credentialId, body }: { providerId: string; credentialId: string; body: { label?: string; disabled?: boolean } }) =>
      updateProviderCredential(providerId, credentialId, body),
    onSuccess: (_data, { providerId }) => invalidate(providerId, { usage: false }),
  })
}

export function useDeleteProviderCredentialMutation() {
  const invalidate = useInvalidateProviderCredentials()
  const client = useQueryClient()
  return useMutation({
    mutationFn: ({ providerId, credentialId }: { providerId: string; credentialId: string }) => deleteProviderCredential(providerId, credentialId),
    onSuccess: (_data, { providerId, credentialId }) => {
      forgetProviderUsage(client, providerId, credentialId)
      invalidate(providerId, { usage: false })
    },
  })
}

export function useOrderProviderCredentialsMutation() {
  const client = useQueryClient()
  const invalidate = useInvalidateProviderCredentials()
  return useMutation({
    mutationFn: ({ providerId, ids }: { providerId: string; ids: string[] }) => orderProviderCredentials(providerId, ids),
    onMutate: async ({ providerId, ids }) => {
      await client.cancelQueries({ queryKey: queryKeys.settings.providers() })
      const previous = client.getQueryData<ProvidersListBody>(queryKeys.settings.providers())
      client.setQueryData<ProvidersListBody>(queryKeys.settings.providers(), (current) => {
        if (!current) return current
        return {
          ...current,
          providers: current.providers.map((p) => {
            if (p.id !== providerId || !p.stored_credentials) return p
            const byId = new Map(p.stored_credentials.map((c) => [c.id, c]))
            return { ...p, stored_credentials: ids.map((id) => byId.get(id)).filter((c) => c !== undefined) }
          }),
        }
      })
      return { previous }
    },
    onError: (_error, _variables, context) => {
      if (context?.previous) client.setQueryData(queryKeys.settings.providers(), context.previous)
    },
    onSettled: (_data, _error, { providerId }) => invalidate(providerId, { usage: false }),
  })
}
