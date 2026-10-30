import { useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronRight, ExternalLink, Loader2, ShieldCheck } from 'lucide-react'

import { ApiValidationError, type ProviderInfo, type ProvidersListBody } from '@/api/client'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { Input } from '@/components/ui/input'
import { Chip, type ChipTone } from '@/components/ui/chip'
import { cn } from '@/lib/utils'
import { queryKeys, useAddProviderCredentialMutation, useDisconnectOauthProviderMutation, useDisconnectProviderMutation, useProviderModelsMutation, useProviderUsageQuery, useSaveProviderMutation, useSaveProviderVisibleModelsMutation } from '@/queries'
import { openExternalUrl } from '@/lib/open-external'
import { useToastStore } from '@/stores/useToastStore'
import { DAEMON_BASE_URL, providerKindLabel, supportsMultipleCredentials } from './providerUtils'
import { UsagePanel } from './UsagePanel'
import { ModelsPanel } from './ModelsPanel'
import { OAuthLoginDialog } from './OAuthLoginDialog'
import { CredentialList } from './CredentialList'

/** Kind as a person reads it in the row's subline. */
function kindSubline(kind: ProviderInfo['kind']): string {
  if (kind === 'oauth') return 'Sign-in'
  if (kind === 'local') return 'Local server'
  return providerKindLabel(kind)
}

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`
}

/**
 * One provider as a row in the Providers list: name, what it is, and its
 * state; opening it shows keys, usage and models. `defaultExpanded` is for a
 * standalone render; the list opens rows on demand.
 */
export function ProviderCard({ provider, defaultExpanded = true }: { provider: ProviderInfo; defaultExpanded?: boolean }) {
  const [expanded, setExpanded] = useState(defaultExpanded)
  const [apiKey, setApiKey] = useState('')
  const [keyLabel, setKeyLabel] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [cloudValues, setCloudValues] = useState<Record<string, string>>({})
  const [verifiedKey, setVerifiedKey] = useState('')
  const [verifiedCloudSignature, setVerifiedCloudSignature] = useState('')
  const [hasReachabilityFailure, setHasReachabilityFailure] = useState(false)
  // `null`: closed. `{}`: connect or add an account. `{credentialId}`: reconnect it.
  const [oauthTarget, setOauthTarget] = useState<{ credentialId?: string; label?: string } | null>(null)
  const [modelsExpanded, setModelsExpanded] = useState(false)
  const [modelSearch, setModelSearch] = useState('')
  const modelsMutation = useProviderModelsMutation()
  const saveMutation = useSaveProviderMutation()
  const addCredentialMutation = useAddProviderCredentialMutation()
  const saveVisibleModelsMutation = useSaveProviderVisibleModelsMutation()
  const disconnectMutation = useDisconnectProviderMutation()
  const disconnectOauthMutation = useDisconnectOauthProviderMutation()
  const [confirmSignOut, setConfirmSignOut] = useState(false)
  const push = useToastStore((s) => s.push)
  const queryClient = useQueryClient()

  const trimmedKey = apiKey.trim()
  const trimmedBaseUrl = baseUrl.trim()
  const primaryCredential = provider.credentials[0]
  // Several keys / accounts are managed as a list only for providers the
  // backend marks as multi-credential (poolable built-ins and plugins that
  // opt in); everything else keeps the single-credential form. Credentials
  // already stored for a provider without the capability are left untouched.
  const storedCredentials = provider.stored_credentials ?? []
  const multiCredential = supportsMultipleCredentials(provider)
  const hasCredentialList = multiCredential && (storedCredentials.length > 0 || Boolean(provider.env_pinned))
  const hasStoredKeys = multiCredential && provider.kind === 'api_key' && storedCredentials.length > 0
  const hasStoredAccounts = multiCredential && provider.kind === 'oauth' && storedCredentials.length > 0
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
    queryFn: async () => ({
      provider: provider.id,
      models: provider.cached_models,
      model_costs: provider.model_costs,
      source: 'provider' as const,
    }),
    enabled: autoFetchEnabled,
    staleTime: 60_000,
  })
  const usageQ = useProviderUsageQuery(
    provider.id,
    provider.is_configured,
  )

  const models = useMemo<string[]>(() => {
    // Models listed by an explicit refresh in this session are known-good.
    const justListed = modelsMutation.data?.models
    if (justListed) return justListed
    // Without a live connection there is nothing to show: a cached list from a
    // provider whose credentials stopped working would offer unusable models.
    if (!provider.is_configured) return []
    return autoModelsQ.data?.models ?? provider.cached_models ?? []
  }, [autoModelsQ.data?.models, modelsMutation.data?.models, provider.cached_models, provider.is_configured])

  const modelCosts = useMemo(() => {
    return {
      ...(provider.model_costs ?? {}),
      ...(autoModelsQ.data?.model_costs ?? {}),
      ...(modelsMutation.data?.model_costs ?? {}),
    }
  }, [autoModelsQ.data?.model_costs, modelsMutation.data?.model_costs, provider.model_costs])

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
              item.id === provider.id
                ? { ...item, cached_models: listed.models, model_costs: listed.model_costs }
                : item,
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
        if (provider.is_configured) {
          void queryClient.invalidateQueries({ queryKey: queryKeys.settings.providerUsage(provider.id) })
        }
        push({
          tone: 'success',
          title: 'Connection verified',
          description: `${listed.models.length} models available.`,
        })
      } else {
        push({
          tone: 'error',
          title: 'Unreachable',
          description: `${provider.label} did not answer. Check the key or the address.`,
        })
      }
    } catch (err) {
      setHasReachabilityFailure(true)
      push({
        tone: 'error',
        title: 'Could not test the key',
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
      if (hasStoredKeys) {
        await addCredentialMutation.mutateAsync({
          providerId: provider.id,
          label: keyLabel.trim() || undefined,
          apiKey: trimmedKey,
          extra: daemon !== undefined && trimmedBaseUrl ? { [daemon.var]: trimmedBaseUrl } : undefined,
        })
        setApiKey('')
        setKeyLabel('')
        setVerifiedKey('')
        push({ tone: 'success', title: 'Key added', description: `${provider.label} tries it after your other keys.` })
        return
      }
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
        title: hasStoredKeys ? 'Could not add key' : 'Could not save provider',
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
        title: disconnected ? 'Hidden from pickers' : 'Shown in pickers',
        description: provider.label,
      })
    } catch (err) {
      push({
        tone: 'error',
        title: disconnected ? 'Could not hide from pickers' : 'Could not show in pickers',
        description: err instanceof Error ? err.message : String(err),
      })
    }
  }

  const handleOauthDisconnect = async () => {
    try {
      await disconnectOauthMutation.mutateAsync({ providerId: provider.id })
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

  const testLabel =
    provider.kind === 'oauth' ? 'Test sign-in'
      : provider.kind === 'local' ? 'Test connection'
        : provider.kind === 'cloud_creds' ? 'Test credentials'
          : 'Test key'
  const credentialCount = storedCredentials.length
  const modelCount = provider.is_configured ? (provider.cached_models?.length ?? 0) : 0
  const subline = [
    kindSubline(provider.kind),
    credentialCount > 0 ? plural(credentialCount, provider.kind === 'oauth' ? 'account' : 'key') : null,
    provider.env_pinned ? 'from environment' : null,
    modelCount > 0 ? plural(modelCount, 'model') : null,
  ].filter(Boolean).join(' · ')
  const status: { label: string; tone: ChipTone; dot: boolean } = isConfiguredButUnreachable
    ? { label: 'Unreachable', tone: 'warning', dot: true }
    : provider.is_disconnected
      ? { label: 'Hidden from pickers', tone: 'neutral', dot: false }
      : isConnected
        ? { label: 'Connected', tone: 'success', dot: true }
        : { label: provider.kind === 'local' ? 'Not detected' : 'Not connected', tone: 'neutral', dot: false }
  const bodyId = `provider-${provider.id}-details`

  return (
    <div className="group" data-provider={provider.id}>
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls={bodyId}
        onClick={() => setExpanded((v) => !v)}
        className="flex min-h-14 w-full items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-(--bg-key)/50 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-(--focus-ring)"
      >
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium text-(--color-text)">{provider.label}</span>
          <span className="block truncate text-xs text-(--color-text-muted)">{subline}</span>
        </span>
        <Chip tone={status.tone} dot={status.dot}>{status.label}</Chip>
        <ChevronRight
          size={14}
          aria-hidden="true"
          className={cn('shrink-0 text-(--color-text-subtle) transition-transform duration-(--motion-fast)', expanded && 'rotate-90')}
        />
      </button>

      {expanded && (
      <div id={bodyId} className="space-y-4 border-t border-(--color-border-subtle) px-4 py-4">

      <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
        <p className="min-w-0 flex-1 basis-60 text-xs text-(--color-text-muted) leading-relaxed">{provider.description}</p>
        <div className="flex shrink-0 items-center gap-1">
          {(isConnected || isConfiguredButUnreachable) && (
            <Button
              type="button"
              size="xs"
              variant="ghost"
              onClick={() => void handleDisconnect(!provider.is_disconnected)}
              disabled={disconnectMutation.isPending}
            >
              {disconnectMutation.isPending && <Loader2 size={11} className="mr-1 animate-spin" aria-hidden="true" />}
              {provider.is_disconnected ? 'Show in pickers' : 'Hide from pickers'}
            </Button>
          )}
          {provider.docs_url && (
            <Button
              type="button"
              size="xs"
              variant="ghost"
              onClick={() => void openExternalUrl(provider.docs_url)}
            >
              Docs <ExternalLink size={11} aria-hidden="true" className="ml-1" />
            </Button>
          )}
        </div>
      </div>

      {/* ── API-key controls ─────────────────────────────────────────── */}
      {provider.kind === 'api_key' && (
        <div className="space-y-2 pt-1">
          {hasCredentialList && <CredentialList provider={provider} />}
          {hasStoredKeys && (
            <p className="pt-1 text-xs font-medium text-(--color-text)">Add another key</p>
          )}
          <div
            className={`grid grid-cols-2 gap-2 sm:items-center ${hasStoredKeys ? 'sm:grid-cols-[minmax(120px,0.5fr)_minmax(200px,1fr)_auto_auto]' : 'sm:grid-cols-[minmax(220px,1fr)_auto_auto]'}`}
          >
            {hasStoredKeys && (
              <label className="col-span-2 min-w-0 sm:col-span-1">
                <span className="sr-only">Name for the new key</span>
                <Input
                  value={keyLabel}
                  onChange={(event) => setKeyLabel(event.target.value)}
                  placeholder="Name (e.g. Work)"
                  autoComplete="off"
                  className="h-9 text-xs"
                />
              </label>
            )}
            <label className="col-span-2 min-w-0 sm:col-span-1">
              <span className="sr-only">{primaryCredential?.label || provider.env_var}</span>
              <Input
                type="password"
                value={apiKey}
                onChange={(event) => {
                  setApiKey(event.target.value)
                  setVerifiedKey('')
                }}
                placeholder={
                  hasStoredKeys
                    ? 'Paste another API key'
                    : primaryCredential?.placeholder || (provider.is_configured ? 'Enter a new key to replace current key' : 'Paste API key')
                }
                autoComplete="off"
                className="h-9 font-mono text-xs"
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
              {testLabel}
            </Button>
            <Button
              type="button"
              size="sm"
              className="w-full sm:w-auto"
              onClick={handleSave}
              disabled={!canSave || saveMutation.isPending || addCredentialMutation.isPending}
            >
              {(saveMutation.isPending || addCredentialMutation.isPending) && <Loader2 className="h-3 w-3 animate-spin mr-1.5" aria-hidden="true" />}
              {hasStoredKeys ? 'Add key' : 'Save'}
            </Button>
          </div>
          {daemon && (
            <label className="block">
              <span className="text-xs font-medium text-(--color-text)">Base URL (optional)</span>
              <Input
                type="url"
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                placeholder={daemon.placeholder}
                autoComplete="off"
                className="mt-2 h-9 font-mono text-xs"
                spellCheck={false}
              />
            </label>
          )}
          {hasCandidateKey && !hasVerifiedKey && (
            <p className="text-[11px] leading-relaxed text-(--color-text-muted)">
              Click <span className="font-medium text-(--color-text)">Test key</span> to verify this key before {hasStoredKeys ? 'adding it' : 'saving'}.
            </p>
          )}
          {!hasCandidateKey && provider.public_access && !provider.is_configured && (
            <p className="text-[11px] leading-relaxed text-(--color-text-muted)">
              Free models are available without an API key. Add a key to use paid models.
            </p>
          )}
          {!hasCandidateKey && hasStoredKeys && storedCredentials.length === 1 && !provider.env_pinned && (
            <p className="text-[11px] leading-relaxed text-(--color-text-muted)">
              Add a second key to keep working when this one hits a rate limit or quota.
            </p>
          )}
          {!hasCandidateKey && provider.is_configured && !hasStoredKeys && !provider.env_pinned && (
            <p className="text-[11px] leading-relaxed text-(--color-text-muted)">
              Key saved. Type a new one above only if you want to replace it.
            </p>
          )}
        </div>
      )}

      {/* ── OAuth providers ──────────────────────────────────────────── */}
      {provider.kind === 'oauth' && (
        <div className="space-y-2 pt-1">
        {hasCredentialList && (
          <CredentialList
            provider={provider}
            onReconnect={(credentialId) =>
              setOauthTarget({ credentialId, label: storedCredentials.find((c) => c.id === credentialId)?.label })
            }
          />
        )}
        <div className="grid grid-cols-2 gap-2 sm:flex sm:items-center sm:justify-end">
          <Button
            type="button"
            size="sm"
            variant="default"
            className="w-full sm:w-auto"
            onClick={handleListModels}
            disabled={!hasSavedCredentials || listing}
          >
            {listing && <Loader2 className="h-3 w-3 animate-spin mr-1.5" aria-hidden="true" />}
            {testLabel}
          </Button>
          {hasStoredAccounts ? (
            <Button type="button" size="sm" className="w-full sm:w-auto" onClick={() => setOauthTarget({})}>
              <ShieldCheck size={12} aria-hidden="true" className="mr-1.5" />
              Add account
            </Button>
          ) : hasSavedCredentials ? (
            <>
              <Button
                type="button"
                size="sm"
                className="w-full sm:w-auto"
                onClick={() => setOauthTarget({})}
              >
                <ShieldCheck size={12} aria-hidden="true" className="mr-1.5" />
                Reconnect
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="w-full sm:w-auto text-(--color-error) hover:text-(--color-error)"
                onClick={() => setConfirmSignOut(true)}
                disabled={disconnectOauthMutation.isPending}
              >
                {disconnectOauthMutation.isPending ? (
                  <Loader2 className="h-3 w-3 animate-spin mr-1.5" aria-hidden="true" />
                ) : null}
                Sign out…
              </Button>
              <ConfirmDialog
                open={confirmSignOut}
                onOpenChange={setConfirmSignOut}
                title={`Sign out of ${provider.label}?`}
                description="OpenAgentd forgets this sign-in. Models from this provider stop working until you sign in again."
                confirmLabel="Sign out"
                onConfirm={handleOauthDisconnect}
              />
            </>
          ) : (
            <Button
              type="button"
              size="sm"
              className="w-full sm:w-auto"
              onClick={() => setOauthTarget({})}
            >
              <ShieldCheck size={12} aria-hidden="true" className="mr-1.5" />
              Connect
            </Button>
          )}
        </div>
        </div>
      )}

      {provider.is_configured && (
        <div className="space-y-2 pt-1">
          {usageQ.isLoading ? (
            <p role="status" className="inline-flex items-center gap-1 text-[11px] text-(--color-text-subtle)">
              <Loader2 className="h-3 w-3 animate-spin mr-1" aria-hidden="true" />
              Loading usage…
            </p>
          ) : usageQ.data && usageQ.data.limits.length > 0 ? (
            <UsagePanel providerId={provider.id} limits={usageQ.data.limits} updatedAt={usageQ.dataUpdatedAt} />
          ) : usageQ.isError ? (
            provider.kind === 'oauth' ? (
              <p className="text-[11px] text-(--color-text-subtle)">
                {usageQ.error instanceof ApiValidationError && usageQ.error.status === 404
                  ? 'Usage monitoring is not supported for this OAuth provider yet.'
                  : 'Usage monitor unavailable right now.'}
              </p>
            ) : usageQ.error instanceof ApiValidationError && usageQ.error.status !== 404 ? (
              <p className="text-[11px] text-(--color-text-subtle)">
                Usage monitor unavailable right now.
              </p>
            ) : null
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
              {testLabel}
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
          <p className="text-[11px] leading-relaxed text-(--color-text-muted)">
            Leave blank to use the default daemon at <span className="font-mono text-(--color-text)">{daemon.placeholder}</span>.
          </p>
        </div>
      )}

      {/* ── Cloud credential providers (Bedrock, Vertex AI) ─────────── */}
      {provider.kind === 'cloud_creds' && (
        <div className="space-y-2 pt-1">
          <div className="grid gap-x-4 gap-y-5 sm:grid-cols-2">
            {provider.credentials.map((credential) => (
              <label key={credential.name} className="block">
                <span className="text-xs font-medium text-(--color-text)">{credential.label}</span>
                <Input
                  type={credential.secret ? 'password' : 'text'}
                  value={cloudValues[credential.name] ?? provider.saved_credentials[credential.name] ?? ''}
                  onChange={(e) => {
                    setCloudValues((values) => ({ ...values, [credential.name]: e.target.value }))
                    setVerifiedCloudSignature('')
                  }}
                  placeholder={credential.placeholder}
                  autoComplete="off"
                  className="mt-2 h-9 font-mono text-xs"
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
              {testLabel}
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
            <p className="text-[11px] leading-relaxed text-(--color-text-muted)">
              Click <span className="font-medium text-(--color-text)">Test credentials</span> to verify these credentials before saving.
            </p>
          )}
          {!hasCloudCandidate && provider.is_configured && (
            <p className="text-[11px] leading-relaxed text-(--color-text-muted)">
              Credentials saved. Type new values above only if you want to replace them.
            </p>
          )}
        </div>
      )}

      {/* ── Detected providers (local without base URL) ─────────────── */}
      {provider.kind !== 'api_key' && provider.kind !== 'oauth' && provider.kind !== 'cloud_creds' && !daemon && (
        <p className="text-[11px] leading-relaxed text-(--color-text-muted)">
          Detected from local environment or system credentials.
        </p>
      )}

      {/* ── Models panel ────────────────────────────────────────────── */}
      {models.length > 0 && !provider.is_disconnected && (
        <ModelsPanel
          providerId={provider.id}
          models={models}
          modelCosts={modelCosts}
          visibleModels={provider.visible_models}
          search={modelSearch}
          onSearchChange={setModelSearch}
          expanded={modelsExpanded}
          onToggle={() => setModelsExpanded((v) => !v)}
          onSaveVisibleModels={handleSaveVisibleModels}
          savingVisibleModels={saveVisibleModelsMutation.isPending}
        />
      )}
      {provider.kind === 'oauth' && oauthTarget && (
        <OAuthLoginDialog
          provider={provider}
          open
          onOpenChange={(open) => {
            if (!open) setOauthTarget(null)
          }}
          credentialId={multiCredential ? oauthTarget.credentialId : undefined}
          accountLabel={oauthTarget.label}
        />
      )}
      </div>
      )}
    </div>
  )
}
