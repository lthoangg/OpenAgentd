import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { setupServer } from '@/__tests__/msw'
import type { ReactNode } from 'react'

import { ToastStack } from '@/components/ToastStack'
import { useToastStore } from '@/stores/useToastStore'
import { useSettingsStore } from '@/stores/useSettingsStore'

mock.module('@tanstack/react-router', () => ({
  Link: ({ children }: { children: ReactNode }) => children,
  useNavigate: () => mock(() => undefined),
}))

import { McpServerDetailPage } from '@/components/settings/pages/settings.mcp.$name'

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

function renderPage(name = 'filesystem') {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  })

  return render(
    <QueryClientProvider client={queryClient}>
      <McpServerDetailPage name={name} onBack={() => {}} />
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

    expect(screen.getByRole('radiogroup', { name: /server status/i })).toBeTruthy()
    expect(screen.getByRole('radiogroup', { name: /mcp transport/i })).toBeTruthy()
    expect(screen.getByPlaceholderText('npx')).toBeTruthy()
    expect(screen.getByRole('button', { name: /add environment variables/i })).toBeTruthy()
    expect(screen.getByRole('button', { name: /remove root/i })).toBeTruthy()
    expect(screen.getByRole('button', { name: /restart server/i })).toBeTruthy()
    expect(screen.getByRole('button', { name: /delete server/i })).toBeTruthy()
  })

  it('saves and discards through the shared save bar, with no Save or Discard changes… of its own', async () => {
    server.use(
      http.get('http://localhost/api/mcp/servers/filesystem', () => HttpResponse.json({
        name: 'filesystem',
        transport: 'stdio',
        enabled: true,
        state: 'ready',
        error: null,
        tool_names: [],
        started_at: null,
        config: { transport: 'stdio', command: 'npx', args: ['-y', 'server'], env: {}, enabled: true },
      })),
    )

    renderPage()
    const command = (await screen.findByPlaceholderText('npx')) as HTMLInputElement

    // Nothing to save yet: no bar, no header Save, no inline discard.
    expect(screen.queryByRole('region', { name: 'Unsaved changes' })).toBeNull()
    expect(screen.queryByRole('button', { name: /^save$/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /discard/i })).toBeNull()

    fireEvent.change(command, { target: { value: 'node' } })
    const bar = await screen.findByRole('region', { name: 'Unsaved changes' })
    expect(screen.getAllByRole('button', { name: /^save$/i })).toHaveLength(1)
    expect(screen.getAllByRole('button', { name: /discard/i })).toHaveLength(1)
    expect(bar.contains(screen.getByRole('button', { name: /^save$/i }))).toBe(true)

    // Discard… asks first, then puts the saved command back.
    fireEvent.click(screen.getByRole('button', { name: 'Discard…' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Discard changes' }))
    expect(((await screen.findByPlaceholderText('npx')) as HTMLInputElement).value).toBe('npx')
    expect(screen.queryByRole('region', { name: 'Unsaved changes' })).toBeNull()
  })
})

describe('McpServerDetailPage — a server from a plugin', () => {
  const PLUGIN_SERVER = {
    name: 'changelog-tools/github',
    transport: 'stdio',
    enabled: true,
    state: 'ready',
    error: null,
    tool_names: ['create_issue'],
    started_at: null,
    plugin: 'changelog-tools',
    config: { transport: 'stdio', command: 'npx', args: ['-y', '@example/github-mcp'], env: {}, enabled: true },
  }
  let requests: { method: string; path: string }[] = []

  /** Answers every server request with `body`, and records the paths asked for. */
  function serveServer(body: Record<string, unknown> = PLUGIN_SERVER) {
    requests = []
    server.use(
      http.get('http://localhost/api/mcp/servers/:name', ({ request }) => {
        requests.push({ method: 'GET', path: new URL(request.url).pathname })
        return HttpResponse.json(body)
      }),
      http.post('http://localhost/api/mcp/servers/:name/restart', ({ request }) => {
        requests.push({ method: 'POST', path: new URL(request.url).pathname })
        return HttpResponse.json(body)
      }),
    )
  }

  afterEach(() => {
    useSettingsStore.setState({ section: 'general', selectedName: null })
  })

  it('asks for the server by its URL-encoded name, since the name holds a slash', async () => {
    serveServer()
    renderPage('changelog-tools/github')

    expect(await screen.findByText('from changelog-tools')).toBeTruthy()
    expect(requests[0]).toEqual({ method: 'GET', path: '/api/mcp/servers/changelog-tools%2Fgithub' })
  })

  it('says which plugin the server comes from, in the status card', async () => {
    serveServer()
    renderPage('changelog-tools/github')

    const label = await screen.findByText('from changelog-tools')
    expect(label.closest('[data-slot="chip"]')?.getAttribute('data-tone')).toBe('neutral')
    expect(screen.getByText('Source')).toBeTruthy()
  })

  it('has no form to edit, no Save and no Delete', async () => {
    serveServer()
    renderPage('changelog-tools/github')
    await screen.findByText('from changelog-tools')

    expect(screen.queryByRole('radiogroup', { name: /server status/i })).toBeNull()
    expect(screen.queryByRole('radiogroup', { name: /mcp transport/i })).toBeNull()
    expect(screen.queryByPlaceholderText('npx')).toBeNull()
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(screen.queryByRole('button', { name: /delete server/i })).toBeNull()
    expect(screen.queryByText('Delete server')).toBeNull()
    expect(screen.queryByRole('button', { name: /^save$/i })).toBeNull()
    expect(screen.queryByRole('region', { name: 'Unsaved changes' })).toBeNull()
    // The header does not name mcp.json as the file: the plugin owns the server.
    expect(screen.queryByText('.openagentd/config/mcp.json')).toBeNull()
  })

  it('shows what it runs, and says the plugin owns it', async () => {
    serveServer()
    renderPage('changelog-tools/github')

    const command = await screen.findByText('npx -y @example/github-mcp')
    expect(command.tagName).toBe('CODE')
    expect(screen.getByText("Defined by the plugin changelog-tools. It can't be edited here.")).toBeTruthy()
  })

  it('shows an HTTP server\'s URL', async () => {
    serveServer({
      ...PLUGIN_SERVER,
      transport: 'http',
      config: { transport: 'http', url: 'https://mcp.example.com/v1', headers: {}, enabled: true },
    })
    renderPage('changelog-tools/github')

    expect((await screen.findByText('https://mcp.example.com/v1')).tagName).toBe('CODE')
    expect(screen.getByText('URL')).toBeTruthy()
  })

  it('shows an sse server\'s URL and its transport', async () => {
    serveServer({
      ...PLUGIN_SERVER,
      transport: 'sse',
      config: { transport: 'sse', url: 'https://mcp.example.com/sse', headers: {}, enabled: true },
    })
    renderPage('changelog-tools/github')

    expect((await screen.findByText('https://mcp.example.com/sse')).tagName).toBe('CODE')
    expect(screen.getByText('URL')).toBeTruthy()
    expect(screen.getByText('sse')).toBeTruthy()
  })

  it('offers Sign in for a plugin server that needs it', async () => {
    serveServer({
      ...PLUGIN_SERVER,
      transport: 'http',
      state: 'auth_required',
      config: { transport: 'http', url: 'https://mcp.example.com/v1', headers: {}, oauth: null, enabled: true },
    })
    renderPage('changelog-tools/github')

    expect(await screen.findByRole('button', { name: 'Sign in' })).toBeTruthy()
  })

  it('copes with a server whose config the server did not send', async () => {
    serveServer({ ...PLUGIN_SERVER, config: null })
    renderPage('changelog-tools/github')

    expect(await screen.findByText("Defined by the plugin changelog-tools. It can't be edited here.")).toBeTruthy()
    expect(screen.queryByText('Command')).toBeNull()
    expect(screen.getByRole('button', { name: /restart server/i })).toBeTruthy()
  })

  it('keeps Restart, which goes through the encoded path too', async () => {
    serveServer()
    renderPage('changelog-tools/github')

    fireEvent.click(await screen.findByRole('button', { name: /restart server/i }))

    await waitFor(() => expect(requests.some((r) => r.method === 'POST')).toBe(true))
    expect(requests.find((r) => r.method === 'POST')?.path).toBe('/api/mcp/servers/changelog-tools%2Fgithub/restart')
    expect(await screen.findByText('Restarted "changelog-tools/github"')).toBeTruthy()
  })

  it('sends you to Plugins to turn it on or off', async () => {
    serveServer()
    renderPage('changelog-tools/github')
    useSettingsStore.setState({ section: 'mcp-edit', selectedName: 'changelog-tools/github' })

    fireEvent.click(await screen.findByRole('button', { name: 'Open Plugins' }))

    expect(useSettingsStore.getState().section).toBe('plugins')
  })

  it('points to Plugins, not to Save, when an off server needs sign-in', async () => {
    serveServer({ ...PLUGIN_SERVER, enabled: false, state: 'auth_required' })
    renderPage('changelog-tools/github')

    expect(await screen.findByText('Turn the plugin on in Plugins before you sign in.')).toBeTruthy()
    expect(screen.getByText('Turn the plugin on in Plugins first.')).toBeTruthy()
    expect((screen.getByRole('button', { name: /restart server/i }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('still shows the form and Delete for a server saved in mcp.json', async () => {
    serveServer({ ...PLUGIN_SERVER, name: 'filesystem', plugin: null })
    renderPage('filesystem')

    expect(await screen.findByPlaceholderText('npx')).toBeTruthy()
    expect(screen.getByRole('button', { name: /delete server/i })).toBeTruthy()
    expect(screen.queryByText('Source')).toBeNull()
    expect(screen.getByText('.openagentd/config/mcp.json')).toBeTruthy()
  })
})
