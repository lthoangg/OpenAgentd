/**
 * The connector gallery: free connectors turn on with a switch, account
 * connectors turn on and sign in, key connectors take a key, and added
 * ones show their state. Asserts on what renders and what is sent.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { setupServer } from '@/__tests__/msw'

mock.module('lucide-react', () => new Proxy({}, { get: () => () => null }))

import { ConnectorGallery } from '@/components/settings/ConnectorGallery'
import type { GalleryEntry, ServerStatus } from '@/api/client'

const server = setupServer()
let originalFetch: typeof fetch | undefined
let originalOpen: typeof window.open

beforeEach(() => {
  server.listen({ onUnhandledFrame: 'error' })
  originalFetch = globalThis.fetch
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
    originalFetch!(typeof input === 'string' && input.startsWith('/') ? `http://localhost${input}` : input, init)) as typeof fetch
  originalOpen = window.open
  window.open = (() => null) as unknown as typeof window.open
})

afterEach(() => {
  cleanup()
  server.resetHandlers()
  server.close()
  if (originalFetch) globalThis.fetch = originalFetch
  window.open = originalOpen
})

function status(over: Partial<ServerStatus> & { name: string }): ServerStatus {
  return {
    transport: 'http', enabled: true, state: 'ready', error: null, tool_names: ['a', 'b'], started_at: null,
    config: { transport: 'http', url: 'https://x.example/mcp', headers: {}, enabled: true },
    ...over,
  } as ServerStatus
}

const ENTRIES: GalleryEntry[] = [
  { type: 'connector', id: 'context7', name: 'Context7', category: 'docs', description: 'Library docs.', url: 'https://mcp.context7.com/mcp', auth: 'none', server: null, update_for: null },
  { type: 'connector', id: 'deepwiki', name: 'DeepWiki', category: 'docs', description: 'Repo Q&A.', url: 'https://mcp.deepwiki.com/mcp', auth: 'none', server: status({ name: 'deepwiki' }), update_for: null },
  { type: 'connector', id: 'notion', name: 'Notion', category: 'work', description: 'Pages.', url: 'https://mcp.notion.com/mcp', auth: 'oauth', server: null, update_for: null },
  { type: 'connector', id: 'github', name: 'GitHub', category: 'dev', description: 'Repos.', url: 'https://api.githubcopilot.com/mcp/', auth: { header: 'Authorization', template: 'Bearer {key}', key_url: 'https://github.com/settings/tokens', key_label: 'Personal access token' }, server: null, update_for: null },
]

function serveGallery(entries = ENTRIES) {
  server.use(http.get('http://localhost/api/mcp/gallery', () => HttpResponse.json({ source: 'cloud', entries })))
}

function renderGallery(onOpen: (name: string) => void = () => {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return render(<QueryClientProvider client={client}><ConnectorGallery onOpen={onOpen} /></QueryClientProvider>)
}

const card = (id: string) => document.querySelector(`[data-connector="${id}"]`) as HTMLElement

describe('ConnectorGallery', () => {
  it('groups connectors by how they connect, and says what each costs before the click', async () => {
    serveGallery()
    renderGallery()
    await screen.findByText('Context7')
    expect(screen.getByRole('heading', { name: 'Free · just turn on' })).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Sign in with your account' })).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Paste a key' })).toBeTruthy()
    expect(within(card('context7')).getByText('Free · no account')).toBeTruthy()
    expect(within(card('deepwiki')).getByText('Ready · 2 tools')).toBeTruthy()
    expect(within(card('notion')).getByRole('button', { name: 'Connect' })).toBeTruthy()
  })

  it('turns a free connector on with its switch', async () => {
    serveGallery()
    let enabled: string | null = null
    server.use(http.post('http://localhost/api/mcp/gallery/:id/enable', ({ params }) => {
      enabled = String(params.id)
      return HttpResponse.json(status({ name: 'context7' }), { status: 201 })
    }))
    renderGallery()
    await screen.findByText('Context7')
    await userEvent.click(within(card('context7')).getByRole('switch', { name: 'Turn on Context7' }))
    await waitFor(() => expect(enabled).toBe('context7'))
  })

  it('adds an account connector and starts its sign-in from one click', async () => {
    serveGallery()
    const calls: string[] = []
    server.use(
      http.post('http://localhost/api/mcp/gallery/notion/enable', () => {
        calls.push('enable')
        return HttpResponse.json(status({ name: 'notion', state: 'auth_required' }), { status: 201 })
      }),
      http.post('http://localhost/api/mcp/servers/notion/oauth/start', () => {
        calls.push('start')
        return HttpResponse.json({ status: 'done', server: status({ name: 'notion' }) })
      }),
    )
    renderGallery()
    await screen.findByText('Notion')
    await userEvent.click(within(card('notion')).getByRole('button', { name: 'Connect' }))
    await waitFor(() => expect(calls).toEqual(['enable', 'start']))
  })

  it('takes a key for a key connector', async () => {
    serveGallery()
    let sent: unknown = null
    server.use(http.post('http://localhost/api/mcp/gallery/github/enable', async ({ request }) => {
      sent = await request.json()
      return HttpResponse.json(status({ name: 'github' }), { status: 201 })
    }))
    renderGallery()
    await screen.findByText('GitHub')
    await userEvent.click(within(card('github')).getByRole('button', { name: 'Set up' }))
    expect(within(card('github')).getByRole('link', { name: 'Get a key' }).getAttribute('href')).toBe('https://github.com/settings/tokens')
    await userEvent.type(within(card('github')).getByLabelText('Personal access token'), 'ghp_x')
    await userEvent.click(within(card('github')).getByRole('button', { name: 'Turn on' }))
    await waitFor(() => expect(sent).toEqual({ key: 'ghp_x' }))
  })

  it('filters by name and category', async () => {
    serveGallery()
    renderGallery()
    await screen.findByText('Context7')
    await userEvent.type(screen.getByLabelText('Search the gallery'), 'wiki')
    expect(screen.queryByText('Context7')).toBeNull()
    expect(screen.getByText('DeepWiki')).toBeTruthy()
  })

  it('opens an added connector by its name', async () => {
    serveGallery()
    const opened: string[] = []
    renderGallery((n) => opened.push(n))
    await userEvent.click(await screen.findByRole('button', { name: 'DeepWiki' }))
    expect(opened).toEqual(['deepwiki'])
  })
})
