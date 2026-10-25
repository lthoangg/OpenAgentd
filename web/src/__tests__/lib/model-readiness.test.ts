import { describe, expect, it } from 'bun:test'
import type { ProviderInfo } from '@/api/client'
import { detectedProviders, modelReadiness, UNCONFIGURED_MODEL } from '@/lib/model-readiness'

function provider(id: string, overrides: Partial<ProviderInfo> = {}): ProviderInfo {
  return {
    id,
    label: id,
    description: '',
    kind: 'api_key',
    credentials: [],
    saved_credentials: {},
    env_var: `${id.toUpperCase()}_API_KEY`,
    env_vars: [],
    oauth_command: '',
    docs_url: '',
    is_configured: false,
    is_saved: false,
    cached_models: [],
    visible_models: [],
    is_disconnected: false,
    supports_fast_mode: false,
    public_access: false,
    stored_credentials: [],
    env_pinned: false,
    ...overrides,
  }
}

const storedKey = { id: 'c1', label: 'Default', disabled: false, kind: 'api_key' as const, hint: '…abcd', settings: {}, status: 'ready' as const, in_use: true, cooldown_until: null, cooldown_reason: null }

describe('modelReadiness', () => {
  it('is unknown while providers or agents are still loading', () => {
    expect(modelReadiness(undefined, 'anthropic:claude')).toEqual({ status: 'unknown' })
    expect(modelReadiness([], undefined)).toEqual({ status: 'unknown' })
  })

  it('needs a model while the agent has the placeholder or none', () => {
    const connected = [provider('anthropic', { is_configured: true })]
    expect(modelReadiness(connected, UNCONFIGURED_MODEL).status).toBe('needs-model')
    expect(modelReadiness(connected, null).status).toBe('needs-model')
    expect(modelReadiness(connected, '  ').status).toBe('needs-model')
  })

  it('needs the provider when the model is set but its provider is not connected or hidden', () => {
    const result = modelReadiness([provider('anthropic')], 'anthropic:claude-sonnet-5-5')
    expect(result.status).toBe('needs-provider')
    const hidden = modelReadiness([provider('anthropic', { is_configured: true, is_disconnected: true })], 'anthropic:x')
    expect(hidden.status).toBe('needs-provider')
  })

  it('is ready when the model provider is connected, including a running local daemon', () => {
    expect(modelReadiness([provider('anthropic', { is_configured: true })], 'anthropic:x')).toEqual({ status: 'ready', model: 'anthropic:x' })
    const ollama = provider('ollama', { kind: 'local', is_configured: true })
    expect(modelReadiness([ollama], 'ollama:qwen3-coder').status).toBe('ready')
    expect(modelReadiness([{ ...ollama, is_configured: false }], 'ollama:qwen3-coder').status).toBe('needs-provider')
  })

  it('does not block a model whose provider the list does not know', () => {
    expect(modelReadiness([], 'someplugin:model').status).toBe('ready')
  })
})

describe('detectedProviders', () => {
  it('lists providers that already work, saved first, then exported keys, then local daemons', () => {
    const list = [
      provider('ollama', { kind: 'local', is_configured: true }),
      provider('openai', { is_configured: true, env_pinned: true }),
      provider('anthropic', { is_configured: true, stored_credentials: [storedKey] }),
      provider('gemini'),
      provider('xai', { is_configured: true, is_disconnected: true, stored_credentials: [storedKey] }),
    ]
    expect(detectedProviders(list).map(({ provider: p, source }) => `${p.id}:${source}`)).toEqual([
      'anthropic:saved',
      'openai:env',
      'ollama:local',
    ])
  })

  it('finds nothing on a fresh install', () => {
    expect(detectedProviders([provider('anthropic'), provider('ollama', { kind: 'local' })])).toEqual([])
    expect(detectedProviders(undefined)).toEqual([])
  })
})
