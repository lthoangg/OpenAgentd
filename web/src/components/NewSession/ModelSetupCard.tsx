/**
 * ModelSetupCard — connect a model without leaving the new-session screen.
 *
 * Shown while no message could run (see `lib/model-readiness.ts`). Three
 * ways in: **Use** a provider that already works (a saved key, a key exported
 * in the environment, a running Ollama), paste a key for one of the quick
 * picks and **Connect** (check → save; the server then gives agents with no
 * model the provider's suggested one), or sign in with a subscription. Every
 * other provider stays one click away in Settings → Providers.
 */
import { useMemo, useState, type FormEvent } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { CheckCircle2, ExternalLink, Loader2 } from 'lucide-react'

import { configureDefaultModel, listProviderModels, saveProvider, type ProviderInfo } from '@/api/client'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { OAuthLoginDialog } from '@/components/settings/pages/settings.providers/OAuthLoginDialog'
import { openExternalUrl } from '@/lib/open-external'
import {
  detectedProviders,
  QUICK_PICK_LABELS,
  QUICK_PICK_PROVIDER_IDS,
  type DetectedProvider,
  type ModelReadiness,
} from '@/lib/model-readiness'
import { invalidateModelSetup } from '@/queries/model-setup'
import { useToastStore } from '@/stores/useToastStore'
import { cn } from '@/lib/utils'

function shortLabel(provider: ProviderInfo): string {
  return QUICK_PICK_LABELS[provider.id] ?? provider.label
}

function modelName(providerModel: string | null | undefined): string | null {
  if (!providerModel) return null
  const index = providerModel.indexOf(':')
  return index >= 0 ? providerModel.slice(index + 1) : providerModel
}

function detectedText({ provider, source }: DetectedProvider): { title: string; detail: string } {
  const name = shortLabel(provider)
  if (source === 'local') return { title: `${name} is running`, detail: 'Models on this computer, no key needed' }
  if (source === 'env') {
    return provider.env_var
      ? { title: `Found ${provider.env_var}`, detail: `${name} key exported in your environment` }
      : { title: `Found ${name} credentials`, detail: 'Exported in your environment' }
  }
  return { title: `${name} is connected`, detail: 'Saved earlier on this machine' }
}

export function ModelSetupCard({
  readiness,
  providers,
  onOpenProviders,
}: {
  readiness: Extract<ModelReadiness, { status: 'needs-model' | 'needs-provider' }>
  providers: readonly ProviderInfo[]
  onOpenProviders: () => void
}) {
  const queryClient = useQueryClient()
  const push = useToastStore((s) => s.push)
  const needsProvider = readiness.status === 'needs-provider' ? readiness.provider : null
  const currentModel = readiness.status === 'needs-provider' ? readiness.model : null
  const [selectedId, setSelectedId] = useState<string | null>(needsProvider?.kind === 'api_key' ? needsProvider.id : null)
  const [apiKey, setApiKey] = useState('')
  const [pending, setPending] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [oauthProvider, setOauthProvider] = useState<ProviderInfo | null>(null)

  // "Use" only fills agents that have no model, so it is offered only then.
  const detected = useMemo(() => (needsProvider ? [] : detectedProviders(providers)), [needsProvider, providers])
  const picks = useMemo(
    () => QUICK_PICK_PROVIDER_IDS
      .map((id) => providers.find((provider) => provider.id === id))
      .filter((provider): provider is ProviderInfo => provider !== undefined && !provider.is_disconnected),
    [providers],
  )
  const selected = providers.find((provider) => provider.id === selectedId) ?? null
  const localRunning = detected.some((item) => item.source === 'local')

  const announce = (provider: ProviderInfo, model: string | null | undefined) => {
    const name = modelName(model)
    push({
      tone: 'success',
      title: `${shortLabel(provider)} connected`,
      description: name ? `Your agents use ${name}. Change it from the model in the footer.` : 'Your agents are ready.',
    })
  }

  const handleUse = async (provider: ProviderInfo) => {
    setPending(provider.id)
    setError(null)
    try {
      const result = await configureDefaultModel({ provider: provider.id })
      await invalidateModelSetup(queryClient)
      announce(provider, result.provider_model)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setPending(null)
    }
  }

  const handleConnect = async (event: FormEvent) => {
    event.preventDefault()
    const key = apiKey.trim()
    if (!selected || !key) return
    setPending(selected.id)
    setError(null)
    try {
      const listed = await listProviderModels(selected.id, { api_key: key })
      if (listed.models.length === 0) {
        setError(`${shortLabel(selected)} did not accept this key. Check it and try again.`)
        return
      }
      const saved = await saveProvider(selected.id, { api_key: key })
      setApiKey('')
      await invalidateModelSetup(queryClient)
      announce(selected, saved.default_model ?? currentModel)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setPending(null)
    }
  }

  const handlePick = (provider: ProviderInfo) => {
    setError(null)
    if (provider.kind === 'oauth') {
      setOauthProvider(provider)
      return
    }
    setSelectedId((current) => (current === provider.id ? null : provider.id))
  }

  const title = needsProvider ? `Connect ${shortLabel(needsProvider)} to start` : 'Connect a model to start'
  const subtitle = needsProvider
    ? `Your agent uses ${modelName(currentModel)}, but ${needsProvider.label} is not connected.`
    : detected.length > 0
      ? 'You can use one of these right away, or connect another provider.'
      : 'Pick where your model comes from. You can add more later.'

  return (
    <section
      aria-label="Connect a model"
      data-testid="model-setup-card"
      className="w-full rounded-sm border border-(--color-border) bg-(--bg-card) p-3 text-left"
    >
      <h2 className="text-xs font-semibold text-(--color-text)">{title}</h2>
      <p className="mt-0.5 text-xs text-(--color-text-muted)">{subtitle}</p>

      {detected.length > 0 && (
        <ul className="mt-3 flex flex-col gap-1.5" aria-label="Ready to use">
          {detected.map((item) => {
            const text = detectedText(item)
            return (
              <li
                key={item.provider.id}
                className="flex items-center gap-2.5 rounded-sm border border-(--color-success)/30 bg-(--color-success-subtle) px-2.5 py-2"
              >
                <CheckCircle2 size={14} className="shrink-0 text-(--color-success)" aria-hidden="true" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-xs font-medium text-(--accent-green-text)">{text.title}</p>
                  <p className="truncate text-[11px] text-(--color-text-2)">{text.detail}</p>
                </div>
                <Button
                  size="sm"
                  variant="primary"
                  disabled={pending !== null}
                  onClick={() => { void handleUse(item.provider) }}
                  aria-label={`Use ${shortLabel(item.provider)}`}
                >
                  {pending === item.provider.id && <Loader2 className="animate-spin" aria-hidden="true" />}
                  Use
                </Button>
              </li>
            )
          })}
        </ul>
      )}

      {!needsProvider && picks.length > 0 && (
        <div className="mt-3 grid grid-cols-2 gap-1.5" role="group" aria-label="Providers">
          {picks.map((provider) => {
            const active = selectedId === provider.id
            return (
              <button
                key={provider.id}
                type="button"
                aria-pressed={provider.kind === 'oauth' ? undefined : active}
                onClick={() => handlePick(provider)}
                disabled={pending !== null}
                className={cn(
                  'flex h-9 min-w-0 items-center gap-2 rounded-sm border px-2.5 text-left text-xs transition-colors pointer-coarse:h-9',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring) disabled:opacity-50',
                  active
                    ? 'border-(--color-border-strong) bg-(--bg-key) text-(--color-text)'
                    : 'border-(--color-border) bg-(--color-surface) text-(--color-text) hover:bg-(--bg-key)/60',
                )}
              >
                <span className="min-w-0 flex-1 truncate font-medium">{shortLabel(provider)}</span>
                <span className="shrink-0 text-[11px] text-(--color-text-subtle)">
                  {provider.kind === 'oauth' ? 'Sign in' : 'API key'}
                </span>
              </button>
            )
          })}
        </div>
      )}

      {selected && selected.kind === 'api_key' && (
        <form onSubmit={(event) => { void handleConnect(event) }} className="mt-2 rounded-sm border border-(--color-border-subtle) bg-(--bg-page) p-2.5">
          <label htmlFor="model-setup-key" className="mb-1 block text-xs font-medium text-(--color-text)">
            {selected.credentials[0]?.label ?? `${shortLabel(selected)} API key`}
          </label>
          <div className="flex gap-1.5">
            <Input
              id="model-setup-key"
              type="password"
              autoComplete="off"
              spellCheck={false}
              autoFocus
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
              placeholder={selected.credentials[0]?.placeholder || 'Paste your key'}
              aria-invalid={error !== null || undefined}
              aria-describedby={error ? 'model-setup-error' : 'model-setup-hint'}
              className="font-mono"
            />
            <Button type="submit" size="sm" variant="primary" disabled={!apiKey.trim() || pending !== null}>
              {pending === selected.id && <Loader2 className="animate-spin" aria-hidden="true" />}
              Connect
            </Button>
          </div>
          <p id="model-setup-hint" className="mt-1.5 text-[11px] text-(--color-text-subtle)">
            We check the key, save it on this machine and pick a model for you.
            {selected.docs_url && (
              <>
                {' '}
                <button
                  type="button"
                  onClick={() => { void openExternalUrl(selected.docs_url) }}
                  className="inline-flex items-center gap-0.5 text-(--accent-blue-text) hover:underline"
                >
                  Get a key
                  <ExternalLink size={10} aria-hidden="true" />
                </button>
              </>
            )}
          </p>
        </form>
      )}

      {needsProvider && needsProvider.kind === 'oauth' && (
        <div className="mt-3">
          <Button size="sm" variant="primary" onClick={() => setOauthProvider(needsProvider)}>
            Sign in to {shortLabel(needsProvider)}
          </Button>
        </div>
      )}
      {needsProvider && needsProvider.kind === 'local' && (
        <p className="mt-2 text-xs text-(--color-text-muted)">
          Start {needsProvider.label}; this card goes away once it answers.
        </p>
      )}

      {error && (
        <p id="model-setup-error" role="alert" className="mt-2 text-xs text-(--color-error)">
          {error}
        </p>
      )}

      <div className="mt-2.5 flex flex-wrap items-center justify-between gap-2 text-[11px] text-(--color-text-muted)">
        <span>
          {needsProvider
            ? 'Or pick another model in Settings → Agents.'
            : localRunning ? 'Every other provider is in Settings.' : 'Running models locally? Start Ollama and it shows up here.'}
        </span>
        <Button type="button" variant="link" size="xs" onClick={onOpenProviders}>
          More providers…
        </Button>
      </div>

      {oauthProvider && (
        <OAuthLoginDialog
          provider={oauthProvider}
          open
          onOpenChange={(open) => {
            if (!open) setOauthProvider(null)
          }}
        />
      )}
    </section>
  )
}
