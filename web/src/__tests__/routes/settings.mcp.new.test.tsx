import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { setupServer } from '@/__tests__/msw'

import { ToastStack } from '@/components/ToastStack'
import { useToastStore } from '@/stores/useToastStore'
import { NewMcpServerPage } from '@/components/settings/pages/settings.mcp.new'

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
  cleanup()
  server.resetHandlers()
  useToastStore.setState({ toasts: [] })
  if (originalFetch) globalThis.fetch = originalFetch
  originalFetch = undefined
  server.close()
})

function renderPage(onCreated: (name: string) => void = () => {}) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return render(
    <QueryClientProvider client={queryClient}>
      <NewMcpServerPage onBack={() => {}} onCreated={onCreated} />
      <ToastStack />
    </QueryClientProvider>,
  )
}

const address = () => screen.getByRole('textbox', { name: /^Address/ }) as HTMLInputElement
const name = () => screen.getByRole('textbox', { name: /^Name/ }) as HTMLInputElement

describe('NewMcpServerPage', () => {
  it('asks how it connects, with a web address chosen and nothing filled in', () => {
    renderPage()
    expect(screen.getByText('New connector')).toBeTruthy()
    const how = screen.getByRole('radiogroup', { name: 'How does it connect?' })
    expect(how).toBeTruthy()
    expect(screen.getByRole('radio', { name: 'A web address' }).getAttribute('aria-checked')).toBe('true')
    expect(screen.getByRole('radio', { name: 'A program on this computer' }).getAttribute('aria-checked')).toBe('false')
    expect(address().value).toBe('')
    expect(name().value).toBe('')
    expect(name().placeholder).toBe('Filled in from the address')
    // No program template, and no protocol names on the first screen.
    expect(screen.queryByDisplayValue('npx')).toBeNull()
    expect(screen.queryByText(/stdio|MCP/)).toBeNull()
  })

  it('shows no error and no save bar before anything is typed', () => {
    renderPage()
    expect(screen.queryByText(/is required/)).toBeNull()
    expect(screen.queryByRole('region', { name: 'Unsaved changes' })).toBeNull()
  })

  it('fills the name in from the address until a name is typed', async () => {
    const user = userEvent.setup()
    renderPage()
    await user.type(address(), 'https://mcp.notion.com/mcp')
    expect(name().value).toBe('notion')

    await user.clear(name())
    await user.type(name(), 'work-notion')
    await user.clear(address())
    await user.type(address(), 'https://mcp.linear.app/sse')
    expect(name().value).toBe('work-notion')
  })

  it('creates a connector from an address alone, with sign-in on', async () => {
    const user = userEvent.setup()
    let sent: unknown = null
    server.use(
      http.post('http://localhost/api/mcp/servers', async ({ request }) => {
        sent = await request.json()
        return HttpResponse.json({
          name: 'notion', transport: 'http', enabled: true, state: 'auth_required', error: null, tool_names: [], started_at: null,
        })
      }),
    )
    const created: string[] = []
    renderPage((n) => created.push(n))
    await user.type(address(), 'https://mcp.notion.com/mcp')
    expect(screen.getByRole('switch', { name: 'Needs sign-in' }).getAttribute('aria-checked')).toBe('true')
    await user.click(screen.getByRole('button', { name: 'Create connector' }))

    await waitFor(() => expect(created).toEqual(['notion']))
    expect(sent).toEqual({
      name: 'notion',
      server: {
        transport: 'http',
        url: 'https://mcp.notion.com/mcp',
        headers: {},
        oauth: { client_id: null, client_secret: null },
        enabled: true,
      },
    })
    expect(await screen.findByText('Created "notion"')).toBeTruthy()
  })

  it('shows the program fields, and only those, for a program on this computer', async () => {
    const user = userEvent.setup()
    renderPage()
    await user.click(screen.getByRole('radio', { name: 'A program on this computer' }))
    expect(screen.getByRole('textbox', { name: /^Command/ })).toBeTruthy()
    expect(screen.getByRole('textbox', { name: /^Arguments/ })).toBeTruthy()
    expect(screen.getByText('Environment variables')).toBeTruthy()
    expect(screen.queryByRole('textbox', { name: /^Address/ })).toBeNull()
    expect(screen.queryByRole('switch', { name: 'Needs sign-in' })).toBeNull()
    expect(name().placeholder).toBe('filesystem')
    // Choosing an answer is not an edit: no error and no save bar until something is typed.
    expect(screen.queryByText(/is required/)).toBeNull()
    expect(screen.queryByRole('region', { name: 'Unsaved changes' })).toBeNull()

    await user.type(screen.getByRole('textbox', { name: /^Command/ }), 'npx')
    expect(await screen.findByRole('region', { name: 'Unsaved changes' })).toBeTruthy()
    expect(screen.getAllByText('Name is required.').length).toBeGreaterThan(0)
  })
})
