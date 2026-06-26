import { useEffect } from 'react'
import { KeyRound, Loader2 } from 'lucide-react'
import { useQueryClient } from '@tanstack/react-query'

import { listProviderModels, type ProvidersListBody } from '@/api/client'
import { queryKeys, useProvidersQuery } from '@/queries'
import { ProviderCard } from './settings.providers/ProviderCard'

export function ProvidersSettingsPage() {
  const providersQ = useProvidersQuery()
  const queryClient = useQueryClient()
  // Render in catalog order so the list is stable regardless of which
  // providers happen to be configured. Sorting by ``is_configured`` would
  // bump a provider to the top the moment its key is saved, which makes
  // the page feel like it's rearranging itself under the user.
  const providers = providersQ.data?.providers ?? []
  const connectedCount = providers.filter((provider) => provider.is_configured).length

  useEffect(() => {
    if (!providersQ.data) return
    for (const provider of providersQ.data.providers) {
      if (!provider.is_configured) continue
      void listProviderModels(provider.id, {}).then((listed) => {
        queryClient.setQueryData(queryKeys.settings.providerModels(provider.id), listed)
        queryClient.setQueryData<ProvidersListBody>(queryKeys.settings.providers(), (current) => {
          if (!current) return current
          return {
            ...current,
            providers: current.providers.map((item) =>
              item.id === provider.id ? { ...item, cached_models: listed.models } : item,
            ),
          }
        })
        void queryClient.invalidateQueries({ queryKey: queryKeys.agentFiles.registry() })
      }).catch(() => {})
    }
  }, [providersQ.data, queryClient])

  return (
    <>
      <header className="sticky top-0 z-10 flex h-14 shrink-0 items-center gap-3 border-b border-(--color-border) bg-(--bg-page) px-4">
        <KeyRound size={15} className="shrink-0 text-(--color-text-muted)" aria-hidden="true" />
        <h1 className="flex-1 truncate text-sm font-semibold text-(--color-text)">Providers</h1>
        <span className="text-xs text-(--color-text-muted)">{connectedCount} connected</span>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl space-y-5 p-6">
          <p className="text-sm leading-relaxed text-(--color-text-muted)">
            Add the model provider OpenAgentd should use. API keys are written to your local config; OAuth tokens are stored in your local cache. Click <span className="font-medium">List models</span> to verify a key before saving.
          </p>

          {providersQ.isLoading ? (
            <div className="flex items-center gap-2 text-sm text-(--color-text-muted)">
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              Loading providers…
            </div>
          ) : providersQ.error ? (
            <div className="rounded-lg border border-(--color-error)/30 bg-(--color-error)/10 p-4 text-sm text-(--color-error)">
              {providersQ.error instanceof Error ? providersQ.error.message : String(providersQ.error)}
            </div>
          ) : (
            <div className="grid gap-3">
              {providers.map((provider) => (
                <ProviderCard key={provider.id} provider={provider} />
              ))}
            </div>
          )}
        </div>
      </div>
    </>
  )
}
