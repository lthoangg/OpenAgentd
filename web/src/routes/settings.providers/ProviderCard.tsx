import { useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertCircle, CheckCircle2, ExternalLink, KeyRound, Loader2, ShieldCheck } from 'lucide-react'

import { ApiValidationError, listProviderModels, type ProviderInfo } from '@/api/client'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
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
  // Save is enabled only after List models succeeded for *this exact* key.
  const hasVerifiedKey = verifiedKey === trimmedKey && hasCandidateKey
  const hasVerifiedCloud = verifiedCloudSignature === cloudSignature && hasCloudCandidate
  const canSave =
    ((provider.kind === 'api_key' || provider.kind === 'oauth') && hasVerifiedKey) ||
    (provider.kind === 'cloud_creds' && hasVerifiedCloud)

  const daemon = DAEMON_BASE_URL[provider.id]
  // Only sends ``extra`` when the user actually typed something. An empty
  // override means "use the daemon's default" — the backend would write
  // an empty line and confuse things.
  const extraForRequest = useMemo<Record<string, string> | undefined>(() => {
    if (!daemon || !trimmedBaseUrl) return undefined
    return { [daemon.var]: trimmedBaseUrl }
  }, [daemon, trimmedBaseUrl])

  // Auto-list models for already-connected providers (no new key typed).
  // OAuth providers (Copilot, Codex) also surface their model list here
  // once the user has completed the device-flow login. Cloud credential
  // providers (Bedrock / Vertex AI) use the saved .env values when the
  // fields are blank after a page refresh.
  const autoFetchEnabled =
    provider.is_configured &&
    !hasCandidateKey &&
    !hasCloudCandidate &&
    (provider.kind === 'api_key' || provider.kind === 'oauth' || provider.kind === 'cloud_creds')

  const autoModelsQ = useQuery({
    queryKey: queryKeys.settings.providerModels(provider.id),
    queryFn: () => listProviderModels(provider.id, {}),
    enabled: autoFetchEnabled,
    staleTime: 60_000,
  })
  const usageQ = useProviderUsageQuery(
    provider.id,
    provider.kind === 'oauth' && provider.is_configured,
  )

  // Derived (not state) — single source of truth is the query cache.
  const models = useMemo<string[]>(
    () => autoModelsQ.data?.models ?? [],
    [autoModelsQ.data?.models],
  )

  const handleListModels = async () => {
    try {
      const listed = await modelsMutation.mutateAsync({
        providerId: provider.id,
        apiKey: trimmedKey,
        extra: provider.kind === 'cloud_creds' ? cloudExtra : extraForRequest,
      })
      // Write into the shared query cache so the derived ``models`` /
      // ``modelSource`` above pick it up without a parallel local state.
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
        // Provider was unreachable → backend fell back to catalog defaults.
        // Don't mark the key verified; user should retry.
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
      // Always include the base-URL field for daemon providers (even
      // when empty) so the backend's ``write_env_credentials`` removes
      // a previously-set line when the user clears the input.
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
    <Card size="sm" className="rounded-md border-(--color-border) bg-(--bg-card)">
      <CardContent className="space-y-3">
        {/* ── Header ──────────────────────────────────────────────────── */}
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-(--bg-key) text-(--color-text-muted) ring-1 ring-(--color-border)">
            {provider.kind === 'oauth' ? <ShieldCheck size={13} aria-hidden="true" /> : <KeyRound size={13} aria-hidden="true" />}
          </div>
          <p className="text-sm font-semibold text-(--color-text)">{provider.label}</p>
          <span className="rounded-md bg-(--bg-key) px-2 py-0.5 text-[11px] font-medium text-(--color-text-muted)">
            {providerKindLabel(provider.kind)}
          </span>
          {isConfiguredButUnreachable ? (
            <span className="inline-flex items-center gap-1 rounded-md bg-(--color-error-subtle) px-2 py-0.5 text-[11px] font-medium text-(--color-error)">
              <AlertCircle size={12} aria-hidden="true" />
              Failed
            </span>
          ) : isConnected ? (
            <span className="inline-flex items-center gap-1 rounded-md bg-(--color-success-subtle) px-2 py-0.5 text-[11px] font-medium text-(--color-success)">
              <CheckCircle2 size={12} aria-hidden="true" />
              Connected
            </span>
          ) : null}
          <div className="flex-1" />
          {provider.docs_url && (
            <Button type="button" size="sm" variant="ghost" onClick={() => void openExternalUrl(provider.docs_url)}>
              Docs <ExternalLink size={12} aria-hidden="true" />
            </Button>
          )}
        </div>
        <p className="text-xs text-(--color-text-muted)">{provider.description}</p>

        {/* ── API-key controls ─────────────────────────────────────────── */}
        {provider.kind === 'api_key' && (
          <div className="space-y-2">
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
                  className="h-9"
                />
              </label>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={handleListModels}
                disabled={!hasCandidateKey || listing}
              >
                {listing && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
                List models
              </Button>
              <Button
                type="button"
                size="sm"
                onClick={handleSave}
                disabled={!canSave || saveMutation.isPending}
              >
                {saveMutation.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
                Save
              </Button>
            </div>
            {daemon && (
              <label className="block">
                <span className="text-[11px] font-medium text-(--color-text-muted)">Base URL (optional)</span>
                <Input
                  type="url"
                  value={baseUrl}
                  onChange={(e) => setBaseUrl(e.target.value)}
                  placeholder={daemon.placeholder}
                  autoComplete="off"
                  className="mt-1 h-9 font-mono text-xs"
                  spellCheck={false}
                />
              </label>
            )}
            {hasCandidateKey && !hasVerifiedKey && (
              <p className="text-xs text-(--color-text-muted)">
                Click <span className="font-medium">List models</span> to verify this key before saving.
              </p>
            )}
            {!hasCandidateKey && provider.is_configured && (
              <p className="text-xs text-(--color-text-muted)">
                Key saved. Type a new one above only if you want to replace it.
              </p>
            )}
          </div>
        )}

        {/* ── OAuth providers ──────────────────────────────────────────── */}
        {provider.kind === 'oauth' && (
          <div className="flex items-center justify-end gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={handleListModels}
              disabled={!provider.is_configured || listing}
            >
              {listing && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
              List models
            </Button>
            <Button type="button" size="sm" onClick={() => setOauthOpen(true)}>
              <ShieldCheck size={14} aria-hidden="true" />
              Connect
            </Button>
          </div>
        )}

        {provider.kind === 'oauth' && provider.is_configured && (
          <div className="space-y-2">
            {usageQ.isLoading ? (
              <p className="inline-flex items-center gap-1 text-xs text-(--color-text-muted)">
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                Loading active usage…
              </p>
            ) : usageQ.data ? (
              <UsagePanel limits={usageQ.data.limits} />
            ) : usageQ.isError ? (
              <p className="text-xs text-(--color-text-muted)">
                {usageQ.error instanceof ApiValidationError && usageQ.error.status === 404
                  ? 'Usage monitoring is not supported for this OAuth provider yet.'
                  : 'Usage monitor unavailable right now.'}
              </p>
            ) : null}
          </div>
        )}

        {/* ── Local daemon (Ollama) — optional base URL only ─────────── */}
        {provider.kind === 'local' && daemon && (
          <div className="space-y-2">
            <div className="grid gap-2 sm:grid-cols-[minmax(220px,1fr)_auto_auto] sm:items-center">
              <label className="min-w-0">
                <span className="sr-only">{daemon.var}</span>
                <Input
                  type="url"
                  value={baseUrl}
                  onChange={(e) => setBaseUrl(e.target.value)}
                  placeholder={daemon.placeholder}
                  autoComplete="off"
                  className="h-9 font-mono text-xs"
                  spellCheck={false}
                />
              </label>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={handleListModels}
                disabled={listing}
              >
                {listing && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
                List models
              </Button>
              <Button
                type="button"
                size="sm"
                onClick={handleSave}
                disabled={saveMutation.isPending}
              >
                {saveMutation.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
                Save
              </Button>
            </div>
            <p className="text-xs text-(--color-text-muted)">
              Leave blank to use the default daemon at <span className="font-mono">{daemon.placeholder}</span>.
            </p>
          </div>
        )}

        {/* ── Cloud credential providers (Bedrock, Vertex AI) ─────────── */}
        {provider.kind === 'cloud_creds' && (
          <div className="space-y-2">
            <div className="grid gap-2 sm:grid-cols-2">
              {provider.credentials.map((credential) => (
                <label key={credential.name} className="block">
                  <span className="text-[11px] font-medium text-(--color-text-muted)">{credential.label}</span>
                  <Input
                    type={credential.secret ? 'password' : 'text'}
                    value={cloudValues[credential.name] ?? provider.saved_credentials[credential.name] ?? ''}
                    onChange={(e) => {
                      setCloudValues((values) => ({ ...values, [credential.name]: e.target.value }))
                      setVerifiedCloudSignature('')
                    }}
                    placeholder={credential.placeholder}
                    autoComplete="off"
                    className="mt-1 h-9 font-mono text-xs"
                    spellCheck={false}
                  />
                </label>
              ))}
            </div>
            <div className="flex items-center justify-end gap-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={handleListModels}
                disabled={!hasCloudCandidate || listing}
              >
                {listing && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
                List models
              </Button>
              <Button
                type="button"
                size="sm"
                onClick={handleSave}
                disabled={!canSave || saveMutation.isPending}
              >
                {saveMutation.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
                Save
              </Button>
            </div>
            {hasCloudCandidate && !hasVerifiedCloud && (
              <p className="text-xs text-(--color-text-muted)">
                Click <span className="font-medium">List models</span> to verify these credentials before saving.
              </p>
            )}
            {!hasCloudCandidate && provider.is_configured && (
              <p className="text-xs text-(--color-text-muted)">
                Credentials saved. Type new values above only if you want to replace them.
              </p>
            )}
          </div>
        )}

        {/* ── Detected providers (local without base URL) ─────────────── */}
        {provider.kind !== 'api_key' && provider.kind !== 'oauth' && provider.kind !== 'cloud_creds' && !daemon && (
          <p className="text-xs text-(--color-text-muted)">
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
      </CardContent>
      {provider.kind === 'oauth' && oauthOpen && (
        <OAuthLoginDialog provider={provider} open={oauthOpen} onOpenChange={setOauthOpen} />
      )}
    </Card>
  )
}
