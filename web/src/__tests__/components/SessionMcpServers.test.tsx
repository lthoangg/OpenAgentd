/**
 * SessionMcpServers — the MCP section of the session settings panel.
 *
 * These tests drive the section that replaced the old tool-browser: one row
 * per MCP server the current agent declares, with status, enable/disable, and
 * OAuth connect. They assert on rendered outcome and on the requests the
 * component actually issues, never on mutation internals.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { delay, http, HttpResponse } from 'msw'
import { setupServer } from '@/__tests__/msw'

mock.module('lucide-react', () => new Proxy({}, { get: () => () => null }))

import { SessionMcpServers } from '@/components/SessionMcpServers'
import type { ServerStatus } from '@/api/client'

const server = setupServer()
let originalFetch: typeof fetch | undefined

beforeEach(() => {
  server.listen({ onUnhandledFrame: 'error' })
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
    expect(within(github).getByText('Ready · 2 tools')).toBeTruthy()

    const postgres = row('postgres')
    expect(within(postgres).getByText('Off')).toBeTruthy()
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

  it('flips the switch as soon as it is pressed, before the server answers', async () => {
    mockServerList([makeServer({ name: 'github', enabled: true })])
    server.use(
      http.put('http://localhost/api/mcp/servers/github', async () => {
        await delay('infinite')
        return HttpResponse.json(makeServer({ name: 'github', enabled: false }))
      }),
    )

    renderSection({ agentServers: ['github'] })

    await waitFor(() => row('github'))
    await userEvent.click(within(row('github')).getByRole('switch'))

    await waitFor(() => expect(within(row('github')).getByRole('switch').getAttribute('aria-checked')).toBe('false'))
    expect(within(row('github')).getByText('Off')).toBeTruthy()
    expect(row('github').getAttribute('aria-busy')).toBe('true')
  })

  it('puts the switch back when the server refuses the change', async () => {
    mockServerList([makeServer({ name: 'github', enabled: true })])
    server.use(
      http.put('http://localhost/api/mcp/servers/github', () =>
        HttpResponse.json({ detail: 'mcp.json is read-only' }, { status: 500 }),
      ),
    )

    renderSection({ agentServers: ['github'] })

    await waitFor(() => row('github'))
    await userEvent.click(within(row('github')).getByRole('switch'))

    await waitFor(() => expect(row('github').getAttribute('aria-busy')).toBeNull())
    expect(within(row('github')).getByRole('switch').getAttribute('aria-checked')).toBe('true')
  })

  it('offers one action per row: sign in when asked, reconnect when failed', async () => {
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
        state: 'error',
        error: 'token expired',
        config: HTTP_OAUTH_CONFIG,
      }),
      makeServer({
        name: 'asana',
        transport: 'http',
        state: 'ready',
        config: HTTP_OAUTH_CONFIG,
      }),
      makeServer({ name: 'github', state: 'ready' }),
    ])

    renderSection({ agentServers: ['linear', 'notion', 'asana', 'github'] })

    const linear = await waitFor(() => row('linear'))
    expect(within(linear).getByText('Needs sign-in')).toBeTruthy()
    expect(within(linear).getByRole('button', { name: 'Sign in' })).toBeTruthy()
    expect(within(row('notion')).getByRole('button', { name: 'Reconnect' })).toBeTruthy()
    // A working server needs nothing.
    expect(within(row('asana')).queryByRole('button')).toBeNull()
    // stdio server: nothing to authorize.
    expect(within(row('github')).queryByRole('button')).toBeNull()
  })

  it('offers Sign in to an http server that has no oauth block, since the server finds out how on a 401', async () => {
    mockServerList([
      makeServer({
        name: 'plain',
        transport: 'http',
        state: 'auth_required',
        config: { transport: 'http', url: 'https://mcp.example.com/mcp', headers: {}, enabled: true },
      }),
    ])

    renderSection({ agentServers: ['plain'] })

    const plain = await waitFor(() => row('plain'))
    expect(within(plain).getByRole('button', { name: 'Sign in' })).toBeTruthy()
  })

  it('offers Sign in to an sse server that needs it', async () => {
    mockServerList([
      makeServer({
        name: 'legacy',
        transport: 'sse',
        state: 'auth_required',
        config: { transport: 'sse', url: 'https://mcp.example.com/sse', headers: {}, enabled: true },
      }),
    ])

    renderSection({ agentServers: ['legacy'] })

    const legacy = await waitFor(() => row('legacy'))
    expect(within(legacy).getByRole('button', { name: 'Sign in' })).toBeTruthy()
  })

  it('offers Sign in to a plugin server that needs it, whatever its config says', async () => {
    mockServerList([
      makeServer({
        name: 'changelog-tools/remote',
        plugin: 'changelog-tools',
        transport: 'http',
        state: 'auth_required',
        config: { transport: 'http', url: 'https://mcp.example.com/mcp', headers: {}, oauth: null, enabled: true },
      }),
    ])

    renderSection({ agentServers: ['changelog-tools/remote'] })

    const remote = await waitFor(() => screen.getByRole('listitem', { name: 'changelog-tools/remote' }))
    expect(within(remote).getByRole('button', { name: 'Sign in' })).toBeTruthy()
  })

  it('does not offer Reconnect to a failed http server without an oauth block', async () => {
    mockServerList([
      makeServer({
        name: 'plain',
        transport: 'http',
        state: 'error',
        error: 'connection refused',
        config: { transport: 'http', url: 'https://mcp.example.com/mcp', headers: {}, enabled: true },
      }),
    ])

    renderSection({ agentServers: ['plain'] })

    const plain = await waitFor(() => row('plain'))
    expect(within(plain).queryByRole('button')).toBeNull()
  })

  it('offers no connect action while the server is off', async () => {
    mockServerList([
      makeServer({
        name: 'linear',
        transport: 'http',
        enabled: false,
        state: 'error',
        config: HTTP_OAUTH_CONFIG,
      }),
    ])

    renderSection({ agentServers: ['linear'] })

    const linear = await waitFor(() => row('linear'))
    expect(within(linear).getByText('Off')).toBeTruthy()
    expect(within(linear).queryByRole('button')).toBeNull()
  })

  it('starts the sign-in when connect is pressed', async () => {
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
      http.post('http://localhost/api/mcp/servers/linear/oauth/start', () => {
        connectCalled = true
        return HttpResponse.json({ status: 'done', server: { name: 'linear', state: 'ready' } })
      }),
    )

    renderSection({ agentServers: ['linear'] })

    const linear = await waitFor(() => row('linear'))
    await userEvent.click(within(linear).getByRole('button', { name: 'Sign in' }))

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

    expect(await screen.findByRole('status', { name: 'Loading connectors' })).toBeTruthy()
  })

  it('explains the empty case when the agent declares no servers', async () => {
    mockServerList([makeServer({ name: 'github' })])

    renderSection({ agentServers: [] })

    expect(await screen.findByText(/^No connectors for this agent\./)).toBeTruthy()
  })

  it('reports a failure to load the server list', async () => {
    server.use(
      http.get('http://localhost/api/mcp/servers', () =>
        HttpResponse.json({ detail: 'boom' }, { status: 500 }),
      ),
    )

    renderSection({ agentServers: ['github'] })

    expect(await screen.findByText("Couldn't load connectors.")).toBeTruthy()
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

  it('leaves a plugin\'s server to its plugin: the switch is off limits, and says where to go', async () => {
    mockServerList([makeServer({ name: 'changelog-tools/github', plugin: 'changelog-tools' })])

    renderSection({ agentServers: ['changelog-tools/github'] })

    const row = await waitFor(() => screen.getByRole('listitem', { name: 'changelog-tools/github' }))
    const toggle = within(row).getByRole('switch') as HTMLButtonElement
    expect(toggle.disabled).toBe(true)
    expect(toggle.getAttribute('title')).toBe('From the plugin changelog-tools. Turn it on or off in Plugins.')
    // It still shows how the server is doing.
    expect(within(row).getByText('Ready')).toBeTruthy()
  })

  it('keeps the usual switch for a server saved in mcp.json, even beside a plugin\'s', async () => {
    mockServerList([
      makeServer({ name: 'github' }),
      makeServer({ name: 'changelog-tools/github', plugin: 'changelog-tools' }),
    ])

    renderSection({ agentServers: ['github', 'changelog-tools/github'] })

    const github = await waitFor(() => row('^github$'))
    expect((within(github).getByRole('switch') as HTMLButtonElement).disabled).toBe(false)
    expect(within(github).getByRole('switch').getAttribute('title')).toBe('On or off for every session')
  })

  it('flags a server the agent declares but mcp.json does not define', async () => {
    mockServerList([])

    renderSection({ agentServers: ['ghost'] })

    const ghost = await waitFor(() => row('ghost'))
    expect(within(ghost).getByText(/not configured/i)).toBeTruthy()
  })

  it('ignores servers that are not declared by the current agent', async () => {
    mockServerList([
      makeServer({ name: 'github' }),
      makeServer({ name: 'figma' }),
    ])

    renderSection({ agentServers: ['github'] })

    await waitFor(() => row('github'))
    expect(screen.queryByRole('listitem', { name: /figma/i })).toBeNull()
  })
})

describe('SessionMcpServers — servers from the project', () => {
  const WS = '/repo/app'
  const KEY = 'db@0123456789'

  function projectServer(overrides: Partial<ServerStatus> = {}): ServerStatus {
    return makeServer({
      name: KEY,
      state: 'needs_approval',
      project: { workspace: WS, name: 'db' },
      config: { transport: 'stdio', command: './db-mcp', args: ['--ro'], env: {}, enabled: true },
      ...overrides,
    })
  }

  function mockWorkspaceList(servers: ServerStatus[], extra: Record<string, unknown> = {}) {
    let asked: string | null = null
    server.use(
      http.get('http://localhost/api/mcp/servers', ({ request }) => {
        asked = new URL(request.url).searchParams.get('workspace')
        return HttpResponse.json({ servers, ...extra })
      }),
    )
    return () => asked
  }

  it('lists the project servers of the workspace by their own name, needing approval', async () => {
    const asked = mockWorkspaceList([makeServer({ name: 'github' }), projectServer()])

    renderSection({ agentServers: ['github'], workspace: WS })

    const db = await waitFor(() => row('db'))
    expect(asked()).toBe(WS)
    expect(within(db).getByText('Needs approval')).toBeTruthy()
    expect(within(db).getByText('from this project')).toBeTruthy()
    expect(within(db).queryByText(KEY)).toBeNull()
    expect(within(db).queryByRole('switch')).toBeNull()
    expect(row('github')).toBeTruthy()
  })

  it('approves a project server with Allow', async () => {
    mockWorkspaceList([projectServer()])
    let approved: string | null = null
    server.use(
      http.post('http://localhost/api/mcp/servers/:name/approve', ({ params }) => {
        approved = String(params.name)
        return HttpResponse.json(projectServer({ state: 'ready' }))
      }),
    )

    renderSection({ agentServers: [], workspace: WS })

    await userEvent.click(await waitFor(() => within(row('db')).getByRole('button', { name: 'Allow' })))
    await waitFor(() => expect(approved).toBe(KEY))
  })

  it('revokes an approved project server', async () => {
    mockWorkspaceList([projectServer({ state: 'ready', tool_names: ['db_query'] })])
    let revoked: string | null = null
    server.use(
      http.post('http://localhost/api/mcp/servers/:name/revoke', ({ params }) => {
        revoked = String(params.name)
        return HttpResponse.json(projectServer())
      }),
    )

    renderSection({ agentServers: [], workspace: WS })

    const db = await waitFor(() => row('db'))
    expect(within(db).getByText('Ready · 1 tool')).toBeTruthy()
    await userEvent.click(within(db).getByRole('button', { name: 'Revoke' }))
    await waitFor(() => expect(revoked).toBe(KEY))
  })

  it('shows only the project server where it replaces a server of the same name', async () => {
    mockWorkspaceList([makeServer({ name: 'db', tool_names: ['global_query'] }), projectServer()])

    renderSection({ agentServers: ['db'], workspace: WS })

    await waitFor(() => row('db'))
    expect(screen.getAllByRole('listitem', { name: /db/i })).toHaveLength(1)
    expect(within(row('db')).getByText('from this project')).toBeTruthy()
  })

  it('says why the project file cannot be used', async () => {
    mockWorkspaceList([], { project_error: '/repo/app/.agents/mcp.json: Invalid JSON' })

    renderSection({ agentServers: [], workspace: WS })

    expect(await screen.findByText(/Invalid JSON/)).toBeTruthy()
  })

  it('asks again each time it opens, since the project file may have changed', async () => {
    let calls = 0
    server.use(
      http.get('http://localhost/api/mcp/servers', () => {
        calls += 1
        return HttpResponse.json({ servers: [projectServer({ state: calls === 1 ? 'ready' : 'needs_approval' })] })
      }),
    )
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const open = () => render(
      <QueryClientProvider client={queryClient}>
        <SessionMcpServers agentServers={[]} workspace={WS} />
      </QueryClientProvider>,
    )

    const first = open()
    expect(await within(await waitFor(() => row('db'))).findByText('Ready')).toBeTruthy()
    first.unmount()
    open()
    expect(await within(await waitFor(() => row('db'))).findByText('Needs approval')).toBeTruthy()
    expect(calls).toBe(2)
  })
})
