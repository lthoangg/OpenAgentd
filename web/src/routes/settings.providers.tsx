import { useEffect, useMemo, useRef, useState } from 'react'
import fuzzysort from 'fuzzysort'
import {
  AlertCircle,
  ArrowLeft,
  Check,
  CheckCircle2,
  Copy,
  ExternalLink,
  KeyRound,
  Loader2,
  ShieldCheck,
  TerminalSquare,
} from 'lucide-react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'

import {
  ApiValidationError,
  installSeed,
  listProviderModels,
  oauthLoginStream,
  submitOAuthCallback,
  type OAuthLoginEvent,
  type ProviderInfo,
  type ProviderUsageLimit,
} from '@/api/client'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import {
  queryKeys,
  useProviderModelsMutation,
  useProviderUsageQuery,
  useProvidersQuery,
  useSaveProviderMutation,
} from '@/queries'
import { openExternalUrl } from '@/lib/open-external'
import { useIsMobile } from '@/hooks/use-mobile'
import { usePlatform } from '@/hooks/use-platform'
import { mediumHapticFeedback } from '@/lib/haptics'
import { useToastStore } from '@/stores/useToastStore'
import { isTransientNetworkError } from '@/utils/errors'

const MODEL_LONG_PRESS_MS = 520
const MODEL_LONG_PRESS_MOVE_TOLERANCE = 10

function providerKindLabel(kind: ProviderInfo['kind']): string {
  if (kind === 'api_key') return 'API key'
  if (kind === 'oauth') return 'OAuth'
  if (kind === 'local') return 'Local'
  return 'Cloud credentials'
}

/** Daemon-style providers expose an optional base URL so users can point
 *  at a proxy running on another host. Each entry names the env var the
 *  backend reads (and persists via the Save endpoint) plus a placeholder
 *  showing the default the daemon would normally listen on. */
const DAEMON_BASE_URL: Record<string, { var: string; placeholder: string }> = {
  router9: { var: 'ROUTER9_BASE_URL', placeholder: 'http://localhost:20128/v1' },
  cliproxy: { var: 'CLIPROXY_BASE_URL', placeholder: 'http://localhost:8317/v1' },
  ollama: { var: 'OLLAMA_BASE_URL', placeholder: 'http://localhost:11434/v1' },
}

function eventLabel(event: OAuthLoginEvent): string {
  if (event.event === 'started') return 'Starting secure login'
  if (event.event === 'device_code') return 'Waiting for browser approval'
  if (event.event === 'polling' && typeof event.elapsed_s === 'number') return `Still waiting (${event.elapsed_s}s)`
  if (event.event === 'token_acquired') return 'Token received'
  if (event.event === 'verifying') return 'Verifying provider access'
  if (event.event === 'success') return 'Connected'
  if (event.event === 'failed') return 'Connection failed'
  return event.message || event.event.replaceAll('_', ' ')
}

function isBenignOAuthStreamClose(message: string): boolean {
  return isTransientNetworkError(new Error(message))
}

function formatResetTime(timestamp?: number | null): string | null {
  if (typeof timestamp !== 'number') return null
  return new Date(timestamp * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function usageLabel(limit: ProviderUsageLimit): string {
  if (limit.limit_name) return limit.limit_name
  if (limit.limit_id === 'codex') return 'Codex'
  return limit.limit_id || 'Usage'
}

function formatWindowDuration(minutes?: number | null): string {
  if (typeof minutes !== 'number') return 'window'
  if (minutes < 60) return `${minutes}m window`
  if (minutes < 60 * 24) return `${Math.round(minutes / 60)}h window`
  return `${Math.round(minutes / (60 * 24))}d window`
}

function deviceCodeHelp(providerId: string): string {
  if (providerId === 'codex') {
    return 'Use this code for personal ChatGPT accounts. Keep this dialog open while the browser approves access.'
  }
  if (providerId === 'copilot') {
    return 'Use this code on GitHub to authorize Copilot. Keep this dialog open while GitHub approves access.'
  }
  return 'Use this code on the authorization page. Keep this dialog open while access is approved.'
}

function UsageBar({ label, window }: { label: string; window: NonNullable<ProviderUsageLimit['primary']> }) {
  const percent = Math.max(0, Math.min(100, window.used_percent))
  const reset = formatResetTime(window.resets_at)
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2 text-[11px] text-(--color-text-muted)">
        <span>{label}</span>
        <span>{Math.round(percent)}% used{reset ? `, resets ${reset}` : ''}</span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-(--bg-key)">
        <div
          className="h-full rounded-full bg-(--color-accent)"
          style={{ width: `${percent}%` }}
        />
      </div>
    </div>
  )
}

function UsageLimitRows({ limit }: { limit: ProviderUsageLimit }) {
  const base = usageLabel(limit)
  const credits = limit.credits
  return (
    <>
      {limit.primary && (
        <UsageBar label={`${base} · ${formatWindowDuration(limit.primary.window_minutes)}`} window={limit.primary} />
      )}
      {limit.secondary && (
        <UsageBar label={`${base} · ${formatWindowDuration(limit.secondary.window_minutes)}`} window={limit.secondary} />
      )}
      {credits && !limit.primary && !limit.secondary && (
        <p className="text-[11px] text-(--color-text-muted)">
          {credits.unlimited ? 'Unlimited usage available' : credits.has_credits ? 'Usage credits available' : 'No usage credits available'}
        </p>
      )}
    </>
  )
}

function UsagePanel({ limits }: { limits: ProviderUsageLimit[] }) {
  if (limits.length === 0) return null
  const primary = limits[0]
  const credits = primary?.credits
  return (
    <div className="space-y-2 rounded-md border border-(--color-border) bg-(--bg-subtle) p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs font-semibold text-(--color-text)">Active usage</p>
        <p className="text-[11px] text-(--color-text-muted)">
          {primary?.plan_type ? `Plan: ${primary.plan_type}` : 'Live usage'}
          {credits?.unlimited ? ' · unlimited' : credits?.balance ? ` · credits ${credits.balance}` : ''}
        </p>
      </div>
      <div className="space-y-2">
        {limits.map((limit, index) => (
          <UsageLimitRows key={`${limit.limit_id || 'usage'}-${index}`} limit={limit} />
        ))}
      </div>
      {primary?.rate_limit_reached_type && (
        <p className="text-[11px] font-medium text-(--color-error)">
          Limit reached: {primary.rate_limit_reached_type.replaceAll('_', ' ')}
        </p>
      )}
    </div>
  )
}

function ProviderCard({ provider }: { provider: ProviderInfo }) {
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
  const modelSource = autoModelsQ.data?.source ?? null

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
        {models.length > 0 && modelSource === 'provider' && (
          <ModelsPanel
            providerId={provider.id}
            models={models}
            search={modelSearch}
            onSearchChange={setModelSearch}
            expanded={modelsExpanded}
            onToggle={() => setModelsExpanded((v) => !v)}
          />
        )}
        {modelSource === 'fallback' && models.length > 0 && (
          <p className="rounded-md border border-(--color-border) bg-(--bg-key) px-2 py-1.5 text-xs text-(--color-text-muted)">
            Live listing unavailable — showing {models.length} curated fallback models.
          </p>
        )}
      </CardContent>
      {provider.kind === 'oauth' && oauthOpen && (
        <OAuthLoginDialog provider={provider} open={oauthOpen} onOpenChange={setOauthOpen} />
      )}
    </Card>
  )
}

/** Indexed model entry for fuzzysort — qualifiedId is the search target
 *  *and* the value the user sees / copies, so search and display stay in
 *  sync. */
type IndexedModel = {
  qualifiedId: string
}

function ModelsPanel({
  providerId,
  models,
  search,
  onSearchChange,
  expanded,
  onToggle,
}: {
  providerId: string
  models: string[]
  search: string
  onSearchChange: (v: string) => void
  expanded: boolean
  onToggle: () => void
}) {
  // Copying is silent on success — feedback is already implicit (the
  // mouse click triggers the browser's clipboard write). We only surface
  // a toast if the clipboard API rejects, which is rare and worth
  // calling out.
  const push = useToastStore((s) => s.push)
  const handleCopy = async (qualifiedId: string) => {
    try {
      await navigator.clipboard.writeText(qualifiedId)
    } catch {
      push({ tone: 'error', title: 'Copy failed', description: qualifiedId })
    }
  }

  // Materialise once per ``models`` change. Indexing into the qualified
  // string means searching for ``"openai:gpt-5"`` works just as well as
  // searching for ``"gpt5"``.
  const indexed = useMemo<IndexedModel[]>(
    () => models.map((id) => ({ qualifiedId: `${providerId}:${id}` })),
    [models, providerId],
  )

  // Fuzzysort: subsequence match with score-based ranking. Empty query
  // skips ranking entirely (preserves the provider's returned order).
  const visible = useMemo<IndexedModel[]>(() => {
    const q = search.trim()
    if (!q) return indexed
    const results = fuzzysort.go(q, indexed, {
      key: 'qualifiedId',
      threshold: 0.2,
      limit: 200,
    })
    return results.map((r) => r.obj)
  }, [indexed, search])

  return (
    <div className="rounded-md border border-(--color-border) bg-(--bg-page)">
      <button
        type="button"
        onClick={onToggle}
        className="flex min-h-11 w-full items-center justify-between gap-2 px-2 py-1.5 text-left text-xs font-medium text-(--color-text-muted) hover:text-(--color-text) md:min-h-0"
        aria-expanded={expanded}
      >
        <span>
          {indexed.length} models available {search && <span className="text-(--color-text-muted)">· {visible.length} shown</span>}
        </span>
        <span className="text-[11px]">{expanded ? 'Hide' : 'Show'}</span>
      </button>
      {expanded && (
        <div className="border-t border-(--color-border) p-2">
          <Input
            type="search"
            value={search}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder="Filter models…"
            className="h-8 text-xs"
            aria-label="Filter models"
          />
          <ul className="mt-2 max-h-64 overflow-y-auto">
            {visible.length === 0 ? (
              <li className="px-2 py-3 text-center text-xs text-(--color-text-muted)">No matching models.</li>
            ) : (
              visible.map(({ qualifiedId }) => (
                <ModelRow key={qualifiedId} qualifiedId={qualifiedId} onCopy={handleCopy} />
              ))
            )}
          </ul>
        </div>
      )}
    </div>
  )
}

function ModelRow({ qualifiedId, onCopy }: { qualifiedId: string; onCopy: (qualifiedId: string) => Promise<void> }) {
  const isMobile = useIsMobile()
  const { isTauri, os } = usePlatform()
  const isTauriMobile = isTauri && (os === 'ios' || os === 'android')
  const [actionsPoint, setActionsPoint] = useState<{ x: number; y: number } | null>(null)
  const longPressTimerRef = useRef<number | null>(null)
  const longPressStartRef = useRef<{ x: number; y: number } | null>(null)

  const clearLongPress = () => {
    if (longPressTimerRef.current !== null) window.clearTimeout(longPressTimerRef.current)
    longPressTimerRef.current = null
    longPressStartRef.current = null
  }

  return (
    <li
      className="flex min-h-11 items-center gap-2 rounded px-2 py-1 hover:bg-(--bg-key) md:min-h-0"
      onContextMenu={(event) => {
        if (isTauriMobile) return
        event.preventDefault()
        setActionsPoint({ x: event.clientX, y: event.clientY })
      }}
      onPointerDown={(event) => {
        if (!isMobile || !isTauriMobile || event.pointerType === 'mouse') return
        longPressStartRef.current = { x: event.clientX, y: event.clientY }
        longPressTimerRef.current = window.setTimeout(() => {
          longPressTimerRef.current = null
          longPressStartRef.current = null
          mediumHapticFeedback()
          setActionsPoint({ x: event.clientX, y: event.clientY })
        }, MODEL_LONG_PRESS_MS)
      }}
      onPointerMove={(event) => {
        const start = longPressStartRef.current
        if (!start) return
        if (
          Math.abs(event.clientX - start.x) > MODEL_LONG_PRESS_MOVE_TOLERANCE ||
          Math.abs(event.clientY - start.y) > MODEL_LONG_PRESS_MOVE_TOLERANCE
        ) {
          clearLongPress()
        }
      }}
      onPointerUp={clearLongPress}
      onPointerCancel={clearLongPress}
      onPointerLeave={clearLongPress}
    >
      <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-(--color-text)">
        {qualifiedId}
      </span>
      <button
        type="button"
        onClick={() => void onCopy(qualifiedId)}
        className="flex h-8 w-8 items-center justify-center rounded text-(--color-text-muted) hover:bg-(--bg-card) hover:text-(--color-text) md:h-6 md:w-6"
        aria-label={`Copy ${qualifiedId}`}
      >
        <Copy size={13} className="md:h-[11px] md:w-[11px]" aria-hidden="true" />
      </button>
      {actionsPoint && (
        <div
          className="fixed inset-0 z-[70]"
          onClick={() => setActionsPoint(null)}
          onContextMenu={(event) => {
            event.preventDefault()
            setActionsPoint(null)
          }}
        >
          <div
            role="menu"
            aria-label={`Actions for ${qualifiedId}`}
            className="fixed min-w-44 rounded-lg border border-(--color-border) bg-(--bg-card) p-1 text-sm text-(--color-text) shadow-xl"
            style={{ left: actionsPoint.x, top: actionsPoint.y }}
            onClick={(event) => event.stopPropagation()}
          >
            <button
              type="button"
              role="menuitem"
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-(--bg-key) focus-visible:bg-(--bg-key) focus-visible:outline-none"
              onClick={() => {
                setActionsPoint(null)
                void onCopy(qualifiedId)
              }}
            >
              <Copy size={14} aria-hidden="true" />
              Copy model ID
            </button>
          </div>
        </div>
      )}
    </li>
  )
}

function OAuthLoginDialog({
  provider,
  open,
  onOpenChange,
}: {
  provider: ProviderInfo
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const [events, setEvents] = useState<OAuthLoginEvent[]>([])
  const [error, setError] = useState<string | null>(null)
  const [code, setCode] = useState('')
  const [codeCopied, setCodeCopied] = useState(false)
  const [authMode, setAuthMode] = useState<'device' | 'browser'>('device')
  const [submittingCode, setSubmittingCode] = useState(false)
  const openedUrlRef = useRef<string | null>(null)
  const successHandledRef = useRef(false)
  const queryClient = useQueryClient()
  const latest = events.at(-1)
  const deviceEvent = events.find((event) => event.event === 'device_code')
  const isSuccess = latest?.event === 'success'
  const isWorking = open && !isSuccess && !error

  const copyDeviceCode = async () => {
    if (!deviceEvent?.user_code) return
    try {
      await navigator.clipboard.writeText(deviceEvent.user_code)
      setCodeCopied(true)
      window.setTimeout(() => setCodeCopied(false), 1500)
    } catch {
      // Copy is best-effort; the code remains visible for manual entry.
    }
  }

  useEffect(() => {
    if (!open) return undefined
    const abort = new AbortController()
    openedUrlRef.current = null
    successHandledRef.current = false
    oauthLoginStream(
      provider.id,
      {
        onEvent: () => undefined,
        onOAuthEvent: (event) => {
          setEvents((current) => [...current, event])
          if (event.verification_uri && openedUrlRef.current !== event.verification_uri) {
            openedUrlRef.current = event.verification_uri
            void openExternalUrl(event.verification_uri)
          }
          if (event.event === 'success' && !successHandledRef.current) {
            successHandledRef.current = true
            void queryClient.invalidateQueries({ queryKey: queryKeys.settings.providers() })
            void queryClient.invalidateQueries({ queryKey: queryKeys.agentFiles.registry() })
            const model = event.suggested_model
            if (model) {
              void installSeed(model)
                .then(() => {
                  useToastStore.getState().push({
                    tone: 'success',
                    title: 'Provider connected',
                    description: 'Default agents and skills are ready.',
                  })
                })
                .catch((err: unknown) => {
                  useToastStore.getState().push({
                    tone: 'error',
                    title: 'Seed install failed',
                    description: err instanceof Error ? err.message : String(err),
                  })
                })
            } else {
              useToastStore.getState().push({ tone: 'success', title: 'Provider connected', description: provider.label })
            }
          }
          if (event.event === 'failed') {
            setError(event.message ?? 'OAuth login failed')
          }
        },
        onError: (err) => {
          if (successHandledRef.current && isBenignOAuthStreamClose(err.message)) return
          setError(err.message)
        },
      },
      abort.signal,
      authMode === 'browser' ? 'browser' : undefined,
    )
    return () => abort.abort()
  }, [authMode, open, provider.id, provider.label, queryClient])

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) setAuthMode('device')
        onOpenChange(nextOpen)
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Connect {provider.label}</DialogTitle>
          <DialogDescription>Approve the browser prompt. This window will update when the token is saved.</DialogDescription>
        </DialogHeader>
        <div className="min-w-0 space-y-4">
          <div className="flex items-center gap-3 rounded-lg border border-(--color-border) bg-(--bg-key) p-3">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-(--bg-card) text-(--color-accent) ring-1 ring-(--color-border)">
              {isWorking ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <CheckCircle2 className="h-4 w-4" aria-hidden="true" />}
            </div>
            <div>
              <p className="text-sm font-medium text-(--color-text)">{latest ? eventLabel(latest) : 'Starting secure login'}</p>
              <p className="text-xs text-(--color-text-muted)">Keep this dialog open until setup completes.</p>
            </div>
          </div>
          {deviceEvent?.user_code && (
            <div className="overflow-hidden rounded-xl border border-(--accent-blue)/25 bg-(--accent-blue-soft)">
              <div className="p-5 text-center">
                <p className="text-xs font-medium tracking-[0.18em] text-(--color-text-muted) uppercase">Device code</p>
                <div className="mt-2 flex flex-col items-center justify-center gap-3 sm:flex-row">
                  <p className="font-mono text-3xl font-semibold tracking-[0.18em] text-(--color-text)">{deviceEvent.user_code}</p>
                  <button
                    type="button"
                    onClick={() => { void copyDeviceCode() }}
                    className="flex h-9 w-9 items-center justify-center rounded-md border border-(--color-border) bg-(--bg-card) text-(--color-text-muted) transition-colors hover:bg-(--bg-key) hover:text-(--color-text)"
                    aria-label="Copy device code"
                    title="Copy device code"
                  >
                    {codeCopied ? <Check size={15} className="text-(--color-success)" /> : <Copy size={15} />}
                  </button>
                </div>
                <p className="mx-auto mt-2 max-w-sm text-xs leading-relaxed text-(--color-text-muted)">
                  {deviceCodeHelp(provider.id)}
                </p>
                {deviceEvent.verification_uri && (
                  <Button className="mt-4 min-h-11 sm:min-h-0" size="sm" onClick={() => void openExternalUrl(deviceEvent.verification_uri!)}>
                    Open authorization page
                  </Button>
                )}
              </div>
              {provider.id === 'codex' && authMode !== 'browser' && !isSuccess && (
                <div className="border-t border-(--accent-blue)/20 bg-(--bg-page)/70 p-4 text-left">
                  <p className="text-xs font-medium text-(--color-text)">Workspace account?</p>
                  <p className="mt-1 text-xs leading-relaxed text-(--color-text-muted)">
                    If the Codex page says your admin must enable device-code authentication, switch to browser sign-in.
                  </p>
                  <Button
                    className="mt-3 min-h-11 w-full sm:min-h-0"
                    size="sm"
                    variant="secondary"
                    onClick={() => {
                      setError(null)
                      setEvents([])
                      setAuthMode('browser')
                    }}
                  >
                    Use browser sign-in instead
                  </Button>
                </div>
              )}
            </div>
          )}
          {latest?.event === 'code_required' && (
            <form
              className="space-y-2 rounded-lg border border-(--color-border) bg-(--bg-page) p-3"
              onSubmit={(event) => {
                event.preventDefault()
                setSubmittingCode(true)
                submitOAuthCallback(provider.id, code)
                  .then((result) => {
                    setEvents((current) => [...current, { event: 'success', suggested_model: result.suggested_model }])
                    void queryClient.invalidateQueries({ queryKey: queryKeys.settings.providers() })
                    void queryClient.invalidateQueries({ queryKey: queryKeys.agentFiles.registry() })

                    useToastStore.getState().push({ tone: 'success', title: 'Provider connected', description: provider.label })
                  })
                  .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
                  .finally(() => setSubmittingCode(false))
              }}
            >
              <label className="block text-xs font-medium text-(--color-text-muted)">
                Paste authorization callback URL/code
                <Input value={code} onChange={(event) => setCode(event.target.value)} className="mt-1" autoComplete="off" />
              </label>
              <Button type="submit" size="sm" disabled={!code.trim() || submittingCode}>
                {submittingCode && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
                Finish connection
              </Button>
            </form>
          )}
          {isSuccess && (
            <p className="rounded-md bg-(--color-success-subtle) p-3 text-sm text-(--color-success)">Connected successfully.</p>
          )}
          {error && <p className="rounded-md bg-(--color-error)/10 p-3 text-sm text-(--color-error)">{error}</p>}
          {events.length > 0 && (
            <details className="rounded-md border border-(--color-border) bg-(--bg-page) p-3">
              <summary className="flex cursor-pointer items-center gap-2 text-xs font-medium text-(--color-text-muted)">
                <TerminalSquare size={13} aria-hidden="true" />
                Technical details
              </summary>
              <div className="mt-3 max-h-40 min-w-0 space-y-2 overflow-auto">
                {events.map((event, index) => (
                  <p key={`${event.event}-${index}`} className="min-w-0 text-xs text-(--color-text-muted) [overflow-wrap:anywhere]">
                    <span className="font-mono text-(--color-text)">{event.event}</span>
                    {event.message ? ` · ${event.message}` : ''}
                  </p>
                ))}
              </div>
            </details>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}

export function ProvidersSettingsPage() {
  const isMobile = useIsMobile()
  const providersQ = useProvidersQuery()
  // Render in catalog order so the list is stable regardless of which
  // providers happen to be configured. Sorting by ``is_configured`` would
  // bump a provider to the top the moment its key is saved, which makes
  // the page feel like it's rearranging itself under the user.
  const providers = providersQ.data?.providers ?? []
  const connectedCount = providers.filter((provider) => provider.is_configured).length

  return (
    <>
      <header className="sticky top-0 z-10 flex h-14 shrink-0 items-center gap-3 border-b border-(--color-border) bg-(--bg-page) px-4">
        {isMobile && (
          <Link
            to="/settings"
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-(--color-text-muted) transition-colors hover:bg-(--bg-key) hover:text-(--color-text)"
            aria-label="Back to settings"
          >
            <ArrowLeft size={14} />
          </Link>
        )}
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
