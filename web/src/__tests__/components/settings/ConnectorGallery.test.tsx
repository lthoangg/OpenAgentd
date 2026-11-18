/**
 * The connector gallery: only connectors not added yet, as tiles whose
 * action says what each takes. Free ones turn on with a switch, account
 * ones add and sign in, key ones take a key. Asserts on what renders and
 * what is sent.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { setupServer } from '@/__tests__/msw'

mock.module('lucide-react', () => new Proxy({}, { get: () => () => null }))

import { ConnectorGallery } from '@/components/settings/ConnectorGallery'
import { ConnectorSignInsProvider } from '@/components/settings/connectorSignIns'
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

const LOGO = { path: 'M24 0V24H0V0Z', view_box: '0 0 24 24' }

const ENTRIES: GalleryEntry[] = [
  { type: 'connector', id: 'context7', name: 'Context7', category: 'docs', description: 'Library docs.', url: 'https://mcp.context7.com/mcp', auth: 'none', server: null, update_for: null },
  { type: 'connector', id: 'deepwiki', name: 'DeepWiki', category: 'docs', description: 'Repo Q&A.', url: 'https://mcp.deepwiki.com/mcp', auth: 'none', server: status({ name: 'deepwiki' }), update_for: null },
  { type: 'connector', id: 'notion', name: 'Notion', category: 'work', description: 'Pages.', url: 'https://mcp.notion.com/mcp', auth: 'oauth', icon: LOGO, server: null, update_for: null },
  { type: 'connector', id: 'github', name: 'GitHub', category: 'dev', description: 'Repos.', url: 'https://api.githubcopilot.com/mcp/', auth: { header: 'Authorization', template: 'Bearer {key}', key_url: 'https://github.com/settings/tokens', key_label: 'Personal access token' }, server: null, update_for: null },
  { type: 'connector', id: 'linear', name: 'Linear', category: 'work', description: 'Issues.', url: 'https://mcp.linear.app/mcp', auth: 'oauth', server: null, update_for: 'linear-old' },
]

function serveGallery(entries = ENTRIES) {
  server.use(http.get('http://localhost/api/mcp/gallery', () => HttpResponse.json({ source: 'cloud', entries })))
}

function renderGallery(query = '') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <ConnectorSignInsProvider>
        <ConnectorGallery query={query} />
      </ConnectorSignInsProvider>
    </QueryClientProvider>,
  )
}

const tile = (id: string) => document.querySelector(`[data-connector="${id}"]`) as HTMLElement

describe('ConnectorGallery', () => {
  it('lists only connectors not added yet, each with the action it takes', async () => {
    serveGallery()
    renderGallery()
    await screen.findByText('Context7')
    expect(screen.getByRole('heading', { name: 'Add a connector' })).toBeTruthy()
    expect(tile('deepwiki')).toBeNull()
    expect(screen.queryByText('DeepWiki')).toBeNull()
    expect(within(tile('context7')).getByRole('switch', { name: 'Turn on Context7' })).toBeTruthy()
    expect(within(tile('notion')).getByRole('button', { name: 'Connect' })).toBeTruthy()
    expect(within(tile('github')).getByRole('button', { name: 'Set up' })).toBeTruthy()
    expect(within(tile('linear')).getByRole('button', { name: 'Update' })).toBeTruthy()
    // No grouping by sign-in kind: the action says it.
    expect(screen.queryByRole('heading', { name: 'Free · just turn on' })).toBeNull()
  })

  it('shows the logo when the entry has one, else the monogram', async () => {
    serveGallery()
    renderGallery()
    await screen.findByText('Notion')
    expect(tile('notion').querySelector('[data-connector-icon="logo"] path')?.getAttribute('d')).toBe(LOGO.path)
    expect(tile('context7').querySelector('[data-connector-icon="monogram"]')?.textContent).toBe('CO')
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
    await userEvent.click(within(tile('context7')).getByRole('switch', { name: 'Turn on Context7' }))
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
      http.get('http://localhost/api/mcp/servers', () => HttpResponse.json({ servers: [] })),
    )
    renderGallery()
    await screen.findByText('Notion')
    await userEvent.click(within(tile('notion')).getByRole('button', { name: 'Connect' }))
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
    await userEvent.click(within(tile('github')).getByRole('button', { name: 'Set up' }))
    expect(within(tile('github')).getByRole('link', { name: 'Get a key' }).getAttribute('href')).toBe('https://github.com/settings/tokens')
    await userEvent.type(within(tile('github')).getByLabelText('Personal access token'), 'ghp_x')
    await userEvent.click(within(tile('github')).getByRole('button', { name: 'Turn on' }))
    await waitFor(() => expect(sent).toEqual({ key: 'ghp_x' }))
  })

  it('filters by the page\'s search', async () => {
    serveGallery()
    renderGallery('notio')
    await screen.findByText('Notion')
    expect(screen.queryByText('Context7')).toBeNull()
  })

  it('filters by category', async () => {
    serveGallery()
    renderGallery()
    await screen.findByText('Context7')
    await userEvent.click(within(screen.getByRole('group', { name: 'Category' })).getByRole('button', { name: 'Work' }))
    expect(screen.queryByText('Context7')).toBeNull()
    expect(screen.getByText('Notion')).toBeTruthy()
  })

  it('leaves the section out when the search matches none of it', async () => {
    serveGallery()
    renderGallery('zzz')
    await waitFor(() => expect(screen.queryByRole('status', { name: 'Loading the gallery' })).toBeNull())
    expect(screen.queryByRole('heading', { name: 'Add a connector' })).toBeNull()
  })
})
