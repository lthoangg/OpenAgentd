import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'
import type { ReactNode } from 'react'

import { ToastStack } from '@/components/ToastStack'
import { useToastStore, type Toast } from '@/stores/useToastStore'

mock.module('@tanstack/react-router', () => ({
  Link: ({ children }: { children: ReactNode }) => children,
}))

mock.module('@/hooks/use-mobile', () => ({
  useIsMobile: () => false,
}))

import { SummarizationSettingsPage } from '@/routes/settings.summarization'

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
  return render(
    <QueryClientProvider client={queryClient}>
      <SummarizationSettingsPage />
      <ToastStack />
    </QueryClientProvider>,
  )
}

describe('SummarizationSettingsPage', () => {
  it('renders with auto placeholder when threshold is null', async () => {
    server.use(
      http.get('http://localhost/api/settings/summarization', () =>
        HttpResponse.json({ prompt_token_threshold: null }),
      ),
    )

    renderPage()

    const input = await screen.findByRole('spinbutton')
    expect((input as HTMLInputElement).value).toBe('')
    expect((input as HTMLInputElement).placeholder).toContain('Auto')
  })

  it('renders with existing custom threshold pre-filled', async () => {
    server.use(
      http.get('http://localhost/api/settings/summarization', () =>
        HttpResponse.json({ prompt_token_threshold: 80_000 }),
      ),
    )

    renderPage()

    const input = await screen.findByRole('spinbutton')
    expect((input as HTMLInputElement).value).toBe('80000')
  })

  it('marks dirty when threshold changes and saves successfully', async () => {
    server.use(
      http.get('http://localhost/api/settings/summarization', () =>
        HttpResponse.json({ prompt_token_threshold: null }),
      ),
      http.put('http://localhost/api/settings/summarization', () =>
        HttpResponse.json({ prompt_token_threshold: 50_000 }),
      ),
    )

    renderPage()

    const input = await screen.findByRole('spinbutton')
    fireEvent.change(input, { target: { value: '50000' } })

    await waitFor(() => {
      expect(screen.queryByText('Unsaved')).not.toBeNull()
    })

    const saveBtn = screen.getByRole('button', { name: /save/i })
    fireEvent.click(saveBtn)

    await waitFor(() => {
      expect(useToastStore.getState().toasts.some((t: Toast) => t.tone === 'success')).toBe(true)
    })
  })

  it('clears threshold when input is emptied', async () => {
    server.use(
      http.get('http://localhost/api/settings/summarization', () =>
        HttpResponse.json({ prompt_token_threshold: 80_000 }),
      ),
      http.put('http://localhost/api/settings/summarization', async ({ request }) => {
        const body = await request.json() as { prompt_token_threshold: number | null }
        expect(body.prompt_token_threshold).toBeNull()
        return HttpResponse.json({ prompt_token_threshold: null })
      }),
    )

    renderPage()

    const input = await screen.findByRole('spinbutton')
    fireEvent.change(input, { target: { value: '' } })

    await waitFor(() => {
      expect(screen.queryByText('Unsaved')).not.toBeNull()
    })

    const saveBtn = screen.getByRole('button', { name: /save/i })
    fireEvent.click(saveBtn)

    await waitFor(() => {
      expect(useToastStore.getState().toasts.some((t: Toast) => t.tone === 'success')).toBe(true)
    })
  })

  it('save button has correct touch sizing', async () => {
    server.use(
      http.get('http://localhost/api/settings/summarization', () =>
        HttpResponse.json({ prompt_token_threshold: null }),
      ),
    )

    renderPage()

    const save = screen.getByRole('button', { name: /save/i })
    expect(save.className).toContain('min-h-11')
    expect(save.className).toContain('md:min-h-0')
  })

  it('shows error toast on save failure', async () => {
    server.use(
      http.get('http://localhost/api/settings/summarization', () =>
        HttpResponse.json({ prompt_token_threshold: null }),
      ),
      http.put('http://localhost/api/settings/summarization', () =>
        HttpResponse.json({ detail: 'internal error' }, { status: 500 }),
      ),
    )

    renderPage()

    const input = await screen.findByRole('spinbutton')
    fireEvent.change(input, { target: { value: '30000' } })

    const saveBtn = screen.getByRole('button', { name: /save/i })
    fireEvent.click(saveBtn)

    await waitFor(() => {
      expect(useToastStore.getState().toasts.some((t: Toast) => t.tone === 'error')).toBe(true)
    })
  })
})
