import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'
import type { ReactNode } from 'react'

import { ToastStack } from '@/components/ToastStack'
import { useToastStore } from '@/stores/useToastStore'

mock.module('@tanstack/react-router', () => ({
  Link: ({ children }: { children: ReactNode }) => children,
}))

mock.module('@/hooks/use-mobile', () => ({
  useIsMobile: () => false,
}))

import { SandboxSettingsPage } from '@/components/settings/pages/settings.sandbox'

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
      <SandboxSettingsPage />
      <ToastStack />
    </QueryClientProvider>,
  )
}

describe('SandboxSettingsPage', () => {
  it('keeps sandbox row actions touch-sized before desktop compact sizing', async () => {
    server.use(
      http.get('http://localhost/api/settings/sandbox', () => HttpResponse.json({
        denied_patterns: ['**/.env'],
      })),
      http.put('http://localhost/api/settings/sandbox', () => HttpResponse.json({
        denied_patterns: ['**/.env'],
      })),
    )

    renderPage()

    const pattern = await screen.findByDisplayValue('**/.env')
    expect(pattern).toBeTruthy()

    // The save bar only mounts once there are unsaved edits.
    expect(screen.queryByRole('button', { name: /^Save$/i })).toBeNull()
    fireEvent.change(pattern, { target: { value: '**/.env.local' } })
    expect((await screen.findByRole('button', { name: /^Save$/i })).className).toContain('min-h-11')

    const remove = screen.getByRole('button', { name: /Remove pattern 1/i })
    expect(remove.className).toContain('h-9')
    expect(remove.className).toContain('w-9')
    expect(remove.className).toContain('md:h-7')
    expect(remove.className).toContain('md:w-7')

    const add = screen.getByRole('button', { name: /Add pattern/i })
    expect(add.className).toContain('min-h-11')
    expect(add.className).toContain('md:min-h-0')
  })

  it('keeps empty-state add action touch-sized', async () => {
    server.use(
      http.get('http://localhost/api/settings/sandbox', () => HttpResponse.json({
        denied_patterns: [],
      })),
    )

    renderPage()

    expect(await screen.findByText('No patterns')).toBeTruthy()
    const add = screen.getByRole('button', { name: /Add pattern/i })
    expect(add.className).toContain('min-h-11')
    expect(add.className).toContain('md:min-h-0')
  })

  it('keeps examples trigger touch-accessible', async () => {
    server.use(
      http.get('http://localhost/api/settings/sandbox', () => HttpResponse.json({
        denied_patterns: [],
      })),
    )

    renderPage()

    const examples = await screen.findByRole('button', { name: /See examples/i })
    expect(examples.className).toContain('min-h-11')
    fireEvent.click(examples)
    expect(await screen.findByText('Any file named .env, at any depth')).toBeTruthy()
  })
})
