import { useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertCircle, CheckCircle2, ExternalLink, KeyRound, Loader2, ShieldCheck } from 'lucide-react'

import { ApiValidationError, type ProviderInfo } from '@/api/client'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { queryKeys, useProviderModelsMutation, useProviderUsageQuery, useSaveProviderMutation, useSaveProviderVisibleModelsMutation } from '@/queries'
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

  const models = useMemo<string[]>(
    () => autoModelsQ.data?.models ?? provider.cached_models ?? [],
    [autoModelsQ.data?.models, provider.cached_models],
  )

  const handleListModels = async () => {
    try {
      const listed = await modelsMutation.mutateAsync({
        providerId: provider.id,
        apiKey: trimmedKey,
        extra: provider.kind === 'cloud_creds' ? cloudExtra : extraForRequest,
      })
      queryClient.setQueryData(queryKeys.settings.providerModels(provider.id), listed)
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

  const listing = modelsMutation.isPending || autoModelsQ.isFetching
  const isConnected = provider.is_configured || (provider.kind === 'oauth' && provider.is_saved)
  const isConfiguredButUnreachable =
    hasReachabilityFailure || (provider.kind !== 'oauth' && (provider.is_reachable === false || (provider.is_saved && !provider.is_configured)))

  return (
    <div className="group rounded-md border border-(--color-border) bg-(--bg-card) p-4 space-y-3">
      {/* ── Header ──────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-2 select-none">
        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded bg-(--bg-key) text-(--color-text-muted) border border-(--color-border)">
          {provider.kind === 'oauth' ? <ShieldCheck size={13} aria-hidden="true" /> : <KeyRound size={13} aria-hidden="true" />}
        </div>
        <p className="text-xs font-semibold text-(--color-text)">{provider.label}</p>

        <div className="flex-1" />

        <span className="rounded bg-(--bg-key) px-1.5 py-0.5 text-[9px] font-semibold text-(--color-text-muted) border border-(--color-border)">
          {providerKindLabel(provider.kind)}
        </span>

        {isConfiguredButUnreachable ? (
          <span className="inline-flex items-center gap-1 rounded bg-(--color-error-subtle) px-1.5 py-0.5 text-[9px] font-semibold text-(--color-error) border border-(--color-error)/15">
            <AlertCircle size={10} aria-hidden="true" />
            Failed
          </span>
        ) : isConnected ? (
          <span className="inline-flex items-center gap-1 rounded bg-(--color-success-subtle) px-1.5 py-0.5 text-[9px] font-semibold text-(--color-success) border border-(--color-success)/15">
            <CheckCircle2 size={10} aria-hidden="true" />
            Connected
          </span>
        ) : null}

        {provider.docs_url && (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-6.5 text-[10.5px] px-2"
            onClick={() => void openExternalUrl(provider.docs_url)}
          >
            Docs <ExternalLink size={10.5} aria-hidden="true" className="ml-1" />
          </Button>
        )}
      </div>

      <p className="text-xs text-(--color-text-muted) leading-relaxed">{provider.description}</p>

      {/* ── API-key controls ─────────────────────────────────────────── */}
      {provider.kind === 'api_key' && (
        <div className="space-y-2 pt-1">
          <div className="grid gap-2 sm:grid-cols-[minmax(220px,1fr)_auto_auto] sm:items-center">
            <label className="min-w-0">
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
                className="h-8.5 text-xs font-mono"
              />
            </label>
            <Button
              type="button"
              size="sm"
              variant="default"
              className=""
              onClick={handleListModels}
              disabled={!hasCandidateKey || listing}
            >
              {listing && <Loader2 className="h-3 w-3 animate-spin mr-1.5" aria-hidden="true" />}
              List models
            </Button>
            <Button
              type="button"
              size="sm"
              className=""
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
                className="mt-1 font-mono"
                spellCheck={false}
              />
            </label>
          )}
          {hasCandidateKey && !hasVerifiedKey && (
            <p className="text-[10.5px] text-(--color-text-subtle) leading-normal">
              Click <span className="font-medium text-(--color-text)">List models</span> to verify this key before saving.
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
        <div className="flex items-center justify-end gap-2 pt-1">
          <Button
            type="button"
            size="sm"
            variant="default"
            className=""
            onClick={handleListModels}
            disabled={!provider.is_configured || listing}
          >
            {listing && <Loader2 className="h-3 w-3 animate-spin mr-1.5" aria-hidden="true" />}
            List models
          </Button>
          <Button
            type="button"
            size="sm"
            className=""
            onClick={() => setOauthOpen(true)}
          >
            <ShieldCheck size={12} aria-hidden="true" className="mr-1.5" />
            Connect
          </Button>
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
            <UsagePanel limits={usageQ.data.limits} />
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
          <div className="grid gap-2 sm:grid-cols-[minmax(220px,1fr)_auto_auto] sm:items-center">
            <label className="min-w-0">
              <span className="sr-only">{daemon.var}</span>
              <Input
                type="url"
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                placeholder={daemon.placeholder}
                autoComplete="off"
                className="font-mono"
                spellCheck={false}
              />
            </label>
            <Button
              type="button"
              size="sm"
              variant="default"
              className=""
              onClick={handleListModels}
              disabled={listing}
            >
              {listing && <Loader2 className="h-3 w-3 animate-spin mr-1.5" aria-hidden="true" />}
              List models
            </Button>
            <Button
              type="button"
              size="sm"
              className=""
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
                  className="mt-1 font-mono"
                  spellCheck={false}
                />
              </label>
            ))}
          </div>
          <div className="flex items-center justify-end gap-2 pt-1">
            <Button
              type="button"
              size="sm"
              variant="default"
              className=""
              onClick={handleListModels}
              disabled={!hasCloudCandidate || listing}
            >
              {listing && <Loader2 className="h-3 w-3 animate-spin mr-1.5" aria-hidden="true" />}
              List models
            </Button>
            <Button
              type="button"
              size="sm"
              className=""
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
      {models.length > 0 && (
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
  )
}
