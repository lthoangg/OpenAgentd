import '@testing-library/jest-dom'

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'

import type { PluginsResponse } from '@/api/client'
import { PluginsSettingsPage, pluginNoticeText } from '@/components/settings/pages/settings.plugins'
import { queryKeys } from '@/queries'

const DATA: PluginsResponse = {
  dirs: ['/home/u/.config/openagentd/plugins'],
  plugins: [
    { name: 'agy_auth', file: 'agy_auth.ts', path: '/p/agy_auth.ts', status: 'loaded', provider: 'agy', hooks: [], errors: [] },
    { name: 'scrub', file: 'scrub.ts', path: '/p/scrub.ts', status: 'loaded', provider: null, hooks: ['tool.after'], errors: [] },
    { name: 'bad', file: 'bad.ts', path: '/p/bad.ts', status: 'error', provider: null, hooks: [], errors: ['bad.ts:1:5: Unexpected token'] },
  ],
  unported: [{ name: 'legacy', file: 'legacy.py', path: '/p/legacy.py' }],
}

function renderPage(data: PluginsResponse) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } } })
  client.setQueryData(queryKeys.plugins(), data)
  return render(
    <QueryClientProvider client={client}>
      <PluginsSettingsPage />
    </QueryClientProvider>,
  )
}

const originalFetch = globalThis.fetch

beforeEach(() => {
  globalThis.fetch = originalFetch
})

afterEach(() => {
  cleanup()
  globalThis.fetch = originalFetch
})

/** The status chip beside a plugin's file name. */
function chipIn(row: HTMLElement): HTMLElement | null {
  return row.querySelector('[data-slot="chip"]')
}

describe('PluginsSettingsPage', () => {
  it('lists plugins with their provider, hooks and load errors', () => {
    renderPage(DATA)
    const list = screen.getByRole('region', { name: 'Installed plugins' })
    expect(within(list).getByText('Installed · 3 · 1 failed')).toBeInTheDocument()
    // "Provider: agy" and "Hooks: after tool call" are lines of words; the
    // raw hook name rides in a title.
    const lines = within(list).getAllByRole('listitem').map((row) => row.textContent)
    expect(lines.some((text) => text?.includes('Provider: agy'))).toBe(true)
    expect(lines.some((text) => text?.includes('Hooks: after tool call'))).toBe(true)
    expect(within(list).getByTitle('tool.after').textContent).toBe('after tool call')
    expect(within(list).queryByText('tool.after')).toBeNull()
    expect(within(list).queryByText('provider: agy')).toBeNull()
    expect(within(list).getByText('bad.ts:1:5: Unexpected token')).toBeInTheDocument()
    expect(screen.getByText('/home/u/.config/openagentd/plugins')).toBeInTheDocument()
  })

  it('shows each plugin\'s state as a Chip: Loaded or Failed to load', () => {
    renderPage(DATA)
    const list = screen.getByRole('region', { name: 'Installed plugins' })
    const chips = within(list).getAllByRole('listitem').map((row) => chipIn(row))
    expect(chips.map((chip) => chip?.textContent)).toEqual(['Loaded', 'Loaded', 'Failed to load'])
    expect(chips.map((chip) => chip?.getAttribute('data-tone'))).toEqual(['success', 'success', 'error'])
    expect(within(list).queryByLabelText('Loaded')).toBeNull()
    expect(within(list).queryByLabelText('Failed to load')).toBeNull()
  })

  it('warns about Python plugins the backend does not run', () => {
    renderPage(DATA)
    const alert = screen.getByRole('alert')
    expect(within(alert).getByText('1 Python plugin is not running')).toBeInTheDocument()
    expect(within(alert).getByText('legacy.py')).toBeInTheDocument()
  })

  it('shows no warning and an empty state when nothing is installed', () => {
    renderPage({ dirs: ['/p'], plugins: [], unported: [] })
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByText('No plugins installed')).toBeInTheDocument()
    expect(screen.queryByText('No plugins installed.')).toBeNull()
  })

  it('shows a loading skeleton while the plugin list loads', () => {
    globalThis.fetch = (() => new Promise(() => undefined)) as typeof fetch
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(<QueryClientProvider client={client}><PluginsSettingsPage /></QueryClientProvider>)
    expect(screen.getByRole('status', { name: 'Loading plugins' })).toBeInTheDocument()
  })

  it('shows an error callout with Retry when the list fails to load, and recovers', async () => {
    let calls = 0
    globalThis.fetch = (async () => {
      calls += 1
      if (calls === 1) return new Response(JSON.stringify({ detail: 'boom' }), { status: 500, headers: { 'Content-Type': 'application/json' } })
      return new Response(JSON.stringify({ dirs: ['/p'], plugins: [], unported: [] }), { headers: { 'Content-Type': 'application/json' } })
    }) as typeof fetch
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(<QueryClientProvider client={client}><PluginsSettingsPage /></QueryClientProvider>)

    expect(await screen.findByText("Couldn't load plugins")).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(screen.getByText('No plugins installed')).toBeInTheDocument())
    expect(screen.queryByText("Couldn't load plugins")).toBeNull()
  })
})

describe('pluginNoticeText', () => {
  it('summarises unported and failed plugins, keyed by the affected files', () => {
    const n = pluginNoticeText(DATA)!
    expect(n.description).toBe('1 Python plugin needs a TypeScript port; 1 failed to load. See Settings → Plugins.')
    expect(n.key).toContain('legacy.py')
    expect(n.key).toContain('bad.ts')
  })

  it('is silent when every plugin runs', () => {
    expect(pluginNoticeText({ ...DATA, plugins: DATA.plugins.slice(0, 2), unported: [] })).toBeNull()
  })
})
