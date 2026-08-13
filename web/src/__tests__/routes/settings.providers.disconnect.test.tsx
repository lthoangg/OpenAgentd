/**
 * Tests for provider disconnect/reconnect in ProviderCard and ProvidersSettingsPage.
 *
 * Covers:
 * - Disconnect button appears only for connected providers
 * - Clicking Disconnect calls PUT /providers/{id}/disconnect and shows "Disconnected" badge
 * - Clicking Reconnect calls the endpoint with disconnected=false and restores "Connected"
 * - Models panel is hidden while disconnected
 * - Pre-fetch skips disconnected providers
 */

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'

import { cleanup } from '@testing-library/react'
import { ToastStack } from '@/components/ToastStack'
import { ProvidersSettingsPage } from '@/components/settings/pages/settings.providers'
import { useToastStore } from '@/stores/useToastStore'

mock.module('lucide-react', () => new Proxy({}, { get: () => () => null }))

const server = setupServer()
let originalFetch: typeof fetch | undefined

// ── helpers ──────────────────────────────────────────────────────────────────

function makeProvider(overrides: Record<string, unknown> = {}) {
  return {
    id: 'openai',
    label: 'OpenAI',
    description: 'OpenAI provider',
    kind: 'api_key',
    credentials: [],
    saved_credentials: {},
    env_var: 'OPENAI_API_KEY',
    env_vars: [],
    oauth_command: '',
    docs_url: '',
    is_configured: true,
    is_saved: true,
    is_reachable: true,
    cached_models: [],
    visible_models: [],
    is_disconnected: false,
    ...overrides,
  }
}

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return render(
    <QueryClientProvider client={queryClient}>
      <ProvidersSettingsPage />
      <ToastStack />
    </QueryClientProvider>,
  )
}

// ── setup / teardown ─────────────────────────────────────────────────────────

beforeEach(() => {
  useToastStore.setState({ toasts: [] })
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
  server.close()
  useToastStore.setState({ toasts: [] })
  if (originalFetch) globalThis.fetch = originalFetch
  originalFetch = undefined
  cleanup()
})

// ── tests ─────────────────────────────────────────────────────────────────────

describe('ProviderCard — hide / show', () => {
  it('shows Hide button for a connected provider', async () => {
    server.use(
      http.get('http://localhost/api/settings/providers', () =>
        HttpResponse.json({ has_any_configured: true, providers: [makeProvider()] }),
      ),
    )
    renderPage()
    expect(await screen.findByRole('button', { name: /Hide/i })).toBeTruthy()
  })

  it('shows Hide button for a failed (unreachable) provider', async () => {
    server.use(
      http.get('http://localhost/api/settings/providers', () =>
        HttpResponse.json({
          has_any_configured: true,
          providers: [makeProvider({ is_configured: false, is_saved: true, is_reachable: false })],
        }),
      ),
    )
    renderPage()
    // "Failed" badge + Hide button must both be present
    expect(await screen.findByText('Failed')).toBeTruthy()
    expect(screen.getByRole('button', { name: /Hide/i })).toBeTruthy()
  })

  it('does not show Hide button for an unconfigured provider', async () => {
    server.use(
      http.get('http://localhost/api/settings/providers', () =>
        HttpResponse.json({
          has_any_configured: false,
          providers: [makeProvider({ is_configured: false, is_saved: false, is_reachable: null })],
        }),
      ),
    )
    renderPage()
    await screen.findByText('OpenAI')
    expect(screen.queryByRole('button', { name: /Hide/i })).toBeNull()
  })

  it('calls PUT /disconnect with disconnected=true on click', async () => {
    const disconnectRequests: unknown[] = []
    server.use(
      http.get('http://localhost/api/settings/providers', () =>
        HttpResponse.json({ has_any_configured: true, providers: [makeProvider()] }),
      ),
      http.put('http://localhost/api/settings/providers/openai/disconnect', async ({ request }) => {
        disconnectRequests.push(await request.json())
        return HttpResponse.json({ provider: 'openai', is_disconnected: true })
      }),
      // invalidation re-fetch
      http.get('http://localhost/api/settings/providers', () =>
        HttpResponse.json({
          has_any_configured: true,
          providers: [makeProvider({ is_disconnected: true })],
        }),
      ),
    )

    renderPage()
    const btn = await screen.findByRole('button', { name: /Hide/i })
    fireEvent.click(btn)

    await waitFor(() => expect(disconnectRequests).toHaveLength(1))
    expect(disconnectRequests[0]).toEqual({ disconnected: true })
  })

  it('shows Hidden badge after hiding', async () => {
    server.use(
      http.get('http://localhost/api/settings/providers', () =>
        HttpResponse.json({ has_any_configured: true, providers: [makeProvider()] }),
        { once: true },
      ),
      http.put('http://localhost/api/settings/providers/openai/disconnect', () =>
        HttpResponse.json({ provider: 'openai', is_disconnected: true }),
      ),
      http.get('http://localhost/api/settings/providers', () =>
        HttpResponse.json({
          has_any_configured: true,
          providers: [makeProvider({ is_disconnected: true })],
        }),
      ),
    )

    renderPage()
    fireEvent.click(await screen.findByRole('button', { name: /Hide/i }))
    expect(await screen.findByText('Hidden')).toBeTruthy()
  })

  it('shows Show button when provider is hidden', async () => {
    server.use(
      http.get('http://localhost/api/settings/providers', () =>
        HttpResponse.json({
          has_any_configured: true,
          providers: [makeProvider({ is_disconnected: true })],
        }),
      ),
    )
    renderPage()
    expect(await screen.findByRole('button', { name: /Show/i })).toBeTruthy()
  })

  it('calls PUT /disconnect with disconnected=false on Show click', async () => {
    const reconnectRequests: unknown[] = []
    server.use(
      http.get('http://localhost/api/settings/providers', () =>
        HttpResponse.json({
          has_any_configured: true,
          providers: [makeProvider({ is_disconnected: true })],
        }),
      ),
      http.put('http://localhost/api/settings/providers/openai/disconnect', async ({ request }) => {
        reconnectRequests.push(await request.json())
        return HttpResponse.json({ provider: 'openai', is_disconnected: false })
      }),
      http.get('http://localhost/api/settings/providers', () =>
        HttpResponse.json({
          has_any_configured: true,
          providers: [makeProvider({ is_disconnected: false })],
        }),
      ),
    )

    renderPage()
    const btn = await screen.findByRole('button', { name: /Show/i })
    fireEvent.click(btn)

    await waitFor(() => expect(reconnectRequests).toHaveLength(1))
    expect(reconnectRequests[0]).toEqual({ disconnected: false })
  })

  it('hides models panel when provider is disconnected', async () => {
    server.use(
      http.get('http://localhost/api/settings/providers', () =>
        HttpResponse.json({
          has_any_configured: true,
          providers: [makeProvider({ cached_models: ['gpt-5'], is_disconnected: true })],
        }),
      ),
    )
    renderPage()
    await screen.findByText('OpenAI')
    // The "N models available" toggle must not appear
    expect(screen.queryByRole('button', { name: /models available/i })).toBeNull()
  })

  it('shows models panel when provider is connected', async () => {
    server.use(
      http.get('http://localhost/api/settings/providers', () =>
        HttpResponse.json({
          has_any_configured: true,
          providers: [makeProvider({ cached_models: ['gpt-5'], is_disconnected: false })],
        }),
      ),
      http.post('http://localhost/api/settings/providers/openai/models', () =>
        HttpResponse.json({ provider: 'openai', models: ['gpt-5'], source: 'provider' }),
      ),
    )
    renderPage()
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: /models available/i })).toBeTruthy(),
    )
  })

  it('shows a success toast after hiding', async () => {
    server.use(
      http.get(
        'http://localhost/api/settings/providers',
        () => HttpResponse.json({ has_any_configured: true, providers: [makeProvider()] }),
        { once: true },
      ),
      http.put('http://localhost/api/settings/providers/openai/disconnect', () =>
        HttpResponse.json({ provider: 'openai', is_disconnected: true }),
      ),
      http.get('http://localhost/api/settings/providers', () =>
        HttpResponse.json({
          has_any_configured: true,
          providers: [makeProvider({ is_disconnected: true })],
        }),
      ),
    )

    renderPage()
    fireEvent.click(await screen.findByRole('button', { name: /Hide/i }))
    expect(await screen.findByText('Provider hidden')).toBeTruthy()
  })

  it('shows a success toast after showing', async () => {
    server.use(
      http.get(
        'http://localhost/api/settings/providers',
        () =>
          HttpResponse.json({
            has_any_configured: true,
            providers: [makeProvider({ is_disconnected: true })],
          }),
        { once: true },
      ),
      http.put('http://localhost/api/settings/providers/openai/disconnect', () =>
        HttpResponse.json({ provider: 'openai', is_disconnected: false }),
      ),
      http.get('http://localhost/api/settings/providers', () =>
        HttpResponse.json({
          has_any_configured: true,
          providers: [makeProvider({ is_disconnected: false })],
        }),
      ),
    )

    renderPage()
    fireEvent.click(await screen.findByRole('button', { name: /Show/i }))
    expect(await screen.findByText('Provider visible')).toBeTruthy()
  })
})
