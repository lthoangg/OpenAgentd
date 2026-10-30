import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { setupServer } from '@/__tests__/msw'

import { ToastStack } from '@/components/ToastStack'
import { ProvidersSettingsPage } from '@/components/settings/pages/settings.providers'
import { eagerlyWarmProviderModels } from '@/components/settings/pages/settings.providers/eagerModels'
import { queryKeys } from '@/queries'
import type { ProvidersListBody } from '@/api/client'
import { useToastStore } from '@/stores/useToastStore'

const server = setupServer()
let originalFetch: typeof fetch | undefined
const originalOpen = window.open
const openMock = mock(() => null)

Object.defineProperty(navigator, 'clipboard', {
  value: {
    writeText: mock(async () => undefined),
  },
  configurable: true,
})

beforeEach(() => {
  useToastStore.setState({ toasts: [] })
  ;(navigator.clipboard.writeText as ReturnType<typeof mock>).mockClear()
  openMock.mockClear()
  window.open = openMock
  server.listen()
  server.use(
    http.get('http://localhost/api/settings/providers/:id/usage', ({ params }) =>
      HttpResponse.json({ provider: params.id, limits: [] }),
    ),
  )
  originalFetch = globalThis.fetch
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    if (typeof input === 'string' && input.startsWith('/')) {
      return originalFetch?.(`http://localhost${input}`, init) ?? Promise.reject(new Error('fetch unavailable'))
    }
    return originalFetch?.(input, init) ?? Promise.reject(new Error('fetch unavailable'))
  }) as typeof fetch
})

afterEach(() => {
  server.resetHandlers()
  useToastStore.setState({ toasts: [] })
  if (originalFetch) globalThis.fetch = originalFetch
  originalFetch = undefined
  window.open = originalOpen
  server.close()
})

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  })

  return render(
    <QueryClientProvider client={queryClient}>
      <ProvidersSettingsPage />
      <ToastStack />
    </QueryClientProvider>,
  )
}

describe('ProvidersSettingsPage', () => {
  it('warms configured provider models in parallel then invalidates registry once', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const provider = (id: string): ProvidersListBody['providers'][number] => ({
      id, label: id, description: id, kind: 'api_key', credentials: [],
      saved_credentials: {}, env_var: '', env_vars: [], oauth_command: '', docs_url: '',
      is_configured: true, is_saved: true, is_reachable: true, cached_models: [],
      visible_models: [], is_disconnected: false, supports_fast_mode: false, public_access: false,
    })
    const originalInvalidate = queryClient.invalidateQueries.bind(queryClient)
    const invalidate = mock((...args: unknown[]) => originalInvalidate(...args as Parameters<typeof queryClient.invalidateQueries>)) as unknown as typeof queryClient.invalidateQueries
    queryClient.invalidateQueries = invalidate
    globalThis.fetch = mock(async (...args: unknown[]) => {
      const input = args[0]
      const url = String(input)
      if (url.includes('/broken/')) throw new Error('unavailable')
      const id = url.includes('/first/') ? 'first' : 'second'
      return new Response(JSON.stringify({ provider: id, models: [`${id}-model`], source: 'provider' }))
    }) as typeof fetch

    await eagerlyWarmProviderModels([provider('first'), provider('broken'), provider('second')], queryClient)

    expect(queryClient.getQueryData(queryKeys.settings.providerModels('first'))).toEqual({
      provider: 'first', models: ['first-model'], source: 'provider',
    })
    expect(queryClient.getQueryData(queryKeys.settings.providerModels('second'))).toEqual({
      provider: 'second', models: ['second-model'], source: 'provider',
    })
    expect(invalidate).toHaveBeenCalledTimes(1)
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.agentFiles.registry() })
  })

  it('shows Connected for saved Codex OAuth when model listing fails', async () => {
    server.use(
      http.get('http://localhost/api/settings/providers', () => HttpResponse.json({
        has_any_configured: true,
        providers: [
          {
            id: 'codex',
            label: 'Codex',
            description: 'Codex OAuth provider',
            kind: 'oauth',
            credentials: [],
            env_var: '',
            env_vars: [],
            oauth_command: '',
            docs_url: '',
            is_configured: false,
            is_saved: true,
            is_reachable: false,
            cached_models: [],
            visible_models: [],
          },
        ],
      })),
      http.post('http://localhost/api/settings/providers/codex/models', () => HttpResponse.json({
        provider: 'codex',
        models: ['gpt-5'],
        source: 'provider',
      })),
    )

    renderPage()

    expect(await screen.findByText('Codex')).toBeTruthy()
    expect(screen.getAllByText('Connected').length).toBeGreaterThan(0)
    expect(screen.queryByText('Unreachable')).toBeNull()
    expect(screen.queryByText('Failed')).toBeNull()
    // A saved OAuth token whose listing failed must stay retryable — the
    // daemon re-uses the stored token, there is nothing for the user to retype.
    expect(screen.getByRole('button', { name: 'Test sign-in' }).getAttribute('disabled')).toBeNull()
  })

  it('shows GitHub device-code copy for Copilot OAuth', async () => {
    server.use(
      http.get('http://localhost/api/settings/providers', () => HttpResponse.json({
        has_any_configured: true,
        providers: [
          {
            id: 'copilot',
            label: 'Copilot',
            description: 'Copilot OAuth provider',
            kind: 'oauth',
            credentials: [],
            env_var: '',
            env_vars: [],
            oauth_command: '',
            docs_url: '',
            is_configured: false,
            is_saved: false,
            is_reachable: false,
            cached_models: [],
            visible_models: [],
          },
        ],
      })),
      http.get('http://localhost/api/auth/copilot/login*', () => new HttpResponse(
        'event: device_code\ndata: {"user_code":"ABCD-1234","verification_uri":"https://github.com/login/device"}\n\n',
        { headers: { 'Content-Type': 'text/event-stream' } },
      )),
    )

    renderPage()

    expect(await screen.findByText('Copilot')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }))

    expect(await screen.findByText('ABCD-1234')).toBeTruthy()
    expect(screen.getByText('Use this code on GitHub to authorize Copilot. Keep this dialog open while GitHub approves access.')).toBeTruthy()
    const copyCode = screen.getByLabelText('Copy device code')
    expect(copyCode.className).toContain('h-9')
    expect(copyCode.className).toContain('w-9')
    fireEvent.click(copyCode)
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith('ABCD-1234'))
    expect(screen.getByRole('button', { name: /Open authorization page/i }).className).toContain('min-h-9')
    expect(screen.queryByText(/personal ChatGPT accounts/)).toBeNull()
  })

  it('keeps OAuth dialog connected when mobile reports load failed after success', async () => {
    server.use(
      http.get('http://localhost/api/settings/providers', () => HttpResponse.json({
        has_any_configured: true,
        providers: [
          {
            id: 'codex',
            label: 'Codex',
            description: 'Codex OAuth provider',
            kind: 'oauth',
            credentials: [],
            env_var: '',
            env_vars: [],
            oauth_command: '',
            docs_url: '',
            is_configured: false,
            is_saved: false,
            is_reachable: null,
            cached_models: [],
            visible_models: [],
          },
        ],
      })),
      http.get('http://localhost/api/auth/codex/login', () => new Response(
        new ReadableStream({
          start(controller) {
            const encoder = new TextEncoder()
            controller.enqueue(encoder.encode('event: success\ndata: {"suggested_model":"codex:gpt-5.4"}\n\n'))
            window.setTimeout(() => controller.error(new TypeError('Load failed')), 0)
          },
        }),
        { headers: { 'Content-Type': 'text/event-stream' } },
      )),
      http.post('http://localhost/api/settings/default-model', () => HttpResponse.json({
        agents_updated: [],
      })),
    )

    renderPage()

    expect(await screen.findByText('Codex')).toBeTruthy()
    fireEvent.click(screen.getAllByRole('button', { name: /Connect/i }).at(-1)!)

    expect(await screen.findByText('Connected successfully.')).toBeTruthy()
    await act(async () => { await Promise.resolve() })
    expect(screen.queryByText('Load failed')).toBeNull()
  })

  it('keeps provider model rows and copy actions touch-sized before desktop compact sizing', async () => {
    server.use(
      http.get('http://localhost/api/settings/providers', () => HttpResponse.json({
        has_any_configured: true,
        providers: [
          {
            id: 'openai',
            label: 'OpenAI',
            description: 'OpenAI provider',
            kind: 'api_key',
            credentials: [],
            env_var: 'OPENAI_API_KEY',
            env_vars: [],
            oauth_command: '',
            docs_url: '',
            is_configured: true,
            is_saved: true,
            is_reachable: true,
            cached_models: [],
            visible_models: [],
          },
        ],
      })),
      http.post('http://localhost/api/settings/providers/openai/models', () => HttpResponse.json({
        provider: 'openai',
        models: ['gpt-test'],
        source: 'provider',
      })),
    )

    renderPage()

    expect(await screen.findByText('OpenAI')).toBeTruthy()
    await waitFor(() => expect(screen.getByText(/· 1 available/)).toBeTruthy())
    const toggle = screen.getByRole('button', { name: /Models · 1 available/i })
    expect(toggle.className).toContain('min-h-9')
    expect(toggle.className).toContain('md:min-h-0')

    fireEvent.click(toggle)
    expect(screen.getByText('openai:gpt-test')).toBeTruthy()
    const copy = screen.getByLabelText('Copy openai:gpt-test')
    expect(copy.parentElement?.className).toContain('min-h-9')
    expect(copy.className).toContain('h-8')
    expect(copy.className).toContain('w-8')
    expect(copy.className).toContain('md:h-6')
    expect(copy.className).toContain('md:w-6')
  })

  it('shows cached models already returned by the providers payload', async () => {
    server.use(
      http.get('http://localhost/api/settings/providers', () => HttpResponse.json({
        has_any_configured: true,
        providers: [
          {
            id: 'openai',
            label: 'OpenAI',
            description: 'OpenAI provider',
            kind: 'api_key',
            credentials: [],
            env_var: 'OPENAI_API_KEY',
            env_vars: [],
            oauth_command: '',
            docs_url: '',
            is_configured: true,
            is_saved: true,
            is_reachable: true,
            cached_models: ['old-model'],
            visible_models: [],
          },
        ],
      })),
      http.post('http://localhost/api/settings/providers/openai/models', () => HttpResponse.json({
        provider: 'openai',
        models: ['new-model'],
        source: 'provider',
      })),
    )

    renderPage()

    expect(await screen.findByText('OpenAI')).toBeTruthy()
    await waitFor(() => expect(screen.getByText(/· 1 available/i)).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: /Models · 1 available/i }))
    expect(await screen.findByText('openai:new-model')).toBeTruthy()
  })

  it('shows model prices in the model listing', async () => {
    server.use(
      http.get('http://localhost/api/settings/providers', () => HttpResponse.json({
        has_any_configured: true,
        providers: [
          {
            id: 'openai',
            label: 'OpenAI',
            description: 'OpenAI provider',
            kind: 'api_key',
            credentials: [],
            env_var: 'OPENAI_API_KEY',
            env_vars: [],
            oauth_command: '',
            docs_url: '',
            is_configured: true,
            is_saved: true,
            is_reachable: true,
            cached_models: ['gpt-5', 'free-model'],
            visible_models: [],
            model_costs: {
              'gpt-5': { input: 1.25, output: 10, cache_read: 0.125 },
              'free-model': { input: 0, output: 0 },
            },
          },
        ],
      })),
      http.post('http://localhost/api/settings/providers/openai/models', () => HttpResponse.json({
        provider: 'openai',
        models: ['gpt-5', 'free-model'],
        model_costs: {
          'gpt-5': { input: 1.25, output: 10, cache_read: 0.125 },
          'free-model': { input: 0, output: 0 },
        },
        source: 'provider',
      })),
    )

    renderPage()

    expect(await screen.findByText('OpenAI')).toBeTruthy()
    await waitFor(() => expect(screen.getByText(/· 2 available/i)).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: /Models · 2 available/i }))
    expect(await screen.findByText('openai:gpt-5')).toBeTruthy()
    expect(screen.getByText('$1.25 in · $10 out / 1M')).toBeTruthy()
    expect(screen.getByText('Free')).toBeTruthy()
  })

  it('requires an API key for OpenCode Zen and disables listing without credentials', async () => {
    server.use(
      http.get('http://localhost/api/settings/providers', () => HttpResponse.json({
        has_any_configured: false,
        providers: [
          {
            id: 'opencode',
            label: 'OpenCode Zen',
            description: 'Curated coding models through the OpenCode Zen gateway.',
            kind: 'api_key',
            credentials: [],
            saved_credentials: {},
            env_var: 'OPENCODE_ZEN_API_KEY',
            env_vars: [],
            oauth_command: '',
            docs_url: 'https://opencode.ai/docs/zen/',
            public_access: false,
            is_configured: false,
            is_saved: false,
            is_reachable: null,
            cached_models: [],
            visible_models: [],
            is_disconnected: false,
            supports_fast_mode: false,
          },
        ],
      })),
    )

    renderPage()

    expect(await screen.findByText('OpenCode Zen')).toBeTruthy()
    expect(screen.queryByText(/Free models are available without an API key/i)).toBeNull()
    const testKey = screen.getByRole('button', { name: 'Test key' })
    expect(testKey.getAttribute('disabled')).not.toBeNull()
    expect(screen.queryByRole('button', { name: 'List models' })).toBeNull()
  })

  it('refreshes models for a saved api-key provider without retyping the key', async () => {
    const requestBodies: unknown[] = []
    server.use(
      http.get('http://localhost/api/settings/providers', () => HttpResponse.json({
        has_any_configured: true,
        providers: [
          {
            id: 'anthropic',
            label: 'Anthropic',
            description: 'Anthropic provider',
            kind: 'api_key',
            credentials: [],
            saved_credentials: {},
            env_var: 'ANTHROPIC_API_KEY',
            env_vars: [],
            oauth_command: '',
            docs_url: '',
            public_access: false,
            is_configured: true,
            is_saved: true,
            is_reachable: true,
            cached_models: ['old-model'],
            visible_models: [],
            is_disconnected: false,
            supports_fast_mode: false,
          },
        ],
      })),
      http.post('http://localhost/api/settings/providers/anthropic/models', async ({ request }) => {
        requestBodies.push(await request.json())
        return HttpResponse.json({
          provider: 'anthropic',
          models: ['fresh-model'],
          source: 'provider',
        })
      }),
    )

    renderPage()

    expect(await screen.findByText('Anthropic')).toBeTruthy()
    const testKey = screen.getByRole('button', { name: 'Test key' })
    expect(testKey.getAttribute('disabled')).toBeNull()

    fireEvent.click(testKey)

    // The daemon re-uses the stored key when the request carries none.
    await waitFor(() => expect(requestBodies).toContainEqual({ api_key: '' }))
    // A successful listing auto-expands the models panel.
    expect(await screen.findByRole('button', { name: /Models · 1 available/i })).toBeTruthy()
    expect(await screen.findByText('anthropic:fresh-model')).toBeTruthy()
  })

  it('refreshes models for a saved provider whose stored key stopped working', async () => {
    const requestBodies: unknown[] = []
    server.use(
      http.get('http://localhost/api/settings/providers', () => HttpResponse.json({
        has_any_configured: false,
        providers: [
          {
            id: 'anthropic',
            label: 'Anthropic',
            description: 'Anthropic provider',
            kind: 'api_key',
            credentials: [],
            saved_credentials: {},
            env_var: 'ANTHROPIC_API_KEY',
            env_vars: [],
            oauth_command: '',
            docs_url: '',
            public_access: false,
            is_configured: false,
            is_saved: true,
            is_reachable: false,
            cached_models: ['old-model'],
            visible_models: [],
            is_disconnected: false,
            supports_fast_mode: false,
          },
        ],
      })),
      http.post('http://localhost/api/settings/providers/anthropic/models', async ({ request }) => {
        requestBodies.push(await request.json())
        return HttpResponse.json({
          provider: 'anthropic',
          models: ['fresh-model'],
          source: 'provider',
        })
      }),
    )

    renderPage()

    expect(await screen.findByText('Anthropic')).toBeTruthy()
    const testKey = screen.getByRole('button', { name: 'Test key' })
    expect(testKey.getAttribute('disabled')).toBeNull()

    fireEvent.click(testKey)

    await waitFor(() => expect(requestBodies).toContainEqual({ api_key: '' }))
    // A successful listing auto-expands the models panel.
    expect(await screen.findByRole('button', { name: /Models · 1 available/i })).toBeTruthy()
    expect(await screen.findByText('anthropic:fresh-model')).toBeTruthy()
  })

  it('hides stale OpenCode Go models when no Go key is configured', async () => {
    server.use(
      http.get('http://localhost/api/settings/providers', () => HttpResponse.json({
        has_any_configured: false,
        providers: [
          {
            id: 'opencode-go',
            label: 'OpenCode Go',
            description: 'Open coding models through the OpenCode Go subscription.',
            kind: 'api_key',
            credentials: [],
            saved_credentials: {},
            env_var: 'OPENCODE_GO_API_KEY',
            env_vars: [],
            oauth_command: '',
            docs_url: 'https://opencode.ai/docs/go/',
            public_access: false,
            is_configured: false,
            is_saved: false,
            is_reachable: null,
            cached_models: [],
            visible_models: [],
            is_disconnected: false,
            supports_fast_mode: false,
          },
        ],
      })),
    )
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    })
    queryClient.setQueryData(queryKeys.settings.providerModels('opencode-go'), {
      provider: 'opencode-go',
      models: ['stale-go-model'],
      source: 'provider',
    })

    render(
      <QueryClientProvider client={queryClient}>
        <ProvidersSettingsPage />
      </QueryClientProvider>,
    )

    expect(await screen.findByText('OpenCode Go')).toBeTruthy()
    expect(screen.queryByText(/Models · \d+ available/)).toBeNull()
  })

  it('shows active usage for any connected OAuth provider', async () => {
    server.use(
      http.get('http://localhost/api/settings/providers', () => HttpResponse.json({
        has_any_configured: true,
        providers: [
          {
            id: 'plugin-oauth',
            label: 'Plugin OAuth',
            description: 'OAuth provider plugin',
            kind: 'oauth',
            credentials: [],
            env_var: '',
            env_vars: [],
            oauth_command: '',
            docs_url: '',
            is_configured: true,
            is_saved: true,
            is_reachable: true,
            cached_models: [],
            visible_models: [],
          },
        ],
      })),
      http.post('http://localhost/api/settings/providers/plugin-oauth/models', () => HttpResponse.json({
        provider: 'plugin-oauth',
        models: ['model-a'],
        source: 'provider',
      })),
      http.get('http://localhost/api/settings/providers/plugin-oauth/usage', () => HttpResponse.json({
        provider: 'plugin-oauth',
        limits: [
          {
            limit_id: 'model-a',
            limit_name: 'Model A',
            plan_type: 'Live',
            primary: { used_percent: 42, resets_at: null, window_minutes: null },
          },
        ],
      })),
    )

    renderPage()

    expect(await screen.findByText('Plugin OAuth')).toBeTruthy()
    await waitFor(() => expect(screen.getByText('Usage')).toBeTruthy())
    expect(screen.getByText('Model A')).toBeTruthy()
    expect(screen.getByText('42% used')).toBeTruthy()
    expect(screen.getByText('Live')).toBeTruthy()
  })

  it('shows active usage and credits for a configured API key provider', async () => {
    server.use(
      http.get('http://localhost/api/settings/providers', () => HttpResponse.json({
        has_any_configured: true,
        providers: [
          {
            id: 'openrouter',
            label: 'OpenRouter',
            description: 'OpenRouter provider',
            kind: 'api_key',
            credentials: [{ name: 'OPENROUTER_API_KEY', label: 'API Key', secret: true }],
            saved_credentials: { OPENROUTER_API_KEY: 'sk-or-***' },
            env_var: 'OPENROUTER_API_KEY',
            env_vars: [],
            oauth_command: '',
            docs_url: '',
            is_configured: true,
            is_saved: true,
            is_reachable: true,
            cached_models: [],
            visible_models: [],
          },
        ],
      })),
      http.post('http://localhost/api/settings/providers/openrouter/models', () => HttpResponse.json({
        provider: 'openrouter',
        models: ['openai/gpt-5'],
        source: 'provider',
      })),
      http.get('http://localhost/api/settings/providers/openrouter/usage', () => HttpResponse.json({
        provider: 'openrouter',
        limits: [
          {
            limit_id: 'openrouter',
            limit_name: 'OpenRouter Credits',
            plan_type: 'Pay-as-you-go',
            credits: {
              has_credits: true,
              unlimited: false,
              balance: '$42.50',
            },
          },
        ],
      })),
    )

    renderPage()

    expect(await screen.findByText('OpenRouter')).toBeTruthy()
    await waitFor(() => expect(screen.getByText('OpenRouter Credits')).toBeTruthy())
    expect(screen.getByText('Credits available')).toBeTruthy()
    expect(screen.getByText('$42.50')).toBeTruthy()
    expect(screen.getByText('Pay-as-you-go')).toBeTruthy()
  })

  describe('Provider rows', () => {
    const provider = (
      id: string,
      overrides: Partial<ProvidersListBody['providers'][number]> = {},
    ): ProvidersListBody['providers'][number] => ({
      id, label: id, description: `${id} provider`, kind: 'api_key', credentials: [],
      saved_credentials: {}, env_var: '', env_vars: [], oauth_command: '', docs_url: '',
      is_configured: true, is_saved: true, is_reachable: true, cached_models: [],
      visible_models: [], is_disconnected: false, supports_fast_mode: false, public_access: false,
      ...overrides,
    })

    function useProviders(list: ProvidersListBody['providers']) {
      server.use(
        http.get('http://localhost/api/settings/providers', () => HttpResponse.json({ has_any_configured: true, providers: list })),
      )
    }

    it('lists several providers collapsed, and opens one on demand', async () => {
      useProviders([
        provider('Alpha', { description: 'Alpha blurb' }),
        provider('Bravo', { description: 'Bravo blurb', is_configured: false, is_saved: false, is_reachable: null }),
      ])
      renderPage()
      const alpha = await screen.findByRole('button', { name: /Alpha/ })
      expect(alpha.getAttribute('aria-expanded')).toBe('false')
      expect(screen.queryByText('Alpha blurb')).toBeNull()
      expect(screen.queryByRole('button', { name: 'Test key' })).toBeNull()

      fireEvent.click(alpha)
      expect(alpha.getAttribute('aria-expanded')).toBe('true')
      expect(screen.getByText('Alpha blurb')).toBeTruthy()
      expect(screen.getByRole('button', { name: 'Test key' })).toBeTruthy()
      // Bravo stays closed
      expect(screen.getByRole('button', { name: /Bravo/ }).getAttribute('aria-expanded')).toBe('false')
    })

    it('opens the row by itself when the list holds only one provider', async () => {
      useProviders([provider('Alpha', { description: 'Alpha blurb' })])
      renderPage()
      const alpha = await screen.findByRole('button', { name: /Alpha/ })
      expect(alpha.getAttribute('aria-expanded')).toBe('true')
      expect(screen.getByText('Alpha blurb')).toBeTruthy()
      expect(screen.getByRole('button', { name: 'Test key' })).toBeTruthy()
    })

    it('shows status chips and sublines in the row header', async () => {
      useProviders([
        provider('Alpha', { cached_models: ['m1', 'm2'] }),
        provider('Bravo', { is_configured: false, is_saved: true, is_reachable: false }),
        provider('Charlie', { is_disconnected: true }),
        provider('Delta', { is_configured: false, is_saved: false, is_reachable: null }),
        provider('Echo', { kind: 'oauth' }),
        provider('Foxtrot', { kind: 'local', is_configured: false, is_saved: false, is_reachable: null }),
      ])
      renderPage()
      const header = async (name: string) => screen.findByRole('button', { name: new RegExp(name) })
      const chipText = (el: HTMLElement) => el.querySelector('[data-slot="chip"]')?.textContent

      const alpha = await header('Alpha')
      expect(chipText(alpha)).toBe('Connected')
      expect(alpha.textContent).toContain('API key · 2 models')
      expect(chipText(await header('Bravo'))).toBe('Unreachable')
      expect(chipText(await header('Charlie'))).toBe('Hidden from pickers')
      expect(chipText(await header('Delta'))).toBe('Not connected')
      const echo = await header('Echo')
      expect(echo.textContent).toContain('Sign-in')
      expect(chipText(await header('Foxtrot'))).toBe('Not detected')
      expect((await header('Foxtrot')).textContent).toContain('Local server')
    })

    it('filters by type from the dropdown', async () => {
      useProviders([
        provider('Alpha'),
        provider('Bravo'),
        provider('Echo', { kind: 'oauth' }),
      ])
      renderPage()
      expect(await screen.findByRole('button', { name: /Alpha/ })).toBeTruthy()

      fireEvent.click(screen.getByRole('button', { name: 'Filter by type' }))
      expect(screen.getByRole('option', { name: 'Any type' })).toBeTruthy()
      expect(screen.getByRole('option', { name: /^API key\s*2$/ })).toBeTruthy()
      expect(screen.getByRole('option', { name: /^Sign-in\s*1$/ })).toBeTruthy()
      expect(screen.queryByRole('option', { name: /Local server/ })).toBeNull()

      fireEvent.click(screen.getByRole('option', { name: /^Sign-in/ }))
      expect(screen.getByRole('button', { name: /Echo/ })).toBeTruthy()
      expect(screen.queryByRole('button', { name: /Alpha/ })).toBeNull()
    })

    it('shows a loading skeleton while the providers load', async () => {
      server.use(
        http.get('http://localhost/api/settings/providers', async () => {
          await new Promise((resolve) => setTimeout(resolve, 100))
          return HttpResponse.json({ has_any_configured: true, providers: [provider('Alpha')] })
        }),
      )
      renderPage()
      expect(screen.getByRole('status', { name: 'Loading providers' })).toBeTruthy()
      expect(await screen.findByRole('button', { name: /Alpha/ })).toBeTruthy()
      expect(screen.queryByRole('status', { name: 'Loading providers' })).toBeNull()
    })

    it('shows an error callout with Retry when the providers fail to load, and recovers', async () => {
      let calls = 0
      server.use(
        http.get('http://localhost/api/settings/providers', () => {
          calls += 1
          if (calls === 1) return HttpResponse.json({ detail: 'boom' }, { status: 500 })
          return HttpResponse.json({ has_any_configured: true, providers: [provider('Alpha')] })
        }),
      )
      renderPage()
      expect(await screen.findByText("Couldn't load providers")).toBeTruthy()
      fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
      expect(await screen.findByRole('button', { name: /Alpha/ })).toBeTruthy()
      expect(screen.queryByText("Couldn't load providers")).toBeNull()
    })
  })

  describe('Hidden status filter', () => {
    const provider = (
      id: string,
      overrides: Partial<ProvidersListBody['providers'][number]> = {},
    ): ProvidersListBody['providers'][number] => ({
      id, label: id, description: `${id} provider`, kind: 'api_key', credentials: [],
      saved_credentials: {}, env_var: '', env_vars: [], oauth_command: '', docs_url: '',
      is_configured: true, is_saved: true, is_reachable: true, cached_models: [],
      visible_models: [], is_disconnected: false, supports_fast_mode: false, public_access: false,
      ...overrides,
    })

    function useMixedProviders() {
      server.use(
        http.get('http://localhost/api/settings/providers', () => HttpResponse.json({
          has_any_configured: true,
          providers: [
            provider('Alpha'),
            provider('Bravo', { is_disconnected: true }),
            provider('Charlie', { is_disconnected: true }),
            provider('Delta', { is_configured: false, is_saved: false, is_reachable: null }),
          ],
        })),
      )
    }

    // The status filter is a segmented control: radios named "Label N".
    const chip = (label: string) =>
      screen.getByRole('radio', { name: new RegExp(`^${label}\\s*\\d+$`) })

    it('counts each provider under exactly one status', async () => {
      useMixedProviders()
      renderPage()
      expect(await screen.findByText('Alpha')).toBeTruthy()

      expect(screen.getByRole('radiogroup', { name: 'Filter by status' })).toBeTruthy()
      expect(chip('All').textContent).toContain('4')
      expect(chip('Connected').textContent).toContain('1')
      expect(chip('Hidden').textContent).toContain('2')
      expect(chip('Not connected').textContent).toContain('1')
      expect(chip('All').getAttribute('aria-checked')).toBe('true')
      expect(screen.getByText('1 connected')).toBeTruthy()
    })

    it('shows only hidden providers when Hidden is active, and toggles back', async () => {
      useMixedProviders()
      renderPage()
      expect(await screen.findByText('Alpha')).toBeTruthy()

      fireEvent.click(chip('Hidden'))
      expect(chip('Hidden').getAttribute('aria-checked')).toBe('true')
      expect(screen.queryByText('Alpha')).toBeNull()
      expect(screen.queryByText('Delta')).toBeNull()
      expect(screen.getByText('Bravo')).toBeTruthy()
      expect(screen.getByText('Charlie')).toBeTruthy()

      // A radio does not toggle off; "All" brings every provider back
      fireEvent.click(chip('All'))
      expect(screen.getByText('Alpha')).toBeTruthy()
      expect(screen.getByText('Delta')).toBeTruthy()
    })

    it('composes Hidden with the search box', async () => {
      useMixedProviders()
      renderPage()
      expect(await screen.findByText('Alpha')).toBeTruthy()

      fireEvent.click(chip('Hidden'))
      fireEvent.change(screen.getByPlaceholderText('Filter providers…'), { target: { value: 'brav' } })
      expect(screen.getByText('Bravo')).toBeTruthy()
      expect(screen.queryByText('Charlie')).toBeNull()
    })
  })
})
