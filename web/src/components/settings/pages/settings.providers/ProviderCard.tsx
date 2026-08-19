import { useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertCircle, CheckCircle2, ExternalLink, Loader2, ShieldCheck, WifiOff } from 'lucide-react'

import { ApiValidationError, type ProviderInfo, type ProvidersListBody } from '@/api/client'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { SectionCard, SectionCardHeader } from '@/components/ui/section-card'
import { queryKeys, useDisconnectOauthProviderMutation, useDisconnectProviderMutation, useProviderModelsMutation, useProviderUsageQuery, useSaveProviderMutation, useSaveProviderVisibleModelsMutation } from '@/queries'
import { openExternalUrl } from '@/lib/open-external'
import { useToastStore } from '@/stores/useToastStore'
import { DAEMON_BASE_URL, providerKindLabel } from './providerUtils'
import { UsagePanel } from './UsagePanel'
import { ModelsPanel } from './ModelsPanel'
import { OAuthLoginDialog } from './OAuthLoginDialog'

export function ProviderCard({ provider }: { provider: ProviderInfo }) {
  const [apiKey, setApiKey] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [cloudValues, setCloudValues] = useState<Record<string, string>>({})
  const [verifiedKey, setVerifiedKey] = useState('')
  const [verifiedCloudSignature, setVerifiedCloudSignature] = useState('')
  const [hasReachabilityFailure, setHasReachabilityFailure] = useState(false)
  const [oauthOpen, setOauthOpen] = useState(false)
  const [modelsExpanded, setModelsExpanded] = useState(false)
  const [modelSearch, setModelSearch] = useState('')
  const modelsMutation = useProviderModelsMutation()
  const saveMutation = useSaveProviderMutation()
  const saveVisibleModelsMutation = useSaveProviderVisibleModelsMutation()
  const disconnectMutation = useDisconnectProviderMutation()
  const disconnectOauthMutation = useDisconnectOauthProviderMutation()
  const push = useToastStore((s) => s.push)
  const queryClient = useQueryClient()

  const trimmedKey = apiKey.trim()
  const trimmedBaseUrl = baseUrl.trim()
  const primaryCredential = provider.credentials[0]
  const cloudExtra = useMemo<Record<string, string>>(() => {
    const out: Record<string, string> = {}
    for (const credential of provider.credentials) {
      out[credential.name] = (cloudValues[credential.name] ?? provider.saved_credentials[credential.name] ?? '').trim()
    }
    return out
  }, [cloudValues, provider.credentials, provider.saved_credentials])
  const cloudSignature = useMemo(() => JSON.stringify(cloudExtra), [cloudExtra])
  const hasCloudCandidate = Object.values(cloudExtra).some((value) => value.length > 0)
  const hasCandidateKey = trimmedKey.length > 0
  // Credentials already stored on the daemon: listing models re-uses them
  // server-side, so a refresh must not require retyping a secret the UI
  // never echoes back. `is_saved` alone is enough — a stored key that
  // stopped working is exactly the case where a retry is wanted.
  const hasSavedCredentials = provider.is_saved || provider.is_configured
  const hasVerifiedKey = verifiedKey === trimmedKey && hasCandidateKey
  const hasVerifiedCloud = verifiedCloudSignature === cloudSignature && hasCloudCandidate
  const canSave =
    ((provider.kind === 'api_key' || provider.kind === 'oauth') && hasVerifiedKey) ||
    (provider.kind === 'cloud_creds' && hasVerifiedCloud)

  const daemon = DAEMON_BASE_URL[provider.id]
  const extraForRequest = useMemo<Record<string, string> | undefined>(() => {
    if (!daemon || !trimmedBaseUrl) return undefined
    return { [daemon.var]: trimmedBaseUrl }
  }, [daemon, trimmedBaseUrl])

  const autoFetchEnabled = false

  const autoModelsQ = useQuery({
    queryKey: queryKeys.settings.providerModels(provider.id),
    queryFn: async () => ({ provider: provider.id, models: provider.cached_models, source: 'provider' as const }),
    enabled: autoFetchEnabled,
    staleTime: 60_000,
  })
  const usageQ = useProviderUsageQuery(
    provider.id,
    provider.kind === 'oauth' && provider.is_configured,
  )

  const models = useMemo<string[]>(() => {
    if (!provider.is_configured && !hasCandidateKey) {
      return provider.cached_models ?? []
    }
    return autoModelsQ.data?.models ?? provider.cached_models ?? []
  }, [autoModelsQ.data?.models, hasCandidateKey, provider.cached_models, provider.is_configured])

  const handleListModels = async () => {
    const extra = provider.kind === 'cloud_creds' ? cloudExtra : extraForRequest
    try {
      const listed = await modelsMutation.mutateAsync({
        providerId: provider.id,
        apiKey: trimmedKey,
        extra,
      })
      queryClient.setQueryData(queryKeys.settings.providerModels(provider.id), listed)
      // Mirror the daemon's own cache write, which only happens when the
      // request carried no candidate credentials (see `list_provider_models`).
      // Without this the card keeps rendering `cached_models` from the last
      // providers fetch and a refresh looks like it did nothing.
      if (!hasCandidateKey && !extra) {
        queryClient.setQueryData<ProvidersListBody>(queryKeys.settings.providers(), (current) => {
          if (!current) return current
          return {
            ...current,
            providers: current.providers.map((item) =>
              item.id === provider.id ? { ...item, cached_models: listed.models } : item,
            ),
          }
        })
      }
      const reachedProvider = listed.source === 'provider' && listed.models.length > 0
      setHasReachabilityFailure(!reachedProvider)
      if (reachedProvider) {
        setVerifiedKey(trimmedKey)
        if (provider.kind === 'cloud_creds') setVerifiedCloudSignature(cloudSignature)
        setModelsExpanded(true)
        push({
          tone: 'success',
          title: 'Connection verified',
          description: `${listed.models.length} models available.`,
        })
      } else {
        push({
          tone: 'error',
          title: 'Failed',
          description: 'Provider is unreachable.',
        })
      }
    } catch (err) {
      setHasReachabilityFailure(true)
      push({
        tone: 'error',
        title: 'Could not list models',
        description: err instanceof Error ? err.message : String(err),
      })
    }
  }

  const handleSave = async () => {
    try {
      const extraForSave =
        provider.kind === 'cloud_creds'
          ? cloudExtra
          : daemon !== undefined ? { [daemon.var]: trimmedBaseUrl } : undefined
      await saveMutation.mutateAsync({
        providerId: provider.id,
        body: { api_key: provider.kind === 'cloud_creds' ? '' : trimmedKey, extra: extraForSave },
      })
      setApiKey('')
      setVerifiedKey('')
      setVerifiedCloudSignature('')
      push({
        tone: 'success',
        title: 'Provider saved',
        description: provider.label,
      })
    } catch (err) {
      push({
        tone: 'error',
        title: 'Could not save provider',
        description: err instanceof Error ? err.message : String(err),
      })
    }
  }

  const handleSaveVisibleModels = async (models: string[]) => {
    try {
      await saveVisibleModelsMutation.mutateAsync({ providerId: provider.id, models })
    } catch (err) {
      push({
        tone: 'error',
        title: 'Could not save visible models',
        description: err instanceof Error ? err.message : String(err),
      })
    }
  }

  const handleDisconnect = async (disconnected: boolean) => {
    try {
      await disconnectMutation.mutateAsync({ providerId: provider.id, disconnected })
      push({
        tone: 'success',
        title: disconnected ? 'Provider hidden' : 'Provider visible',
        description: provider.label,
      })
    } catch (err) {
      push({
        tone: 'error',
        title: disconnected ? 'Could not hide provider' : 'Could not show provider',
        description: err instanceof Error ? err.message : String(err),
      })
    }
  }

  const handleOauthDisconnect = async () => {
    try {
      await disconnectOauthMutation.mutateAsync(provider.id)
      push({
        tone: 'success',
        title: 'OAuth account disconnected',
        description: provider.label,
      })
    } catch (err) {
      push({
        tone: 'error',
        title: 'Could not disconnect OAuth account',
        description: err instanceof Error ? err.message : String(err),
      })
    }
  }

  const listing = modelsMutation.isPending || autoModelsQ.isFetching
  const isConnected = provider.is_configured || (provider.kind === 'oauth' && provider.is_saved)
  const isConfiguredButUnreachable =
    hasReachabilityFailure || (provider.kind !== 'oauth' && (provider.is_reachable === false || (provider.is_saved && !provider.is_configured)))

  return (
    <SectionCard className="group">
      {/* ── Header ──────────────────────────────────────────────────── */}
      <SectionCardHeader className="flex flex-wrap items-center gap-2 py-2 normal-case tracking-normal">
        <p className="min-w-0 flex-1 basis-32 truncate text-xs font-semibold text-(--color-text)">{provider.label}</p>

        <div className="hidden flex-1 sm:block" />

        <span className="rounded-xs border border-(--color-border) bg-(--bg-key) px-1.5 py-0.5 text-[9px] font-semibold text-(--color-text-muted)">
          {providerKindLabel(provider.kind)}
        </span>

        {isConfiguredButUnreachable ? (
          <span className="inline-flex items-center gap-1 rounded-xs bg-(--color-error-subtle) px-1.5 py-0.5 text-[9px] font-semibold text-(--color-error) border border-(--color-error)/15">
            <AlertCircle size={10} aria-hidden="true" />
            Failed
          </span>
        ) : provider.is_disconnected ? (
          <span className="inline-flex items-center gap-1 rounded-xs bg-(--bg-key) px-1.5 py-0.5 text-[9px] font-semibold text-(--color-text-muted) border border-(--color-border)">
            <WifiOff size={10} aria-hidden="true" />
            Hidden
          </span>
        ) : isConnected ? (
          <span className="inline-flex items-center gap-1 rounded-xs bg-(--color-success-subtle) px-1.5 py-0.5 text-[9px] font-semibold text-(--color-success) border border-(--color-success)/15">
            <CheckCircle2 size={10} aria-hidden="true" />
            Connected
          </span>
        ) : null}

        {(isConnected || isConfiguredButUnreachable) && (
          <Button
            type="button"
            size="xs"
            variant="ghost"
            onClick={() => void handleDisconnect(!provider.is_disconnected)}
            disabled={disconnectMutation.isPending}
          >
            {disconnectMutation.isPending
              ? <Loader2 size={10.5} className="animate-spin" aria-hidden="true" />
              : provider.is_disconnected ? 'Show' : 'Hide'
            }
          </Button>
        )}

        {provider.docs_url && (
          <Button
            type="button"
            size="xs"
            variant="ghost"
            onClick={() => void openExternalUrl(provider.docs_url)}
          >
            Docs <ExternalLink size={10.5} aria-hidden="true" className="ml-1" />
          </Button>
        )}
      </SectionCardHeader>

      <div className="space-y-3 px-3 py-3">

      <p className="text-xs text-(--color-text-muted) leading-relaxed">{provider.description}</p>

      {/* ── API-key controls ─────────────────────────────────────────── */}
      {provider.kind === 'api_key' && (
        <div className="space-y-2 pt-1">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-[minmax(220px,1fr)_auto_auto] sm:items-center">
            <label className="col-span-2 min-w-0 sm:col-span-1">
              <span className="sr-only">{primaryCredential?.label || provider.env_var}</span>
              <Input
                type="password"
                value={apiKey}
                onChange={(event) => {
                  setApiKey(event.target.value)
                  setVerifiedKey('')
                }}
                placeholder={primaryCredential?.placeholder || (provider.is_configured ? 'Enter a new key to replace current key' : 'Paste API key')}
                autoComplete="off"
                className="font-mono text-xs"
              />
            </label>
            <Button
              type="button"
              size="sm"
              variant="default"
              className="w-full sm:w-auto"
              onClick={handleListModels}
              disabled={(!hasCandidateKey && !hasSavedCredentials && !provider.public_access) || listing}
            >
              {listing && <Loader2 className="h-3 w-3 animate-spin mr-1.5" aria-hidden="true" />}
              List models
            </Button>
            <Button
              type="button"
              size="sm"
              className="w-full sm:w-auto"
              onClick={handleSave}
              disabled={!canSave || saveMutation.isPending}
            >
              {saveMutation.isPending && <Loader2 className="h-3 w-3 animate-spin mr-1.5" aria-hidden="true" />}
              Save
            </Button>
          </div>
          {daemon && (
            <label className="block">
              <span className="text-[10.5px] font-medium text-(--color-text-muted)">Base URL (optional)</span>
              <Input
                type="url"
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                placeholder={daemon.placeholder}
                autoComplete="off"
                className="mt-1 font-mono text-xs"
                spellCheck={false}
              />
            </label>
          )}
          {hasCandidateKey && !hasVerifiedKey && (
            <p className="text-[10.5px] text-(--color-text-subtle) leading-normal">
              Click <span className="font-medium text-(--color-text)">List models</span> to verify this key before saving.
            </p>
          )}
          {!hasCandidateKey && provider.public_access && !provider.is_configured && (
            <p className="text-[10.5px] text-(--color-text-subtle) leading-normal">
              Free models are available without an API key. Add a key to use paid models.
            </p>
          )}
          {!hasCandidateKey && provider.is_configured && (
            <p className="text-[10.5px] text-(--color-text-subtle) leading-normal">
              Key saved. Type a new one above only if you want to replace it.
            </p>
          )}
        </div>
      )}

      {/* ── OAuth providers ──────────────────────────────────────────── */}
      {provider.kind === 'oauth' && (
        <div className="grid grid-cols-2 gap-2 pt-1 sm:flex sm:items-center sm:justify-end">
          <Button
            type="button"
            size="sm"
            variant="default"
            className="w-full sm:w-auto"
            onClick={handleListModels}
            disabled={!hasSavedCredentials || listing}
          >
            {listing && <Loader2 className="h-3 w-3 animate-spin mr-1.5" aria-hidden="true" />}
            List models
          </Button>
          {hasSavedCredentials ? (
            <>
              <Button
                type="button"
                size="sm"
                className="w-full sm:w-auto"
                onClick={() => setOauthOpen(true)}
              >
                <ShieldCheck size={12} aria-hidden="true" className="mr-1.5" />
                Reconnect
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="w-full sm:w-auto text-(--color-error) hover:text-(--color-error)"
                onClick={() => void handleOauthDisconnect()}
                disabled={disconnectOauthMutation.isPending}
              >
                {disconnectOauthMutation.isPending ? (
                  <Loader2 className="h-3 w-3 animate-spin mr-1.5" aria-hidden="true" />
                ) : null}
                Disconnect
              </Button>
            </>
          ) : (
            <Button
              type="button"
              size="sm"
              className="w-full sm:w-auto"
              onClick={() => setOauthOpen(true)}
            >
              <ShieldCheck size={12} aria-hidden="true" className="mr-1.5" />
              Connect
            </Button>
          )}
        </div>
      )}

      {provider.kind === 'oauth' && provider.is_configured && (
        <div className="space-y-2 pt-1">
          {usageQ.isLoading ? (
            <p className="inline-flex items-center gap-1 text-[11px] text-(--color-text-subtle) font-mono">
              <Loader2 className="h-3 w-3 animate-spin mr-1" aria-hidden="true" />
              Loading active usage…
            </p>
          ) : usageQ.data ? (
            <UsagePanel limits={usageQ.data.limits} updatedAt={usageQ.dataUpdatedAt} />
          ) : usageQ.isError ? (
            <p className="text-[11px] text-(--color-text-subtle) font-mono">
              {usageQ.error instanceof ApiValidationError && usageQ.error.status === 404
                ? 'Usage monitoring is not supported for this OAuth provider yet.'
                : 'Usage monitor unavailable right now.'}
            </p>
          ) : null}
        </div>
      )}

      {/* ── Local daemon (Ollama) — optional base URL only ─────────── */}
      {provider.kind === 'local' && daemon && (
        <div className="space-y-2 pt-1">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-[minmax(220px,1fr)_auto_auto] sm:items-center">
            <label className="col-span-2 min-w-0 sm:col-span-1">
              <span className="sr-only">{daemon.var}</span>
              <Input
                type="url"
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                placeholder={daemon.placeholder}
                autoComplete="off"
                className="font-mono text-xs"
                spellCheck={false}
              />
            </label>
            <Button
              type="button"
              size="sm"
              variant="default"
              className="w-full sm:w-auto"
              onClick={handleListModels}
              disabled={listing}
            >
              {listing && <Loader2 className="h-3 w-3 animate-spin mr-1.5" aria-hidden="true" />}
              List models
            </Button>
            <Button
              type="button"
              size="sm"
              className="w-full sm:w-auto"
              onClick={handleSave}
              disabled={saveMutation.isPending}
            >
              {saveMutation.isPending && <Loader2 className="h-3 w-3 animate-spin mr-1.5" aria-hidden="true" />}
              Save
            </Button>
          </div>
          <p className="text-[10.5px] text-(--color-text-subtle) leading-normal">
            Leave blank to use the default daemon at <span className="font-mono text-(--color-text)">{daemon.placeholder}</span>.
          </p>
        </div>
      )}

      {/* ── Cloud credential providers (Bedrock, Vertex AI) ─────────── */}
      {provider.kind === 'cloud_creds' && (
        <div className="space-y-2 pt-1">
          <div className="grid gap-2 sm:grid-cols-2">
            {provider.credentials.map((credential) => (
              <label key={credential.name} className="block">
                <span className="text-[10.5px] font-medium text-(--color-text-muted)">{credential.label}</span>
                <Input
                  type={credential.secret ? 'password' : 'text'}
                  value={cloudValues[credential.name] ?? provider.saved_credentials[credential.name] ?? ''}
                  onChange={(e) => {
                    setCloudValues((values) => ({ ...values, [credential.name]: e.target.value }))
                    setVerifiedCloudSignature('')
                  }}
                  placeholder={credential.placeholder}
                  autoComplete="off"
                  className="mt-1 font-mono text-xs"
                  spellCheck={false}
                />
              </label>
            ))}
          </div>
          <div className="grid grid-cols-2 gap-2 pt-1 sm:flex sm:items-center sm:justify-end">
            <Button
              type="button"
              size="sm"
              variant="default"
              className="w-full sm:w-auto"
              onClick={handleListModels}
              disabled={(!hasCloudCandidate && !hasSavedCredentials) || listing}
            >
              {listing && <Loader2 className="h-3 w-3 animate-spin mr-1.5" aria-hidden="true" />}
              List models
            </Button>
            <Button
              type="button"
              size="sm"
              className="w-full sm:w-auto"
              onClick={handleSave}
              disabled={!canSave || saveMutation.isPending}
            >
              {saveMutation.isPending && <Loader2 className="h-3 w-3 animate-spin mr-1.5" aria-hidden="true" />}
              Save
            </Button>
          </div>
          {hasCloudCandidate && !hasVerifiedCloud && (
            <p className="text-[10.5px] text-(--color-text-subtle) leading-normal">
              Click <span className="font-medium text-(--color-text)">List models</span> to verify these credentials before saving.
            </p>
          )}
          {!hasCloudCandidate && provider.is_configured && (
            <p className="text-[10.5px] text-(--color-text-subtle) leading-normal">
              Credentials saved. Type new values above only if you want to replace them.
            </p>
          )}
        </div>
      )}

      {/* ── Detected providers (local without base URL) ─────────────── */}
      {provider.kind !== 'api_key' && provider.kind !== 'oauth' && provider.kind !== 'cloud_creds' && !daemon && (
        <p className="text-[10.5px] text-(--color-text-subtle) leading-normal">
          Detected from local environment or system credentials.
        </p>
      )}

      {/* ── Models panel ────────────────────────────────────────────── */}
      {models.length > 0 && !provider.is_disconnected && (
        <ModelsPanel
          providerId={provider.id}
          models={models}
          visibleModels={provider.visible_models}
          search={modelSearch}
          onSearchChange={setModelSearch}
          expanded={modelsExpanded}
          onToggle={() => setModelsExpanded((v) => !v)}
          onSaveVisibleModels={handleSaveVisibleModels}
          savingVisibleModels={saveVisibleModelsMutation.isPending}
        />
      )}
      {provider.kind === 'oauth' && oauthOpen && (
        <OAuthLoginDialog provider={provider} open={oauthOpen} onOpenChange={setOauthOpen} />
      )}
      </div>
    </SectionCard>
  )
}
