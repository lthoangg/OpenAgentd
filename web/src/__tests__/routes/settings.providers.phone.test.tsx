/**
 * Providers on a phone (mockup J10 10.2): three status segments pinned over
 * the list, Hidden in the footer, no type picker.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'

mock.module('@/hooks/use-is-phone', () => ({ useIsPhone: () => true }))
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { setupServer } from '@/__tests__/msw'

import { ToastStack } from '@/components/ToastStack'
import { ProvidersSettingsPage } from '@/components/settings/pages/settings.providers'
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

describe('Providers on a phone', () => {
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

  it('pins three segments and moves Hidden to the footer', async () => {
    server.use(
      http.get('http://localhost/api/settings/providers', () => HttpResponse.json({
        has_any_configured: true,
        providers: [
          provider('Alpha'),
          provider('Bravo', { is_disconnected: true }),
          provider('Delta', { is_configured: false, is_saved: false, is_reachable: null }),
        ],
      })),
    )
    renderPage()
    const filter = await screen.findByRole('radiogroup', { name: 'Filter by status' })
    expect(filter.closest('[data-provider-filter="phone"]')!.className).toContain('sticky')
    const labels = Array.from(filter.querySelectorAll('[role="radio"]')).map((el) => el.textContent)
    expect(labels).toEqual(['All', 'Connected · 1', 'Not connected'])
    expect(screen.queryByRole('combobox', { name: 'Filter by type' })).toBeNull()
    fireEvent.click(await screen.findByRole('button', { name: '1 hidden' }))
    await waitFor(() => expect(screen.getByText('Bravo')).toBeTruthy())
  })
})
