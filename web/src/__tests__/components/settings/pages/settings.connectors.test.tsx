import '@testing-library/jest-dom'

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'

import { setupServer } from '@/__tests__/msw'
import type { GalleryEntry, ServerStatus } from '@/api/client'
import { ConnectorsListPage } from '@/components/settings/pages/settings.connectors'
import { queryKeys } from '@/queries'

const api = setupServer()
let originalFetch: typeof fetch | undefined

beforeEach(() => {
  api.listen({ onUnhandledFrame: 'error' })
  originalFetch = globalThis.fetch
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
    originalFetch!(typeof input === 'string' && input.startsWith('/') ? `http://localhost${input}` : input, init)) as typeof fetch
})

afterEach(() => {
  cleanup()
  api.resetHandlers()
  api.close()
  if (originalFetch) globalThis.fetch = originalFetch
})

function server(name: string, over: Partial<ServerStatus> = {}): ServerStatus {
  return {
    name,
    transport: 'stdio',
    enabled: true,
    state: 'ready',
    error: null,
    tool_names: [],
    started_at: null,
    config: { transport: 'stdio', command: 'npx', args: [], env: {}, enabled: true },
    ...over,
  }
}

const LOGO = { path: 'M24 0V24H0V0Z', view_box: '0 0 24 24' }
const HTTP = { transport: 'http' as const, url: 'https://mcp.notion.com/mcp', headers: {}, enabled: true }
const NOTION = server('notion', { transport: 'http', state: 'auth_required', config: HTTP, gallery: { id: 'notion', name: 'Notion', icon: LOGO } })

const ENTRIES: GalleryEntry[] = [
  { type: 'connector', id: 'notion', name: 'Notion', category: 'work', description: 'Pages and databases.', url: 'https://mcp.notion.com/mcp', auth: 'oauth', icon: LOGO, server: NOTION, update_for: null },
  { type: 'connector', id: 'context7', name: 'Context7', category: 'docs', description: 'Library docs.', url: 'https://mcp.context7.com/mcp', auth: 'none', server: null, update_for: null },
]

function renderList(servers: ServerStatus[], onSelect: (name: string) => void = () => {}, entries: GalleryEntry[] = ENTRIES) {
  api.use(http.get('http://localhost/api/mcp/gallery', () => HttpResponse.json({ source: 'cloud', entries })))
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } } })
  client.setQueryData(queryKeys.health(), { status: 'ok', version: '3.0.0', capabilities: [] })
  client.setQueryData(queryKeys.mcp.list(), { servers })
  client.setQueryData(queryKeys.mcp.gallery(), { source: 'cloud', entries })
  return render(
    <QueryClientProvider client={client}>
      <ConnectorsListPage onSelect={onSelect} onNew={() => {}} />
    </QueryClientProvider>,
  )
}

/** A connector's row: the list item named after it. */
const row = (name: string) => screen.getByRole('listitem', { name })
/** The button in a row that opens the connector. */
const opener = (name: string) => within(row(name)).getByRole('button', { name: new RegExp(`^${name.replace(/[/.]/g, '\\$&')}\\b`) })

describe('ConnectorsListPage — layout', () => {
  it('puts your connectors first, then the gallery of ones not added yet', () => {
    renderList([NOTION, server('my-tools')])
    const headings = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)
    expect(headings).toEqual(['Your connectors', 'Add a connector'])
    // Notion is added: it is a row, not a gallery tile.
    expect(row('Notion')).toBeInTheDocument()
    expect(document.querySelector('[data-connector="notion"]')).toBeNull()
    expect(document.querySelector('[data-connector="context7"]')).not.toBeNull()
  })

  it('names a gallery connector by its service, with its logo; others by their id, with a monogram', () => {
    renderList([NOTION, server('my-tools')])
    expect(row('Notion').querySelector('[data-connector-icon="logo"] path')?.getAttribute('d')).toBe(LOGO.path)
    expect(within(row('Notion')).getByText('Pages and databases.')).toBeInTheDocument()
    expect(row('my-tools').querySelector('[data-connector-icon="monogram"]')?.textContent).toBe('MT')
    expect(within(row('my-tools')).getByText('A program on this computer')).toBeInTheDocument()
  })

  it('has one search box, which filters your connectors and the gallery', async () => {
    renderList([NOTION, server('my-tools')])
    expect(screen.getAllByRole('searchbox')).toHaveLength(1)
    await userEvent.type(screen.getByRole('searchbox'), 'library')
    expect(screen.queryByRole('listitem', { name: 'Notion' })).toBeNull()
    expect(screen.queryByRole('heading', { name: 'Your connectors' })).toBeNull()
    expect(document.querySelector('[data-connector="context7"]')).not.toBeNull()
    await userEvent.clear(screen.getByRole('searchbox'))
    await userEvent.type(screen.getByRole('searchbox'), 'zzz')
    expect(screen.getByText(/No connectors match/)).toBeInTheDocument()
  })

  it('offers Connect on a connector that needs sign-in', () => {
    renderList([NOTION])
    expect(within(row('Notion')).getByRole('button', { name: 'Connect' })).toBeInTheDocument()
    expect(within(row('Notion')).getByText('Needs sign-in')).toBeInTheDocument()
  })

  it('turns a connector off with its switch', async () => {
    let sent: unknown = null
    api.use(http.put('http://localhost/api/mcp/servers/:name', async ({ request }) => {
      sent = await request.json()
      return HttpResponse.json(server('my-tools', { enabled: false }))
    }))
    renderList([server('my-tools')])
    await userEvent.click(within(row('my-tools')).getByRole('switch', { name: 'Turn off my-tools' }))
    await waitFor(() => expect(sent).toMatchObject({ server: { enabled: false } }))
  })

  it('says there are none yet only when the gallery has nothing to offer either', () => {
    renderList([], () => {}, [])
    expect(screen.getByText('No connectors yet')).toBeInTheDocument()
    cleanup()
    renderList([])
    expect(screen.queryByText('No connectors yet')).toBeNull()
    expect(screen.getByRole('heading', { name: 'Add a connector' })).toBeInTheDocument()
  })
})

describe('ConnectorsListPage — servers from plugins', () => {
  const GITHUB = server('changelog-tools/github', { plugin: 'changelog-tools', tool_names: ['create_issue'] })

  it('labels a server with the plugin it comes from', () => {
    renderList([server('filesystem'), GITHUB])
    const label = within(row('changelog-tools/github')).getByText('from changelog-tools')
    expect(label.closest('[data-slot="chip"]')).toHaveAttribute('data-tone', 'neutral')
  })

  it('leaves a server saved in mcp.json without a label', () => {
    renderList([server('filesystem'), GITHUB])
    expect(within(row('filesystem')).queryByText(/^from /)).toBeNull()
    // A null `plugin` reads like an absent one.
    cleanup()
    renderList([server('filesystem', { plugin: null })])
    expect(within(row('filesystem')).queryByText(/^from /)).toBeNull()
  })

  it('shows its state, and no switch: the plugin owns it', () => {
    renderList([GITHUB])
    expect(within(row('changelog-tools/github')).getByText('Ready · 1 tool')).toBeInTheDocument()
    expect(within(row('changelog-tools/github')).queryByRole('switch')).toBeNull()
  })

  it('still opens the server by its full name', async () => {
    const opened: string[] = []
    renderList([GITHUB], (name) => opened.push(name))
    await userEvent.click(opener('changelog-tools/github'))
    expect(opened).toEqual(['changelog-tools/github'])
  })

  it('finds a plugin server by the plugin\'s name when searching', async () => {
    renderList([server('filesystem'), GITHUB])
    await userEvent.type(screen.getByRole('searchbox'), 'changelog')
    expect(screen.queryByRole('listitem', { name: 'filesystem' })).toBeNull()
    expect(row('changelog-tools/github')).toBeInTheDocument()
  })
})
