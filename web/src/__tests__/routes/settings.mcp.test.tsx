import '@testing-library/jest-dom'

import { afterEach, describe, expect, it } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import type { ServerStatus } from '@/api/client'
import { McpListPage } from '@/components/settings/pages/settings.mcp'
import { queryKeys } from '@/queries'

afterEach(cleanup)

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

function renderList(servers: ServerStatus[], onSelect: (name: string) => void = () => {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } } })
  client.setQueryData(queryKeys.health(), { status: 'ok', version: '3.0.0', capabilities: [] })
  client.setQueryData(queryKeys.mcp.list(), { servers })
  return render(
    <QueryClientProvider client={client}>
      <McpListPage onSelect={onSelect} onNew={() => {}} />
    </QueryClientProvider>,
  )
}

/** A server's row: the button that names it. */
const serverRow = (name: string) => screen.getByRole('button', { name: new RegExp(`^${name.replace(/[/.]/g, '\\$&')}\\b`) })

describe('McpListPage — servers from plugins', () => {
  const GITHUB = server('changelog-tools/github', { plugin: 'changelog-tools', tool_names: ['create_issue'] })

  it('labels a server with the plugin it comes from', () => {
    renderList([server('filesystem'), GITHUB])
    const label = within(serverRow('changelog-tools/github')).getByText('from changelog-tools')
    expect(label.closest('[data-slot="chip"]')).toHaveAttribute('data-tone', 'neutral')
  })

  it('leaves a server saved in mcp.json without a label', () => {
    renderList([server('filesystem'), GITHUB])
    expect(within(serverRow('filesystem')).queryByText(/^from /)).toBeNull()
    // A null `plugin` reads like an absent one.
    cleanup()
    renderList([server('filesystem', { plugin: null })])
    expect(within(serverRow('filesystem')).queryByText(/^from /)).toBeNull()
  })

  it('keeps the server\'s own chips: transport and state', () => {
    renderList([GITHUB])
    const row = serverRow('changelog-tools/github')
    expect(within(row).getByText('stdio')).toBeInTheDocument()
    expect(within(row).getByText('Ready · 1 tool')).toBeInTheDocument()
  })

  it('still opens the server by its full name', async () => {
    const opened: string[] = []
    renderList([GITHUB], (name) => opened.push(name))
    await userEvent.click(serverRow('changelog-tools/github'))
    expect(opened).toEqual(['changelog-tools/github'])
  })

  it('finds a plugin server by the plugin\'s name when filtering', async () => {
    renderList([server('filesystem'), GITHUB])
    await userEvent.type(screen.getByRole('searchbox'), 'changelog')
    expect(screen.queryByRole('button', { name: /^filesystem/ })).toBeNull()
    expect(serverRow('changelog-tools/github')).toBeInTheDocument()
  })
})
