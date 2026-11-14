import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ProviderInfo } from '@/api/client'
import { ModelSetupCard } from '@/components/NewSession/ModelSetupCard'
import { queryKeys } from '@/queries/keys'
import { useToastStore } from '@/stores/useToastStore'

const realFetch = globalThis.fetch
// A fixture value, not a real key.
const PASTED = ['fixture', 'pasted', 'value'].join('-')

function provider(id: string, overrides: Partial<ProviderInfo> = {}): ProviderInfo {
  return {
    id,
    label: `${id} label`,
    description: '',
    kind: 'api_key',
    credentials: [{ name: `${id.toUpperCase()}_API_KEY`, label: `${id} API key`, secret: false, required: true, placeholder: 'sk-…' }],
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

const FRESH = [
  provider('anthropic'),
  provider('openai'),
  provider('googlegenai'),
  provider('openrouter'),
  provider('codex', { kind: 'oauth' }),
  provider('copilot', { kind: 'oauth' }),
  provider('deepseek'),
  provider('ollama', { kind: 'local' }),
]

type Call = { method: string; path: string; body: Record<string, unknown> | null }

function mockApi(responses: Record<string, unknown>) {
  const calls: Call[] = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const path = url.replace(/^.*\/api/, '')
    const method = init?.method ?? 'GET'
    calls.push({ method, path, body: init?.body ? JSON.parse(String(init.body)) : null })
    const key = `${method} ${path}`
    if (!(key in responses)) return new Response(JSON.stringify({ detail: `unexpected ${key}` }), { status: 500 })
    return new Response(JSON.stringify(responses[key]), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }) as typeof fetch
  return calls
}

function renderCard(props: Partial<Parameters<typeof ModelSetupCard>[0]> = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const invalidated: unknown[][] = []
  const original = client.invalidateQueries.bind(client)
  client.invalidateQueries = ((filters?: { queryKey?: unknown[] }) => {
    invalidated.push(filters?.queryKey ?? [])
    return original(filters)
  }) as typeof client.invalidateQueries
  const onOpenProviders = mock(() => {})
  render(
    <QueryClientProvider client={client}>
      <ModelSetupCard readiness={{ status: 'needs-model' }} providers={FRESH} onOpenProviders={onOpenProviders} {...props} />
    </QueryClientProvider>,
  )
  return { onOpenProviders, invalidated }
}

beforeEach(() => {
  useToastStore.setState({ toasts: [] })
})

afterEach(() => {
  cleanup()
  globalThis.fetch = realFetch
})

describe('ModelSetupCard', () => {
  it('leads with the subscription sign-ins, then the API keys, each group named once', () => {
    const { onOpenProviders } = renderCard()
    const names = (group: HTMLElement) => Array.from(group.querySelectorAll('button')).map((b) => b.textContent)
    // A person with a subscription has no key and need not learn what one is.
    const groups = screen.getAllByRole('group')
    expect(groups.map((group) => group.getAttribute('aria-label'))).toEqual(['Sign in with a subscription you have', 'Or paste an API key'])
    expect(names(groups[0])).toEqual(['ChatGPT', 'GitHub Copilot'])
    expect(names(groups[1])).toEqual(['Anthropic', 'OpenAI', 'Gemini', 'OpenRouter'])
    // The group's label says it once: no "API key" or "Sign in" tag per tile.
    expect(screen.getByText('Sign in with a subscription you have')).toBeTruthy()
    expect(screen.getByText('Or paste an API key')).toBeTruthy()
    expect(screen.queryByRole('list', { name: 'Ready to use' })).toBeNull()
    screen.getByRole('button', { name: 'More models' }).click()
    expect(onOpenProviders).toHaveBeenCalledTimes(1)
  })

  it('uses no word a newcomer has not met: no provider, no OAuth', () => {
    renderCard()
    const card = screen.getByTestId('model-setup-card')
    expect(card.textContent).not.toMatch(/provider|OAuth|device code/i)
    expect(card.textContent).toContain('You can add more later.')
    expect(card.textContent).toContain('A model running on this computer (Ollama) shows up here on its own.')
  })

  it('connects a pasted key in one step: checks it, saves it, and refetches the agents', async () => {
    const calls = mockApi({
      'POST /settings/providers/anthropic/models': { provider: 'anthropic', models: ['claude-sonnet-5-5'], source: 'provider' },
      'PUT /settings/providers/anthropic': { saved: true, default_model: 'anthropic:claude-sonnet-5-5', agents_updated: ['code.md'] },
    })
    const { invalidated } = renderCard()
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: /Anthropic/ }))
    await user.type(screen.getByLabelText('anthropic API key'), PASTED)
    await user.click(screen.getByRole('button', { name: 'Connect' }))

    await waitFor(() => expect(useToastStore.getState().toasts).toHaveLength(1))
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(['POST /settings/providers/anthropic/models', 'PUT /settings/providers/anthropic'])
    expect(calls.every((c) => c.body?.api_key === PASTED)).toBe(true)
    expect(useToastStore.getState().toasts[0]).toMatchObject({ tone: 'success', title: 'Anthropic connected' })
    // In the user's words: "the model button", not this codebase's "run chip".
    expect(useToastStore.getState().toasts[0].description).toBe('Replies use anthropic:claude-sonnet-5-5. Change it with the model button under the message box.')
    expect(invalidated).toContainEqual([...queryKeys.agents()])
    expect(invalidated).toContainEqual([...queryKeys.settings.providers()])
  })

  it('keeps a key the provider rejects off the machine and says so', async () => {
    const calls = mockApi({ 'POST /settings/providers/openai/models': { provider: 'openai', models: [], source: 'provider' } })
    renderCard()
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: /OpenAI/ }))
    await user.type(screen.getByLabelText('openai API key'), PASTED)
    await user.click(screen.getByRole('button', { name: 'Connect' }))

    expect((await screen.findByRole('alert')).textContent).toContain('OpenAI did not accept this key')
    expect(calls.map((c) => c.method)).toEqual(['POST'])
  })

  it('uses a detected provider with one click, letting the server pick the model', async () => {
    const calls = mockApi({ 'POST /settings/default-model': { agents_updated: ['code.md'], provider_model: 'openai:gpt-6-sol' } })
    const providers = [
      ...FRESH.filter((p) => p.id !== 'openai' && p.id !== 'ollama'),
      provider('openai', { is_configured: true, env_pinned: true }),
      provider('ollama', { kind: 'local', is_configured: true }),
    ]
    renderCard({ providers })
    expect(screen.getByText('Found OPENAI_API_KEY')).toBeTruthy()
    expect(screen.getByText('Ollama is running')).toBeTruthy()
    expect(screen.queryByText(/Start Ollama/)).toBeNull()

    await userEvent.setup().click(screen.getByRole('button', { name: 'Use OpenAI' }))
    await waitFor(() => expect(useToastStore.getState().toasts).toHaveLength(1))
    expect(calls).toEqual([{ method: 'POST', path: '/settings/default-model', body: { provider: 'openai' } }])
    expect(useToastStore.getState().toasts[0].description).toContain('gpt-6-sol')
  })

  it('asks only for the missing provider when the agent already has a model', () => {
    const anthropic = provider('anthropic')
    renderCard({ readiness: { status: 'needs-provider', model: 'anthropic:claude-sonnet-5-5', provider: anthropic } })
    expect(screen.getByRole('heading', { name: 'Connect Anthropic to start' })).toBeTruthy()
    expect(screen.getByText(/uses anthropic:claude-sonnet-5-5/)).toBeTruthy()
    expect(screen.queryByRole('group')).toBeNull()
    // Its key field is already open.
    expect(screen.getByLabelText('anthropic API key')).toBeTruthy()
  })

  it('says what each Use button uses: "Use Ollama", "Use OpenAI"', () => {
    const providers = [
      ...FRESH.filter((p) => p.id !== 'openai' && p.id !== 'ollama'),
      provider('openai', { is_configured: true, env_pinned: true }),
      provider('ollama', { kind: 'local', is_configured: true }),
    ]
    renderCard({ providers })
    const ready = within(screen.getByRole('list', { name: 'Ready to use' }))
    expect(ready.getByRole('button', { name: 'Use Ollama' }).textContent).toBe('Use Ollama')
    expect(ready.getByRole('button', { name: 'Use OpenAI' }).textContent).toBe('Use OpenAI')
    expect(ready.queryByRole('button', { name: 'Use' })).toBeNull()
  })

  it('points to Settings → Models when it asks for one missing sign-in or key', () => {
    const { onOpenProviders } = renderCard({ readiness: { status: 'needs-provider', model: 'anthropic:claude-sonnet-5-5', provider: provider('anthropic') } })
    const card = screen.getByTestId('model-setup-card')
    expect(card.textContent).toContain('Or use a different model in Settings → Models.')
    expect(card.textContent).not.toContain('Settings → Agents')
    screen.getByRole('button', { name: 'More models' }).click()
    expect(onOpenProviders).toHaveBeenCalledTimes(1)
  })

  it('draws no border around anything inside the card, and keeps green text on the green wash', () => {
    const providers = [
      ...FRESH.filter((p) => p.id !== 'ollama'),
      provider('ollama', { kind: 'local', is_configured: true }),
    ]
    renderCard({ providers })
    const card = screen.getByTestId('model-setup-card')
    const bordered = [...card.querySelectorAll('button, li, form')].filter((el) => /(^|\s)border(-|\s|$)/.test(el.getAttribute('class') ?? ''))
    expect(bordered).toEqual([])
    const title = screen.getByText('Ollama is running')
    expect(title.className).toContain('text-(--accent-green-text)')
    expect(title.className).not.toContain('text-(--color-success)')
    expect(card.querySelector('li svg')?.getAttribute('class')).toContain('text-(--accent-green-text)')
  })
})
