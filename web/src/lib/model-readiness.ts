/**
 * Whether a message can run: the lead agent (or the session's override) has
 * a real model, and that model's provider is connected. One rule for the
 * new-session setup card and the chat's setup banner, so neither hides while
 * a send would still fail for setup reasons, nor shows for a working setup.
 */
import type { ProviderInfo } from '@/api/client'

/** The model new installs seed until a provider is connected. */
export const UNCONFIGURED_MODEL = '__PROVIDER_MODEL__'

export type ModelReadiness =
  /** Still loading: show nothing rather than flash a setup prompt. */
  | { status: 'unknown' }
  | { status: 'ready'; model: string }
  /** No model chosen yet (fresh install). */
  | { status: 'needs-model' }
  /** A model is set, but its provider is not connected (or hidden). */
  | { status: 'needs-provider'; model: string; provider: ProviderInfo }

export function isUnconfiguredModel(model: string | null | undefined): boolean {
  const value = model?.trim() ?? ''
  return value === '' || value.includes(UNCONFIGURED_MODEL)
}

export function modelReadiness(
  providers: readonly ProviderInfo[] | undefined,
  model: string | null | undefined,
): ModelReadiness {
  if (providers === undefined || model === undefined) return { status: 'unknown' }
  if (model === null || isUnconfiguredModel(model)) return { status: 'needs-model' }
  const providerId = model.split(':', 1)[0]
  const provider = providers.find((item) => item.id === providerId)
  // A provider the list does not know (e.g. a plugin that failed to load) is
  // not ours to judge: the send reports its own error.
  if (!provider) return { status: 'ready', model }
  // For local providers `is_configured` means "the daemon answered".
  if (!provider.is_configured || provider.is_disconnected) return { status: 'needs-provider', model, provider }
  return { status: 'ready', model }
}

export type DetectedProvider = {
  provider: ProviderInfo
  /** saved: a key or sign-in stored here; env: an exported variable; local: a daemon that answered. */
  source: 'saved' | 'env' | 'local'
}

/**
 * Providers that already work and only need choosing: a running local
 * daemon, a key exported in the server's environment, or a credential saved
 * before agents had a model. Order: saved, env, local.
 */
export function detectedProviders(providers: readonly ProviderInfo[] | undefined): DetectedProvider[] {
  if (!providers) return []
  const out: DetectedProvider[] = []
  for (const provider of providers) {
    if (!provider.is_configured || provider.is_disconnected) continue
    if (provider.kind === 'local') {
      out.push({ provider, source: 'local' })
    } else if ((provider.stored_credentials?.length ?? 0) > 0) {
      out.push({ provider, source: 'saved' })
    } else if (provider.env_pinned) {
      out.push({ provider, source: 'env' })
    } else {
      // Configured without stored rows or an env pin (older backends,
      // single-credential plugins): it still works.
      out.push({ provider, source: 'saved' })
    }
  }
  const rank = { saved: 0, env: 1, local: 2 } as const
  return out.sort((a, b) => rank[a.source] - rank[b.source])
}

/** Quick picks on the setup card, in display order. */
export const QUICK_PICK_PROVIDER_IDS = ['anthropic', 'openai', 'googlegenai', 'openrouter', 'codex', 'copilot'] as const

/** Short names for the card (the catalog labels are longer). */
export const QUICK_PICK_LABELS: Record<string, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  googlegenai: 'Gemini',
  openrouter: 'OpenRouter',
  codex: 'ChatGPT',
  copilot: 'GitHub Copilot',
  ollama: 'Ollama',
}
