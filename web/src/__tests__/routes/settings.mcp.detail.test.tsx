import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'
import type { ReactNode } from 'react'

import { ToastStack } from '@/components/ToastStack'
import { useToastStore } from '@/stores/useToastStore'

mock.module('@tanstack/react-router', () => ({
  Link: ({ children }: { children: ReactNode }) => children,
  useNavigate: () => mock(() => undefined),
}))

import { McpServerDetailPage } from '@/routes/settings.mcp.$name'

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
      <McpServerDetailPage name="filesystem" onBack={() => {}} />
      <ToastStack />
    </QueryClientProvider>,
  )
}

describe('McpServerDetailPage', () => {
  it('keeps MCP editor actions and fields touch-sized before desktop compact sizing', async () => {
    server.use(
      http.get('http://localhost/api/mcp/servers/filesystem', () => HttpResponse.json({
        name: 'filesystem',
        transport: 'stdio',
        enabled: true,
        state: 'ready',
        error: null,
        tool_names: ['read_file'],
        started_at: null,
        config: {
          transport: 'stdio',
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-filesystem'],
          env: { ROOT: '/tmp' },
          enabled: true,
        },
      })),
    )

    renderPage()

    expect((await screen.findAllByText(/Status/i)).length).toBeGreaterThan(0)

    expect(screen.getByRole('button', { name: /^save$/i })).toBeTruthy()
    expect(screen.getByRole('radiogroup', { name: /server enabled state/i })).toBeTruthy()
    expect(screen.getByRole('radiogroup', { name: /mcp transport/i })).toBeTruthy()
    expect(screen.getByPlaceholderText('npx')).toBeTruthy()
    expect(screen.getByRole('button', { name: /add environment variables/i })).toBeTruthy()
    expect(screen.getByRole('button', { name: /remove root/i })).toBeTruthy()
    expect(screen.getByRole('button', { name: /restart server/i })).toBeTruthy()
    expect(screen.getByRole('button', { name: /delete server/i })).toBeTruthy()
  })
})
