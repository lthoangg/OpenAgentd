import { useEffect } from 'react'
import { KeyRound, Loader2 } from 'lucide-react'
import { useQueryClient } from '@tanstack/react-query'

import { listProviderModels, type ProvidersListBody } from '@/api/client'
import { queryKeys, useProvidersQuery } from '@/queries'
import { ProviderCard } from './settings.providers/ProviderCard'

export function ProvidersSettingsPage() {
  const providersQ = useProvidersQuery()
  const queryClient = useQueryClient()
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
      <header className="sticky top-0 z-10 flex h-11 shrink-0 items-center gap-2 border-b border-(--color-border) bg-(--bg-page) px-4 select-none">
        <KeyRound size={13} className="shrink-0 text-(--color-text-muted)" aria-hidden="true" />
        <h1 className="flex-1 truncate text-xs font-semibold text-(--color-text)">Providers</h1>
        <span className="text-[10px] text-(--color-text-subtle) font-medium">{connectedCount} connected</span>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto bg-(--bg-page)">
        <div className="mx-auto max-w-3xl space-y-4 p-5">
          <p className="text-xs leading-relaxed text-(--color-text-muted)">
            Add the model provider OpenAgentd should use. API keys are written to your local config; OAuth tokens are stored in your local cache. Click <span className="font-medium">List models</span> to verify a key before saving.
          </p>

          <section className="space-y-3.5">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-(--color-text-muted) border-b border-(--color-border)/60 pb-1.5 mb-3">
              Model Providers
            </h2>

            {providersQ.isLoading ? (
              <div className="flex items-center gap-2 text-xs text-(--color-text-muted) font-mono">
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                Loading providers…
              </div>
            ) : providersQ.error ? (
              <div className="rounded-md border border-(--color-error)/25 bg-(--color-error-subtle) p-3 text-xs text-(--color-error)">
                {providersQ.error instanceof Error ? providersQ.error.message : String(providersQ.error)}
              </div>
            ) : (
              <div className="grid gap-3">
                {providers.map((provider) => (
                  <ProviderCard key={provider.id} provider={provider} />
                ))}
              </div>
            )}
          </section>
        </div>
      </div>
    </>
  )
}
