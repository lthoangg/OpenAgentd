import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'

import { ToastStack } from '@/components/ToastStack'
import { ProvidersSettingsPage } from '@/routes/settings.providers'
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
            fallback_models: [],
            oauth_command: '',
            docs_url: '',
            is_configured: false,
            is_saved: true,
            is_reachable: false,
            visible_models: [],
          },
        ],
      })),
      http.post('http://localhost/api/settings/providers/codex/models', () => HttpResponse.json({
        provider: 'codex',
        models: ['gpt-5'],
        source: 'fallback',
      })),
    )

    renderPage()

    expect(await screen.findByText('Codex')).toBeTruthy()
    expect(screen.getByText('Connected')).toBeTruthy()
    expect(screen.queryByText('Failed')).toBeNull()
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
            fallback_models: [],
            oauth_command: '',
            docs_url: '',
            is_configured: false,
            is_saved: true,
            is_reachable: false,
            visible_models: [],
          },
        ],
      })),
      http.get('http://localhost/api/auth/copilot/login', () => new HttpResponse(
        'event: device_code\ndata: {"user_code":"ABCD-1234","verification_uri":"https://github.com/login/device"}\n\n',
        { headers: { 'Content-Type': 'text/event-stream' } },
      )),
    )

    renderPage()

    expect(await screen.findByText('Copilot')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /Connect/i }))

    expect(await screen.findByText('ABCD-1234')).toBeTruthy()
    expect(screen.getByText('Use this code on GitHub to authorize Copilot. Keep this dialog open while GitHub approves access.')).toBeTruthy()
    const copyCode = screen.getByLabelText('Copy device code')
    expect(copyCode.className).toContain('h-9')
    expect(copyCode.className).toContain('w-9')
    fireEvent.click(copyCode)
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith('ABCD-1234'))
    expect(screen.getByRole('button', { name: /Open authorization page/i }).className).toContain('min-h-11')
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
            fallback_models: [],
            oauth_command: '',
            docs_url: '',
            is_configured: false,
            is_saved: false,
            is_reachable: null,
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
      http.post('http://localhost/api/settings/seed', () => HttpResponse.json({
        agents_written: [],
        skills_written: [],
        configs_written: [],
        source: 'test',
      })),
    )

    renderPage()

    expect(await screen.findByText('Codex')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /Connect/i }))

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
            fallback_models: [],
            oauth_command: '',
            docs_url: '',
            is_configured: true,
            is_saved: true,
            is_reachable: true,
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
    await waitFor(() => expect(screen.getByText(/1 models available/)).toBeTruthy())
    const toggle = screen.getByRole('button', { name: /1 models available/i })
    expect(toggle.className).toContain('min-h-11')
    expect(toggle.className).toContain('md:min-h-0')

    fireEvent.click(toggle)
    expect(screen.getByText('openai:gpt-test')).toBeTruthy()
    const copy = screen.getByLabelText('Copy openai:gpt-test')
    expect(copy.parentElement?.className).toContain('min-h-11')
    expect(copy.className).toContain('h-8')
    expect(copy.className).toContain('w-8')
    expect(copy.className).toContain('md:h-6')
    expect(copy.className).toContain('md:w-6')
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
            fallback_models: [],
            oauth_command: '',
            docs_url: '',
            is_configured: true,
            is_saved: true,
            is_reachable: true,
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
    await waitFor(() => expect(screen.getByText('Active usage')).toBeTruthy())
    expect(screen.getByText('Model A · window')).toBeTruthy()
    expect(screen.getByText(/42% used/)).toBeTruthy()
  })
})
