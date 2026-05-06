import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'
import type { ReactNode } from 'react'

import { ToastStack } from '@/components/ToastStack'
import { useToastStore } from '@/stores/useToastStore'

mock.module('@tanstack/react-router', () => ({
  Link: ({ children }: { children: ReactNode }) => children,
  useLocation: () => ({ pathname: '/settings/voice' }),
}))

mock.module('@/hooks/use-mobile', () => ({
  useIsMobile: () => false,
}))

import { VoiceSettingsPage } from '@/routes/settings.voice'

const server = setupServer()

let originalFetch: typeof fetch | undefined

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
  useToastStore.setState({ toasts: [] })
  if (originalFetch) globalThis.fetch = originalFetch
  originalFetch = undefined
  server.close()
})

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  })

  const result = render(
    <QueryClientProvider client={queryClient}>
      <VoiceSettingsPage />
      <ToastStack />
    </QueryClientProvider>,
  )

  return {
    ...result,
    unmount: () => {
      result.unmount()
      queryClient.clear()
    },
  }
}

describe('VoiceSettingsPage', () => {
  it('renders loading state initially', () => {
    server.use(
      http.get('http://localhost/api/speech/config', async () => {
        await new Promise((resolve) => setTimeout(resolve, 50))
        return HttpResponse.json({
          enabled: false,
          model: 'local:base',
          language: 'auto',
          max_file_mb: 25,
        })
      }),
    )

    renderPage()

    expect(screen.getByText('Loading…')).toBeTruthy()
  })

  it('renders form with server data after load', async () => {
    server.use(
      http.get('http://localhost/api/speech/config', () =>
        HttpResponse.json({
          enabled: false,
          model: 'local:base',
          language: 'auto',
          max_file_mb: 25,
        }),
      ),
    )

    renderPage()

    const modelInput = await screen.findByLabelText('Model ID') as HTMLInputElement
    expect(modelInput.value).toBe('local:base')
    expect((screen.getByRole('checkbox', { name: /enabled/i }) as HTMLInputElement).checked).toBe(false)
    expect(screen.getByRole('button', { name: /^save$/i }).hasAttribute('disabled')).toBe(true)
  })

  it('shows Unsaved label and enables Save when form is dirty', async () => {
    server.use(
      http.get('http://localhost/api/speech/config', () =>
        HttpResponse.json({
          enabled: false,
          model: 'local:base',
          language: 'auto',
          max_file_mb: 25,
        }),
      ),
    )

    const user = userEvent.setup()
    renderPage()

    const modelInput = await screen.findByLabelText('Model ID')
    await user.clear(modelInput)
    await user.type(modelInput, 'local:small')

    expect(screen.getByText('Unsaved')).toBeTruthy()
    expect(screen.getByRole('button', { name: /^save$/i }).hasAttribute('disabled')).toBe(false)
  })

  it('Save button calls PUT and shows success toast', async () => {
    let putCalled = false
    server.use(
      http.get('http://localhost/api/speech/config', () =>
        HttpResponse.json({
          enabled: false,
          model: 'local:base',
          language: 'auto',
          max_file_mb: 25,
        }),
      ),
      http.put('http://localhost/api/speech/config', async ({ request }) => {
        putCalled = true
        const body = await request.json()
        return HttpResponse.json(body)
      }),
    )

    const user = userEvent.setup()
    renderPage()

    const modelInput = await screen.findByLabelText('Model ID')
    await user.clear(modelInput)
    await user.type(modelInput, 'local:small')
    await user.click(screen.getByRole('button', { name: /^save$/i }))

    await waitFor(() => expect(putCalled).toBe(true))
    expect(await screen.findByText('Voice config saved')).toBeTruthy()
  })

  it('shows error state when GET fails', async () => {
    server.use(
      http.get('http://localhost/api/speech/config', () =>
        HttpResponse.json({ detail: 'Could not load voice config' }, { status: 500 }),
      ),
    )

    renderPage()

    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(screen.getByText('Could not load voice config')).toBeTruthy()
  })
})
