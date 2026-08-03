/**
 * SessionMcpServers — the MCP section of the session settings panel.
 *
 * These tests drive the section that replaced the old tool-browser: one row
 * per MCP server the lead agent declares, with status, enable/disable, and
 * OAuth connect. They assert on rendered outcome and on the requests the
 * component actually issues, never on mutation internals.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { delay, http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'

mock.module('lucide-react', () => new Proxy({}, { get: () => () => null }))

import { SessionMcpServers } from '@/components/SessionMcpServers'
import type { ServerStatus } from '@/api/client'

const server = setupServer()
let originalFetch: typeof fetch | undefined

beforeEach(() => {
  server.listen({ onUnhandledRequest: 'error' })
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
  if (originalFetch) globalThis.fetch = originalFetch
  originalFetch = undefined
  server.close()
})

/** An HTTP server wired for OAuth — the only shape that gets a Connect button. */
const HTTP_OAUTH_CONFIG = {
  transport: 'http',
  url: 'https://mcp.linear.app/sse',
  headers: {},
  oauth: { client_id: 'oad-local' },
  enabled: true,
} as const

function makeServer(overrides: Partial<ServerStatus> & { name: string }): ServerStatus {
  return {
    transport: 'stdio',
    enabled: true,
    state: 'ready',
    error: null,
    tool_names: [],
    started_at: null,
    config: { transport: 'stdio', command: 'npx', args: [], env: {}, enabled: true },
    ...overrides,
  } as ServerStatus
}

function mockServerList(servers: ServerStatus[]) {
  server.use(
    http.get('http://localhost/api/mcp/servers', () => HttpResponse.json({ servers })),
  )
}

function renderSection(props: Partial<Parameters<typeof SessionMcpServers>[0]> = {}) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return render(
    <QueryClientProvider client={queryClient}>
      <SessionMcpServers agentServers={props.agentServers ?? []} {...props} />
    </QueryClientProvider>,
  )
}

/** The row element for a server, scoped so per-row assertions can't leak. */
function row(name: string) {
  return screen.getByRole('listitem', { name: new RegExp(name, 'i') })
}

describe('SessionMcpServers', () => {
  it('renders one row per declared server with its state and tool count', async () => {
    mockServerList([
      makeServer({ name: 'github', state: 'ready', tool_names: ['gh_issues', 'gh_prs'] }),
      makeServer({ name: 'postgres', enabled: false, state: 'stopped' }),
    ])

    renderSection({ agentServers: ['github', 'postgres'] })

    const github = await waitFor(() => row('github'))
    expect(within(github).getByText(/ready/i)).toBeTruthy()
    expect(within(github).getByText(/2 tools/i)).toBeTruthy()

    const postgres = row('postgres')
    expect(within(postgres).getByText(/disabled/i)).toBeTruthy()
  })

  it('reflects enabled state on each row switch', async () => {
    mockServerList([
      makeServer({ name: 'github', enabled: true }),
      makeServer({ name: 'postgres', enabled: false, state: 'stopped' }),
    ])

    renderSection({ agentServers: ['github', 'postgres'] })

    await waitFor(() => row('github'))
    expect(within(row('github')).getByRole('switch').getAttribute('aria-checked')).toBe('true')
    expect(within(row('postgres')).getByRole('switch').getAttribute('aria-checked')).toBe('false')
  })

  it('disables a server through its switch', async () => {
    mockServerList([makeServer({ name: 'github', enabled: true })])
    let body: { server?: { enabled?: boolean } } | null = null
    server.use(
      http.put('http://localhost/api/mcp/servers/github', async ({ request }) => {
        body = (await request.json()) as { server?: { enabled?: boolean } }
        return HttpResponse.json(makeServer({ name: 'github', enabled: false, state: 'stopped' }))
      }),
    )

    renderSection({ agentServers: ['github'] })

    await waitFor(() => row('github'))
    await userEvent.click(within(row('github')).getByRole('switch'))

    await waitFor(() => expect(body).not.toBeNull())
    expect(body!.server!.enabled).toBe(false)
  })

  it('offers OAuth connect on every HTTP server configured for it', async () => {
    // Not only `auth_required`: re-authorizing a server that is already ready,
    // or retrying one that failed, are both things you do on demand.
    mockServerList([
      makeServer({
        name: 'linear',
        transport: 'http',
        state: 'auth_required',
        config: HTTP_OAUTH_CONFIG,
      }),
      makeServer({
        name: 'notion',
        transport: 'http',
        state: 'ready',
        config: HTTP_OAUTH_CONFIG,
      }),
      makeServer({ name: 'github', state: 'ready' }),
    ])

    renderSection({ agentServers: ['linear', 'notion', 'github'] })

    const linear = await waitFor(() => row('linear'))
    expect(within(linear).getByRole('button', { name: /connect/i })).toBeTruthy()
    expect(within(row('notion')).getByRole('button', { name: /connect/i })).toBeTruthy()
    // stdio server: nothing to authorize.
    expect(within(row('github')).queryByRole('button', { name: /connect/i })).toBeNull()
  })

  it('cannot connect OAuth while the server is disabled', async () => {
    mockServerList([
      makeServer({
        name: 'linear',
        transport: 'http',
        enabled: false,
        state: 'stopped',
        config: HTTP_OAUTH_CONFIG,
      }),
    ])

    renderSection({ agentServers: ['linear'] })

    const linear = await waitFor(() => row('linear'))
    const connect = within(linear).getByRole('button', { name: /connect/i }) as HTMLButtonElement
    expect(connect.disabled).toBe(true)
  })

  it('starts the OAuth flow when connect is pressed', async () => {
    mockServerList([
      makeServer({
        name: 'linear',
        transport: 'http',
        state: 'auth_required',
        config: HTTP_OAUTH_CONFIG,
      }),
    ])
    let connectCalled = false
    server.use(
      http.post('http://localhost/api/mcp/servers/linear/oauth/connect', () => {
        connectCalled = true
        return HttpResponse.json({ name: 'linear', state: 'ready' })
      }),
    )

    renderSection({ agentServers: ['linear'] })

    const linear = await waitFor(() => row('linear'))
    await userEvent.click(within(linear).getByRole('button', { name: /connect/i }))

    await waitFor(() => expect(connectCalled).toBe(true))
  })

  it('shows a shape-matching skeleton while the server list loads', async () => {
    server.use(
      http.get('http://localhost/api/mcp/servers', async () => {
        await delay('infinite')
        return HttpResponse.json({ servers: [] })
      }),
    )

    renderSection({ agentServers: ['github'] })

    expect(await screen.findByRole('status', { name: /loading mcp servers/i })).toBeTruthy()
  })

  it('explains the empty case when the agent declares no servers', async () => {
    mockServerList([makeServer({ name: 'github' })])

    renderSection({ agentServers: [] })

    expect(await screen.findByText(/no mcp servers/i)).toBeTruthy()
  })

  it('reports a failure to load the server list', async () => {
    server.use(
      http.get('http://localhost/api/mcp/servers', () =>
        HttpResponse.json({ detail: 'boom' }, { status: 500 }),
      ),
    )

    renderSection({ agentServers: ['github'] })

    expect(await screen.findByText(/couldn't load mcp servers/i)).toBeTruthy()
  })

  it('marks only the row being toggled as busy', async () => {
    mockServerList([
      makeServer({ name: 'github', enabled: true }),
      makeServer({ name: 'postgres', enabled: true }),
    ])
    server.use(
      http.put('http://localhost/api/mcp/servers/github', async () => {
        await delay('infinite')
        return HttpResponse.json(makeServer({ name: 'github', enabled: false }))
      }),
    )

    renderSection({ agentServers: ['github', 'postgres'] })

    await waitFor(() => row('github'))
    await userEvent.click(within(row('github')).getByRole('switch'))

    await waitFor(() => expect(row('github').getAttribute('aria-busy')).toBe('true'))
    expect((within(row('github')).getByRole('switch') as HTMLButtonElement).disabled).toBe(true)
    expect(row('postgres').getAttribute('aria-busy')).toBeNull()
    expect((within(row('postgres')).getByRole('switch') as HTMLButtonElement).disabled).toBe(false)
  })

  it('shows the failure reason inline on a broken server row', async () => {
    mockServerList([
      makeServer({ name: 'figma', state: 'error', error: 'spawn figma-mcp ENOENT' }),
    ])

    renderSection({ agentServers: ['figma'] })

    const figma = await waitFor(() => row('figma'))
    expect(within(figma).getByText(/spawn figma-mcp ENOENT/)).toBeTruthy()
  })

  it('cannot toggle a server whose config went missing', async () => {
    mockServerList([makeServer({ name: 'github', config: null })])

    renderSection({ agentServers: ['github'] })

    const github = await waitFor(() => row('github'))
    expect((within(github).getByRole('switch') as HTMLButtonElement).disabled).toBe(true)
  })

  it('flags a server the agent declares but mcp.json does not define', async () => {
    mockServerList([])

    renderSection({ agentServers: ['ghost'] })

    const ghost = await waitFor(() => row('ghost'))
    expect(within(ghost).getByText(/not configured/i)).toBeTruthy()
  })

  it('ignores servers that are not declared by the lead agent', async () => {
    mockServerList([
      makeServer({ name: 'github' }),
      makeServer({ name: 'figma' }),
    ])

    renderSection({ agentServers: ['github'] })

    await waitFor(() => row('github'))
    expect(screen.queryByRole('listitem', { name: /figma/i })).toBeNull()
  })
})
