import '@testing-library/jest-dom'

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import type { PluginBundle, PluginsResponse } from '@/api/client'
import { PluginsSettingsPage, pluginNoticeText } from '@/components/settings/pages/settings.plugins'
import { revealSetting, SETTINGS_INDEX } from '@/components/settings/settings-index'
import { queryKeys } from '@/queries'
import { useToastStore } from '@/stores/useToastStore'

const DATA: PluginsResponse = {
  dirs: ['/home/u/.config/openagentd/plugins'],
  plugins: [
    { name: 'agy_auth', file: 'agy_auth.ts', path: '/p/agy_auth.ts', status: 'loaded', provider: 'agy', hooks: [], errors: [] },
    { name: 'scrub', file: 'scrub.ts', path: '/p/scrub.ts', status: 'loaded', provider: null, hooks: ['tool.after'], errors: [] },
    { name: 'bad', file: 'bad.ts', path: '/p/bad.ts', status: 'error', provider: null, hooks: [], errors: ['bad.ts:1:5: Unexpected token'] },
  ],
  unported: [{ name: 'legacy', file: 'legacy.py', path: '/p/legacy.py' }],
}

/** A bundle with code: the full shape, as the server sends it. */
const CHANGELOG: PluginBundle = {
  name: 'changelog-tools',
  version: '1.2.0',
  description: 'Draft release notes from merged PRs',
  path: '/Users/me/.config/openagentd/plugins/changelog-tools',
  enabled: true,
  state: 'running',
  errors: [],
  warnings: ["plugin.json: unknown field 'commands' ignored"],
  skills: [{ name: 'changelog-tools/release-notes', description: 'Write release notes' }],
  mcp_servers: [
    { name: 'changelog-tools/github', transport: 'stdio', command: 'npx', args: ['-y', '@example/github-mcp'], url: null },
  ],
  tools: [
    { name: 'changelog-tools/draft_release_notes', description: 'Draft release notes from PRs merged since a tag', read_only: true },
  ],
  permissions: { net: ['api.github.com'], listen: false, fs: [], subprocess: [], env: ['GITHUB_TOKEN'] },
  has_code: true,
}

/** A bundle that failed to start, and has no code. */
const BROKEN: PluginBundle = {
  name: 'broken-bundle',
  version: null,
  description: null,
  path: '/p/broken-bundle',
  enabled: true,
  state: 'failed',
  errors: ['mcp.json: expected an object at line 3'],
  warnings: [],
  skills: [],
  mcp_servers: [],
  tools: [],
  permissions: null,
  has_code: false,
}

/** A bundle that is switched off, with an MCP server at a URL. */
const NOTES: PluginBundle = {
  name: 'notes-sync',
  version: '0.4.1',
  description: 'Keep notes in sync',
  path: '/p/notes-sync',
  enabled: false,
  state: 'disabled',
  errors: [],
  warnings: [],
  skills: [],
  mcp_servers: [{ name: 'notes-sync/remote', transport: 'http', command: null, args: [], url: 'https://mcp.example.com/v1' }],
  tools: [],
  permissions: null,
  has_code: false,
}

const WITH_BUNDLES: PluginsResponse = { ...DATA, bundles: [CHANGELOG, BROKEN, NOTES] }

function renderPage(data?: PluginsResponse) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } } })
  if (data) client.setQueryData(queryKeys.plugins(), data)
  return render(
    <QueryClientProvider client={client}>
      <PluginsSettingsPage />
    </QueryClientProvider>,
  )
}

const originalFetch = globalThis.fetch

interface Call {
  method: string
  path: string
  headers?: HeadersInit
  body?: unknown
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

/** Stands in for the server: records each request and answers it with `answer`. */
function serve(answer: (call: Call) => Response | Promise<Response>): Call[] {
  const calls: Call[] = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call: Call = {
      method: init?.method ?? 'GET',
      path: String(input),
      headers: init?.headers,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    }
    calls.push(call)
    return answer(call)
  }) as typeof fetch
  return calls
}

beforeEach(() => {
  globalThis.fetch = originalFetch
  useToastStore.setState({ toasts: [] })
})

afterEach(() => {
  cleanup()
  globalThis.fetch = originalFetch
  useToastStore.setState({ toasts: [] })
})

/** The status chip beside a plugin's file name. */
function chipIn(row: HTMLElement): HTMLElement | null {
  return row.querySelector('[data-slot="chip"]')
}

/** One bundle's row, found by its name. */
const bundleRow = (name: string) => screen.getByRole('listitem', { name })

/** The chip that says `text`, inside `scope`. */
const chipText = (scope: HTMLElement, text: string) => within(scope).getByText(text).closest('[data-slot="chip"]') as HTMLElement

describe('PluginsSettingsPage — single-file plugins', () => {
  it('lists plugins with their provider, hooks and load errors', () => {
    renderPage(DATA)
    const list = screen.getByRole('region', { name: 'Single-file plugins' })
    expect(within(list).getByText('3 plugins · 1 failed')).toBeInTheDocument()
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

  it('says that single-file plugins load only when OpenAgentd starts', () => {
    renderPage(DATA)
    const list = screen.getByRole('region', { name: 'Single-file plugins' })
    expect(within(list).getByText(/Restart OpenAgentd to load new or changed plugins\./)).toBeInTheDocument()
  })

  it('shows each plugin\'s state as a Chip: Loaded or Failed to load', () => {
    renderPage(DATA)
    const list = screen.getByRole('region', { name: 'Single-file plugins' })
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

  it('shows no warning and a one-line empty state when no single-file plugin is installed', () => {
    renderPage({ dirs: ['/p'], plugins: [], unported: [], bundles: [] })
    expect(screen.queryByRole('alert')).toBeNull()
    const list = screen.getByRole('region', { name: 'Single-file plugins' })
    expect(within(list).getByText('No single-file plugins. Put a .ts or .js file in the plugin folder.')).toBeInTheDocument()
  })
})

describe('PluginsSettingsPage — bundles', () => {
  it('lists each bundle with its name, version, description, state and a switch', () => {
    renderPage(WITH_BUNDLES)
    const list = screen.getByRole('region', { name: 'Bundles' })
    expect(within(list).getByText('3 bundles · 1 failed')).toBeInTheDocument()

    const changelog = bundleRow('changelog-tools')
    expect(within(changelog).getByText('1.2.0')).toBeInTheDocument()
    expect(within(changelog).getByText('Draft release notes from merged PRs')).toBeInTheDocument()
    expect(within(changelog).getByText('1 skill · 1 MCP server · 1 tool')).toBeInTheDocument()
    expect(within(changelog).getByRole('switch', { name: 'Enable changelog-tools' })).toHaveAttribute('aria-checked', 'true')

    // No version or description: the row shows only what the bundle gave.
    const broken = bundleRow('broken-bundle')
    expect(within(broken).queryByText('1.2.0')).toBeNull()
    expect(within(broken).getByRole('switch', { name: 'Enable broken-bundle' })).toHaveAttribute('aria-checked', 'true')
    expect(within(bundleRow('notes-sync')).getByRole('switch', { name: 'Enable notes-sync' })).toHaveAttribute('aria-checked', 'false')
  })

  it('says each state in words and a tone, never by colour alone', () => {
    const states = ['running', 'failed', 'blocked', 'stopped', 'pending', 'disabled'] as const
    renderPage({
      ...DATA,
      bundles: states.map((state) => ({ ...CHANGELOG, name: `b-${state}`, state, enabled: state !== 'disabled', warnings: [] })),
    })
    const seen = states.map((state) => {
      const chip = chipIn(bundleRow(`b-${state}`))
      return [state, chip?.textContent, chip?.getAttribute('data-tone'), chip?.getAttribute('title')]
    })
    expect(seen).toEqual([
      ['running', 'Running', 'success', 'state: running'],
      ['failed', 'Failed', 'error', 'state: failed'],
      ['blocked', 'Blocked', 'warning', 'state: blocked'],
      ['stopped', 'Stopped', 'neutral', 'state: stopped'],
      ['pending', 'Pending', 'info', 'state: pending'],
      ['disabled', 'Off', 'neutral', 'state: disabled'],
    ])
  })

  it('shows a state it does not know by its own name', () => {
    renderPage({ ...DATA, bundles: [{ ...CHANGELOG, state: 'rebooting' as PluginBundle['state'] }] })
    expect(chipText(bundleRow('changelog-tools'), 'rebooting')).toHaveAttribute('data-tone', 'neutral')
  })

  it('keeps a failed bundle\'s errors in view while its row is closed', () => {
    renderPage(WITH_BUNDLES)
    const broken = bundleRow('broken-bundle')
    expect(within(broken).getByRole('button')).toHaveAttribute('aria-expanded', 'false')
    const error = within(broken).getByText('mcp.json: expected an object at line 3')
    expect(error).toBeInTheDocument()
    expect(error.className).toContain('text-(--color-error)')
    expect(chipText(broken, 'Failed')).toHaveAttribute('data-tone', 'error')
    // A healthy bundle shows none.
    expect(within(bundleRow('changelog-tools')).queryByText(/expected an object/)).toBeNull()
  })

  it('flags warnings on the closed row and lists them when it opens', () => {
    renderPage(WITH_BUNDLES)
    const row = bundleRow('changelog-tools')
    expect(chipText(row, '1 warning')).toHaveAttribute('data-tone', 'warning')
    expect(within(row).queryByText("plugin.json: unknown field 'commands' ignored")).toBeNull()

    fireEvent.click(within(row).getByRole('button'))
    expect(within(row).getByText('Warnings · 1')).toBeInTheDocument()
    expect(within(row).getByText("plugin.json: unknown field 'commands' ignored")).toBeInTheDocument()
  })

  it('opens a bundle to show where it lives, what it adds and what will run', () => {
    renderPage(WITH_BUNDLES)
    const row = bundleRow('changelog-tools')
    const toggle = within(row).getByRole('button')
    expect(within(row).queryByText('Path')).toBeNull()

    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(document.getElementById(toggle.getAttribute('aria-controls') as string)).toBeInTheDocument()
    expect(within(row).getByText('/Users/me/.config/openagentd/plugins/changelog-tools')).toBeInTheDocument()

    expect(within(row).getByText('Skills · 1')).toBeInTheDocument()
    expect(within(row).getByText('changelog-tools/release-notes')).toBeInTheDocument()
    expect(within(row).getByText('Write release notes')).toBeInTheDocument()

    // What will run on this machine: the program and its arguments, as one line.
    expect(within(row).getByText('MCP servers · 1')).toBeInTheDocument()
    expect(within(row).getByText('changelog-tools/github')).toBeInTheDocument()
    expect(chipText(row, 'stdio')).toBeInTheDocument()
    expect(within(row).getByText('npx -y @example/github-mcp').tagName).toBe('CODE')
    expect(within(row).getByText(/^Runs\b/)).toBeInTheDocument()

    expect(within(row).getByText('Tools · 1')).toBeInTheDocument()
    expect(within(row).getByText('changelog-tools/draft_release_notes')).toBeInTheDocument()
    expect(within(row).getByText('Draft release notes from PRs merged since a tag')).toBeInTheDocument()
    expect(chipText(row, 'read-only')).toBeInTheDocument()

    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(within(row).queryByText('Path')).toBeNull()
    expect(within(row).queryByText('npx -y @example/github-mcp')).toBeNull()
  })

  it('quotes an argument with a space, so each argument can be told apart', () => {
    const bundle: PluginBundle = {
      ...CHANGELOG,
      mcp_servers: [{ name: 'changelog-tools/github', transport: 'stdio', command: 'node', args: ['server.js', '--title', 'Release notes'], url: null }],
    }
    renderPage({ ...DATA, bundles: [bundle] })
    const row = bundleRow('changelog-tools')
    fireEvent.click(within(row).getByRole('button'))
    expect(within(row).getByText("node server.js --title 'Release notes'")).toBeInTheDocument()
  })

  it('lets a long path wrap after its slashes, so it breaks between folders and not inside a name', () => {
    renderPage(WITH_BUNDLES)
    const row = bundleRow('changelog-tools')
    fireEvent.click(within(row).getByRole('button'))
    const path = within(row).getByText('/Users/me/.config/openagentd/plugins/changelog-tools')
    // A break opportunity follows each separator; the text itself is untouched.
    expect(path.querySelectorAll('wbr')).toHaveLength(6)
    expect(path.textContent).toBe('/Users/me/.config/openagentd/plugins/changelog-tools')
    expect(path.innerHTML.startsWith('/<wbr>Users/<wbr>me/')).toBe(true)
  })

  it('breaks a Windows path after its backslashes too', () => {
    renderPage({ ...DATA, bundles: [{ ...CHANGELOG, path: String.raw`C:\Users\me\plugins\changelog-tools` }] })
    const row = bundleRow('changelog-tools')
    fireEvent.click(within(row).getByRole('button'))
    const path = within(row).getByText(String.raw`C:\Users\me\plugins\changelog-tools`)
    expect(path.querySelectorAll('wbr')).toHaveLength(4)
  })

  it('shows an HTTP server by its URL, not a command', () => {
    renderPage(WITH_BUNDLES)
    const row = bundleRow('notes-sync')
    fireEvent.click(within(row).getByRole('button'))
    expect(chipText(row, 'http')).toBeInTheDocument()
    expect(within(row).getByText('https://mcp.example.com/v1').tagName).toBe('CODE')
    expect(within(row).getByText(/^Connects to\b/)).toBeInTheDocument()
    expect(within(row).queryByText(/^Runs\b/)).toBeNull()
  })

  it('marks only the tools that read as read-only', () => {
    const bundle: PluginBundle = {
      ...CHANGELOG,
      tools: [
        { name: 'changelog-tools/list_prs', description: 'List merged PRs', read_only: true },
        { name: 'changelog-tools/publish', description: 'Publish the notes', read_only: false },
      ],
    }
    renderPage({ ...DATA, bundles: [bundle] })
    const row = bundleRow('changelog-tools')
    fireEvent.click(within(row).getByRole('button'))
    const items = within(row).getAllByText(/^changelog-tools\/(list_prs|publish)$/).map((name) => name.closest('li') as HTMLElement)
    expect(items.map((li) => within(li).queryByText('read-only') !== null)).toEqual([true, false])
  })

  it('lists what a bundle\'s code may do, and says so when it has no code', () => {
    const wide: PluginBundle = {
      ...CHANGELOG,
      permissions: { net: true, listen: true, fs: ['/Users/me/notes'], subprocess: ['git'], env: ['GITHUB_TOKEN', 'HOME'] },
    }
    renderPage({ ...DATA, bundles: [wide, BROKEN, { ...CHANGELOG, name: 'quiet', permissions: { net: false, listen: false, fs: [], subprocess: [], env: [] } }] })

    const row = bundleRow('changelog-tools')
    fireEvent.click(within(row).getByRole('button'))
    expect(chipText(row, 'any host')).toHaveAttribute('data-tone', 'warning')
    expect(within(row).getByText('can open a local port')).toBeInTheDocument()
    expect(within(row).getByText('/Users/me/notes').tagName).toBe('CODE')
    expect(within(row).getByText('git').tagName).toBe('CODE')
    expect(within(row).getByText('GITHUB_TOKEN').tagName).toBe('CODE')
    expect(within(row).getByText('HOME').tagName).toBe('CODE')

    // No code: nothing to grant. Code that asked for nothing: says so.
    const broken = bundleRow('broken-bundle')
    fireEvent.click(within(broken).getByRole('button'))
    expect(within(broken).getByText('None. It has no plugin code.')).toBeInTheDocument()
    const quiet = bundleRow('quiet')
    fireEvent.click(within(quiet).getByRole('button'))
    expect(within(quiet).getByText('None requested')).toBeInTheDocument()
  })

  it('says "None" for a kind of content a bundle does not have', () => {
    renderPage(WITH_BUNDLES)
    const row = bundleRow('broken-bundle')
    fireEvent.click(within(row).getByRole('button'))
    expect(within(row).getByText('Skills').nextElementSibling).toHaveTextContent('None')
    expect(within(row).getByText('MCP servers').nextElementSibling).toHaveTextContent('None')
    expect(within(row).getByText('Tools').nextElementSibling).toHaveTextContent('None')
  })

  it('puts the state under the text on phones, with the switch beside the name', () => {
    renderPage(WITH_BUNDLES)
    const row = bundleRow('changelog-tools')
    const toggle = within(row).getByRole('button')
    const grid = toggle.parentElement as HTMLElement
    // Two columns on a phone (text, switch); three from `sm` (text, state, switch).
    expect(grid.className).toContain('grid-cols-[minmax(0,1fr)_auto_auto]')
    expect(grid.className).toContain('max-sm:grid-cols-[minmax(0,1fr)_auto]')
    const state = chipText(row, 'Running').parentElement as HTMLElement
    expect(state.className).toContain('max-sm:row-start-2')
    expect(state.className).toContain('max-sm:col-start-1')
    const switchCell = within(row).getByRole('switch').parentElement as HTMLElement
    expect(switchCell.className).toContain('max-sm:col-start-2')
    // The switch is beside the disclosure button, never inside it.
    expect(toggle.contains(within(row).getByRole('switch'))).toBe(false)
  })
})

describe('PluginsSettingsPage — turning a bundle on or off', () => {
  const NAMED: PluginBundle = { ...CHANGELOG, name: 'acme.changelog-tools', warnings: [] }
  const NAMED_OFF: PluginBundle = { ...NAMED, enabled: false, state: 'disabled' }

  it('sends a PUT to the bundle\'s URL-encoded name with { enabled: false }, then reads the list again', async () => {
    let held: PluginBundle[] = [NAMED]
    const calls = serve((call) => {
      if (call.method === 'PUT') {
        held = [NAMED_OFF]
        return json(NAMED_OFF)
      }
      return json({ ...DATA, bundles: held })
    })
    renderPage({ ...DATA, bundles: [NAMED] })

    await userEvent.click(within(bundleRow('acme.changelog-tools')).getByRole('switch', { name: 'Enable acme.changelog-tools' }))

    await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true))
    const put = calls.find((c) => c.method === 'PUT')!
    expect(put.path).toBe('/api/plugins/bundles/acme.changelog-tools')
    expect(put.headers).toEqual({ 'Content-Type': 'application/json' })
    expect(put.body).toEqual({ enabled: false })

    // It settles as the server holds it: off, and the list was read again.
    await waitFor(() => expect(calls.filter((c) => c.method === 'GET' && c.path === '/api/plugins')).toHaveLength(1))
    const row = bundleRow('acme.changelog-tools')
    await waitFor(() => expect(within(row).getByRole('switch')).toHaveAttribute('aria-checked', 'false'))
    expect(chipText(row, 'Off')).toHaveAttribute('title', 'state: disabled')
    expect(useToastStore.getState().toasts).toEqual([])
  })

  it('turns a bundle that is off back on', async () => {
    const calls = serve((call) => (call.method === 'PUT' ? json({ ...NOTES, enabled: true, state: 'running' }) : json({ ...DATA, bundles: [{ ...NOTES, enabled: true, state: 'running' }] })))
    renderPage({ ...DATA, bundles: [NOTES] })

    await userEvent.click(within(bundleRow('notes-sync')).getByRole('switch'))

    await waitFor(() => expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({ enabled: true }))
    await waitFor(() => expect(chipText(bundleRow('notes-sync'), 'Running')).toBeInTheDocument())
    expect(within(bundleRow('notes-sync')).getByRole('switch')).toHaveAttribute('aria-checked', 'true')
  })

  it('encodes a name that needs it, so it stays one segment of the path', async () => {
    const odd: PluginBundle = { ...NAMED, name: 'team/notes sync+v2' }
    const calls = serve((call) => (call.method === 'PUT' ? json({ ...odd, enabled: false, state: 'disabled' }) : json({ ...DATA, bundles: [odd] })))
    renderPage({ ...DATA, bundles: [odd] })

    await userEvent.click(within(bundleRow('team/notes sync+v2')).getByRole('switch'))

    await waitFor(() => expect(calls.find((c) => c.method === 'PUT')?.path).toBe('/api/plugins/bundles/team%2Fnotes%20sync%2Bv2'))
  })

  it('flips the switch at once, and holds only that bundle\'s switch while it waits', async () => {
    let answer!: (response: Response) => void
    serve((call) => (call.method === 'PUT' ? new Promise<Response>((resolve) => { answer = resolve }) : json({ ...DATA, bundles: [NAMED_OFF, NOTES] })))
    renderPage({ ...DATA, bundles: [NAMED, NOTES] })

    await userEvent.click(within(bundleRow('acme.changelog-tools')).getByRole('switch'))

    const row = bundleRow('acme.changelog-tools')
    await waitFor(() => expect(within(row).getByRole('switch')).toHaveAttribute('aria-checked', 'false'))
    expect(chipText(row, 'Off')).toBeInTheDocument()
    expect(row).toHaveAttribute('aria-busy', 'true')
    expect(within(row).getByRole('switch')).toBeDisabled()
    // Another bundle's switch is still in use.
    expect(bundleRow('notes-sync')).not.toHaveAttribute('aria-busy')
    expect(within(bundleRow('notes-sync')).getByRole('switch')).toBeEnabled()

    answer(json(NAMED_OFF))
    await waitFor(() => expect(row).not.toHaveAttribute('aria-busy'))
    expect(within(row).getByRole('switch')).toBeEnabled()
  })

  it('puts the switch back and says why when the server refuses', async () => {
    serve((call) => (call.method === 'PUT' ? json({ detail: 'plugins folder is read-only' }, 500) : json({ ...DATA, bundles: [NAMED] })))
    renderPage({ ...DATA, bundles: [NAMED] })

    await userEvent.click(within(bundleRow('acme.changelog-tools')).getByRole('switch'))

    await waitFor(() => expect(useToastStore.getState().toasts).toHaveLength(1))
    expect(useToastStore.getState().toasts[0]).toMatchObject({
      tone: 'error',
      title: "Couldn't turn acme.changelog-tools off",
      description: 'plugins folder is read-only',
    })
    const row = bundleRow('acme.changelog-tools')
    await waitFor(() => expect(row).not.toHaveAttribute('aria-busy'))
    expect(within(row).getByRole('switch')).toHaveAttribute('aria-checked', 'true')
    expect(chipText(row, 'Running')).toBeInTheDocument()
  })

  it('says "on" in the error when turning a bundle on is what failed', async () => {
    serve((call) => (call.method === 'PUT' ? json({ detail: 'No such bundle' }, 404) : json({ ...DATA, bundles: [NOTES] })))
    renderPage({ ...DATA, bundles: [NOTES] })

    await userEvent.click(within(bundleRow('notes-sync')).getByRole('switch'))

    await waitFor(() => expect(useToastStore.getState().toasts[0]).toMatchObject({ title: "Couldn't turn notes-sync on", description: 'No such bundle' }))
    expect(within(bundleRow('notes-sync')).getByRole('switch')).toHaveAttribute('aria-checked', 'false')
  })
})

describe('PluginsSettingsPage — Reload', () => {
  it('posts to /plugins/reload and shows the list the server answers with', async () => {
    const calls = serve((call) => (call.path === '/api/plugins/reload' ? json({ ...DATA, bundles: [CHANGELOG, NOTES] }) : json({ ...DATA, bundles: [CHANGELOG] })))
    renderPage({ ...DATA, bundles: [CHANGELOG] })
    expect(screen.queryByRole('listitem', { name: 'notes-sync' })).toBeNull()

    await userEvent.click(screen.getByRole('button', { name: 'Reload' }))

    expect(await screen.findByRole('listitem', { name: 'notes-sync' })).toBeInTheDocument()
    expect(calls).toEqual([{ method: 'POST', path: '/api/plugins/reload', headers: undefined, body: undefined }])
    expect(within(screen.getByRole('region', { name: 'Bundles' })).getByText('2 bundles')).toBeInTheDocument()
    expect(useToastStore.getState().toasts).toHaveLength(1)
    expect(useToastStore.getState().toasts[0]).toMatchObject({ tone: 'success', title: 'Plugins reloaded' })
  })

  it('drops a bundle the server no longer finds', async () => {
    serve(() => json({ ...DATA, bundles: [NOTES] }))
    renderPage({ ...DATA, bundles: [CHANGELOG, NOTES] })

    await userEvent.click(screen.getByRole('button', { name: 'Reload' }))

    await waitFor(() => expect(screen.queryByRole('listitem', { name: 'changelog-tools' })).toBeNull())
    expect(screen.getByRole('listitem', { name: 'notes-sync' })).toBeInTheDocument()
  })

  it('shows it is working, and holds the switches, until the server answers', async () => {
    let answer!: (response: Response) => void
    serve(() => new Promise<Response>((resolve) => { answer = resolve }))
    renderPage({ ...DATA, bundles: [CHANGELOG] })

    await userEvent.click(screen.getByRole('button', { name: 'Reload' }))

    const busy = await screen.findByRole('button', { name: 'Reloading…' })
    expect(busy).toBeDisabled()
    expect(busy.querySelector('svg')?.getAttribute('class')).toContain('animate-spin')
    expect(within(bundleRow('changelog-tools')).getByRole('switch')).toBeDisabled()

    answer(json({ ...DATA, bundles: [CHANGELOG] }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Reload' })).toBeEnabled())
    expect(within(bundleRow('changelog-tools')).getByRole('switch')).toBeEnabled()
  })

  it('reports a failed reload as an error toast and keeps the list', async () => {
    serve(() => json({ detail: 'the plugin folder is not readable' }, 500))
    renderPage({ ...DATA, bundles: [CHANGELOG] })

    await userEvent.click(screen.getByRole('button', { name: 'Reload' }))

    await waitFor(() => expect(useToastStore.getState().toasts).toHaveLength(1))
    expect(useToastStore.getState().toasts[0]).toMatchObject({
      tone: 'error',
      title: "Couldn't reload plugins",
      description: 'the plugin folder is not readable',
    })
    expect(screen.getByRole('listitem', { name: 'changelog-tools' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Reload' })).toBeEnabled()
  })
})

describe('PluginsSettingsPage — older servers and empty lists', () => {
  it('renders a response without `bundles` (a server that predates them)', () => {
    renderPage(DATA)
    // The single-file list is whole, and bundles read as none.
    const files = screen.getByRole('region', { name: 'Single-file plugins' })
    expect(within(files).getByText('scrub.ts')).toBeInTheDocument()
    const bundles = screen.getByRole('region', { name: 'Bundles' })
    expect(within(bundles).queryByRole('listitem')).toBeNull()
    expect(within(bundles).getByText('agentd plugin add <git-url or folder>')).toBeInTheDocument()
  })

  it('points to `agentd plugin add` when no bundle is installed', () => {
    renderPage({ dirs: ['/p'], plugins: [], unported: [], bundles: [] })
    const bundles = screen.getByRole('region', { name: 'Bundles' })
    expect(within(bundles).getByText(/^No bundles yet\./)).toBeInTheDocument()
    expect(within(bundles).getByText('agentd plugin add <git-url or folder>').tagName).toBe('CODE')
    // Nothing to count yet.
    expect(within(bundles).queryByText(/0 bundles/)).toBeNull()
  })

  it('has no bundle empty state once there is a bundle', () => {
    renderPage(WITH_BUNDLES)
    expect(screen.queryByText('agentd plugin add <git-url or folder>')).toBeNull()
  })

  it('has a heading for each plugin entry of the settings search, so a result can scroll to it', () => {
    renderPage(WITH_BUNDLES)
    const entries = SETTINGS_INDEX.filter((entry) => entry.section === 'plugins')
    expect(entries).toHaveLength(2)
    for (const entry of entries) {
      expect([entry.label, revealSetting(document.body, entry.anchor ?? entry.label)]).toEqual([entry.label, true])
    }
  })

  it('shows a loading skeleton while the plugin list loads', () => {
    globalThis.fetch = (() => new Promise(() => undefined)) as typeof fetch
    renderPage()
    expect(screen.getByRole('status', { name: 'Loading plugins' })).toBeInTheDocument()
  })

  it('shows an error callout with Retry when the list fails to load, and recovers', async () => {
    let calls = 0
    globalThis.fetch = (async () => {
      calls += 1
      if (calls === 1) return json({ detail: 'boom' }, 500)
      return json({ dirs: ['/p'], plugins: [], unported: [], bundles: [CHANGELOG] })
    }) as typeof fetch
    renderPage()

    expect(await screen.findByText("Couldn't load plugins")).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(screen.getByRole('listitem', { name: 'changelog-tools' })).toBeInTheDocument())
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
