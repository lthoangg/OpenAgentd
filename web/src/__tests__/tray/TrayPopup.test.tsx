import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import '@testing-library/jest-dom'
import type { TraySessions } from '@/tray/sessions'
import type { TrayUsageResult } from '@/tray/usage'

const NOW = Math.floor(Date.now() / 1000)

const usageResult: TrayUsageResult = {
  server_name: 'Built-in server',
  server_id: 'bundled',
  selected_server_id: 'auto',
  servers: [
    { id: 'auto', name: 'Auto (Active Window)', detail: 'Built-in server' },
    { id: 'bundled', name: 'Built-in server', detail: null },
    { id: 'http://192.168.1.10:4082', name: 'Mac Studio', detail: '192.168.1.10:4082' },
  ],
  summary: {
    checked_at: NOW - 120,
    cached: false,
    items: [
      {
        provider: 'openai',
        label: 'OpenAI Codex',
        status: 'ok',
        stale: false,
        usage: {
          provider: 'openai',
          limits: [{
            limit_name: 'Codex',
            primary: { used_percent: 42, window_minutes: 300, resets_at: NOW + 3600 },
            secondary: { used_percent: 76, window_minutes: 10_080, resets_at: NOW + 86_400 },
          }],
        },
      },
      { provider: 'copilot', label: 'GitHub Copilot', status: 'credentials_missing', stale: false, usage: null },
    ],
  },
}

type Call = [string, Record<string, unknown> | undefined]
let calls: Call[] = []
let answer: (args: Record<string, unknown> | undefined) => Promise<TrayUsageResult> = async () => usageResult

const idle: TraySessions = { connected: true, needsYou: [], running: [], unreachable: [] }
const session = (id: string, title: string, patch: Record<string, unknown> = {}) =>
  ({ id, title, workspace: 'api', state: 'needs_input', question: null, ...patch })
let sessionsNow: unknown = idle

mock.module('@tauri-apps/api/core', () => ({
  invoke: async (cmd: string, args?: Record<string, unknown>) => {
    calls.push([cmd, args])
    if (cmd === 'get_tray_usage_summary') return answer(args)
    if (cmd === 'tray_sessions') return sessionsNow
    return undefined
  },
}))

// Live tray-refresh listeners; `listenDelayMs` makes `listen` resolve late,
// like the real IPC round trip.
let activeListeners = 0
let listenDelayMs = 0
const listeners = new Map<string, Set<() => void>>()
mock.module('@tauri-apps/api/event', () => ({
  listen: async (event: string, handler: () => void) => {
    if (listenDelayMs) await new Promise((resolve) => setTimeout(resolve, listenDelayMs))
    activeListeners++
    const set = listeners.get(event) ?? new Set()
    set.add(handler)
    listeners.set(event, set)
    return () => {
      activeListeners--
      set.delete(handler)
    }
  },
}))

const { TrayPopup } = await import('@/tray/TrayPopup')

const actions = () => calls.filter(([cmd]) => cmd === 'tray_action').map(([, args]) => args?.action)
const usageCalls = () => calls.filter(([cmd]) => cmd === 'get_tray_usage_summary').map(([, args]) => args)
const sessionCalls = () => calls.filter(([cmd]) => cmd === 'tray_sessions').map(([, args]) => args)
const emit = (event: string) => act(() => [...(listeners.get(event) ?? [])].forEach((handler) => handler()))

beforeEach(() => {
  calls = []
  answer = async () => usageResult
  sessionsNow = idle
  listeners.clear()
})
afterEach(cleanup)

describe('TrayPopup', () => {
  it('names each provider once and labels its limits by window', async () => {
    render(<TrayPopup />)

    const card = await screen.findByRole('group', { name: 'OpenAI Codex' })
    expect(within(card).getByText('5-hour')).toBeInTheDocument()
    expect(within(card).getByText('Weekly')).toBeInTheDocument()
    expect(screen.getAllByText('OpenAI Codex')).toHaveLength(1)
    expect(screen.getByText('Getting close')).toBeInTheDocument()
  })

  // "Usage" meant quotas here and spend in the app.
  it('calls the quotas "Provider limits"', async () => {
    render(<TrayPopup />)
    await screen.findByRole('group', { name: 'OpenAI Codex' })
    expect(screen.getByText('Provider limits')).toBeInTheDocument()
    expect(screen.queryByText('Usage')).toBeNull()
    expect(screen.getByRole('button', { name: 'Refresh provider limits' })).toHaveAttribute('aria-keyshortcuts', 'Meta+R Control+R')
  })

  it('exposes each limit as a meter', async () => {
    render(<TrayPopup />)

    const meter = await screen.findByRole('meter', { name: 'OpenAI Codex 5-hour' })
    expect(meter).toHaveAttribute('aria-valuenow', '42')
    expect(screen.getByRole('meter', { name: 'OpenAI Codex Weekly' })).toHaveAttribute('aria-valuenow', '76')
  })

  it('marks throttled usage as old with its retry time, not as a reached limit', async () => {
    answer = async () => ({
      ...usageResult,
      summary: {
        checked_at: NOW,
        cached: false,
        items: [
          {
            provider: 'openai',
            label: 'OpenAI Codex',
            status: 'rate_limited',
            stale: true,
            retry_at: NOW + 600,
            retry_after: 600,
            usage: { provider: 'openai', limits: [{ primary: { used_percent: 97, window_minutes: 300 } }] },
          },
          { provider: 'copilot', label: 'GitHub Copilot', status: 'rate_limited', stale: false, usage: null },
        ],
      },
    })
    render(<TrayPopup />)

    const card = await screen.findByRole('group', { name: 'OpenAI Codex' })
    expect(within(card).getByRole('meter')).toHaveAttribute('aria-valuenow', '97')
    expect(within(card).getByText('Last known')).toBeInTheDocument()
    expect(within(card).getByText(/Rate limited · Retry in \d+m/)).toBeInTheDocument()
    expect(within(card).queryByText(/limit reached|near limit/i)).not.toBeInTheDocument()

    const bare = screen.getByRole('group', { name: 'GitHub Copilot' })
    expect(within(bare).getByText('Rate limited · Retry later')).toBeInTheDocument()
    expect(within(bare).queryByRole('button', { name: /reconnect/i })).not.toBeInTheDocument()

    expect(screen.getByText('Usage delayed')).toBeInTheDocument()
    expect(screen.queryByText('Limit reached')).not.toBeInTheDocument()
  })

  it('keeps an unavailable provider\'s last numbers, marked old, without an alert', async () => {
    answer = async () => ({
      ...usageResult,
      summary: {
        checked_at: NOW,
        cached: false,
        items: [{
          provider: 'openai',
          label: 'OpenAI Codex',
          status: 'unavailable',
          stale: true,
          usage: { provider: 'openai', limits: [{ primary: { used_percent: 97, window_minutes: 300 } }] },
        }],
      },
    })
    render(<TrayPopup />)

    const card = await screen.findByRole('group', { name: 'OpenAI Codex' })
    expect(within(card).getByRole('meter')).toHaveAttribute('aria-valuenow', '97')
    expect(within(card).getByText('Last known')).toBeInTheDocument()
    expect(within(card).getByText('Unavailable')).toBeInTheDocument()
    expect(within(card).queryByText(/limit reached|near limit|rate limited/i)).not.toBeInTheDocument()
    expect(screen.queryByText('Limit reached')).not.toBeInTheDocument()
  })

  it('shows placeholders, not an empty message, while the first reading loads', async () => {
    answer = () => new Promise(() => {})
    render(<TrayPopup />)

    expect(screen.getByText('Checking')).toBeInTheDocument()
    expect(screen.getByLabelText('Loading usage')).toHaveAttribute('aria-busy', 'true')
    expect(screen.queryByText(/no providers/i)).not.toBeInTheDocument()
  })

  it("says when the server can't be reached, and Retry asks again past the cache", async () => {
    answer = async () => ({ ...usageResult, summary: null, error: 'error sending request for url (http://127.0.0.1:4082/api/usage)' })
    render(<TrayPopup />)

    expect(await screen.findByText("Can't reach Built-in server")).toBeInTheDocument()
    expect(screen.getByText("Can't reach")).toBeInTheDocument()
    expect(screen.queryByText('Offline')).toBeNull()
    expect(screen.queryByText(/error sending request/)).not.toBeInTheDocument()
    expect(screen.getByText("The server didn't answer. It may be stopped or asleep.")).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(usageCalls().at(-1)).toMatchObject({ force: true }))
  })

  it('says there is no server, not that it cannot reach one, and offers the way in', async () => {
    answer = async () => ({
      summary: null,
      server_name: 'No server connected',
      server_id: 'auto',
      servers: [],
      selected_server_id: 'auto',
      error: 'No server is connected.',
    })
    sessionsNow = { ...idle, connected: false }
    render(<TrayPopup />)

    expect(await screen.findByText('No server connected')).toBeInTheDocument()
    expect(screen.queryByText(/Can't reach/)).toBeNull()
    expect(screen.queryByText('Provider limits')).toBeNull()
    fireEvent.click(screen.getAllByRole('button', { name: 'Open OpenAgentd' })[0]!)
    expect(actions()).toContain('show')
    fireEvent.click(screen.getAllByRole('button', { name: 'Settings' })[0]!)
    expect(actions()).toContain('settings')
  })

  it('shows a failed refresh in words, over the last reading, with a Retry that is a real button', async () => {
    let fail = false
    answer = async () => (fail ? { ...usageResult, error: 'request timed out' } : usageResult)
    render(<TrayPopup />)
    await screen.findByText('5-hour')

    fail = true
    fireEvent.keyDown(document, { key: 'r', metaKey: true })
    const callout = (await screen.findByText("Couldn't refresh")).closest('.callout') as HTMLElement
    expect(within(callout).getByText('The server took too long to answer.')).toBeInTheDocument()
    fireEvent.click(within(callout).getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(usageCalls().filter((args) => args?.force).length).toBeGreaterThan(1))
  })

  it('puts no native tooltip on a control', async () => {
    sessionsNow = { ...idle, needsYou: [session('s1', 'Plan review')], unreachable: [{ id: 'nas', name: 'NAS', reason: 'unreachable' }] }
    render(<TrayPopup />)
    await screen.findByText('Plan review')
    expect(document.querySelectorAll('button[title]')).toHaveLength(0)
  })

  it('lists what needs you first and what runs, and opens a row through the shell', async () => {
    sessionsNow = {
      ...idle,
      needsYou: [session('s1', 'Pin credentials', { question: 'Which account?', server: 'Built-in server' })],
      running: [session('s2', 'Fix tray rows', { state: 'running', goal: { status: 'active', turn: 3, maxTurns: 10 } })],
    }
    render(<TrayPopup />)

    const needs = await screen.findByRole('region', { name: 'Needs you' })
    expect(within(needs).getByText('Pin credentials')).toBeInTheDocument()
    expect(within(needs).getByText('Built-in server · api · “Which account?”')).toBeInTheDocument()
    const running = screen.getByRole('region', { name: 'Running' })
    expect(within(running).getByText('Goal 3/10')).toBeDefined()
    expect(screen.getByText('1 needs you')).toBeInTheDocument()
    // Needs you comes before the limits.
    expect(needs.compareDocumentPosition(screen.getByText('Provider limits')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()

    fireEvent.click(within(needs).getByRole('button', { name: /Pin credentials/ }))
    expect(calls).toContainEqual(['tray_open_session', { sessionId: 's1' }])
    fireEvent.click(within(running).getByRole('button', { name: /Fix tray rows/ }))
    expect(calls).toContainEqual(['tray_open_session', { sessionId: 's2' }])
  })

  it('reads the lists again when the feed says they changed, and each time it opens', async () => {
    render(<TrayPopup />)
    await screen.findByText('5-hour')
    expect(screen.queryByText('Plan review')).toBeNull()

    sessionsNow = { ...idle, needsYou: [session('s1', 'Plan review')] }
    emit('tray-sessions')
    expect(await screen.findByText('Plan review')).toBeInTheDocument()

    sessionsNow = idle
    emit('tray-popup-refresh')
    // A boolean, not the element: Bun crashes formatting a DOM node into a failure message.
    await waitFor(() => expect(Boolean(screen.queryByText('Plan review'))).toBe(false))
  })

  it("names a server it can't reach, and Retry asks the feed to try again", async () => {
    sessionsNow = { ...idle, unreachable: [{ id: 'http://nas:4082', name: 'NAS', reason: 'key_rejected' }] }
    render(<TrayPopup />)
    const group = await screen.findByRole('region', { name: "Can't reach" })
    expect(within(group).getByText('NAS')).toBeInTheDocument()
    expect(within(group).getByText('Access key rejected')).toBeInTheDocument()
    fireEvent.click(within(group).getByRole('button', { name: 'Retry NAS' }))
    await waitFor(() => expect(sessionCalls().at(-1)).toEqual({ retry: true }))
  })

  it('shows nothing extra while no session needs you or runs', async () => {
    render(<TrayPopup />)
    await screen.findByText('5-hour')
    expect(document.querySelector('.sessions')).toBeNull()
    expect(screen.queryByText(/needs you|need you/)).toBeNull()
  })

  it('ignores a sessions answer it cannot read', async () => {
    sessionsNow = 'not an object'
    render(<TrayPopup />)
    await screen.findByText('5-hour')
    expect(document.querySelector('.sessions')).toBeNull()
  })

  it('offers Settings → Providers when no provider is connected', async () => {
    answer = async () => ({ ...usageResult, summary: { checked_at: NOW, cached: false, items: [] } })
    render(<TrayPopup />)

    fireEvent.click(await screen.findByRole('button', { name: 'Open Providers' }))
    expect(actions()).toEqual(['usage_manage'])
  })

  it('sends Reconnect to Settings → Providers', async () => {
    render(<TrayPopup />)

    fireEvent.click(await screen.findByRole('button', { name: 'Reconnect GitHub Copilot' }))
    expect(actions()).toEqual(['usage_manage'])
  })

  it('runs each action through the native menu command', async () => {
    render(<TrayPopup />)
    await screen.findByText('5-hour')

    for (const name of ['Open OpenAgentd', 'Settings', 'Quit OpenAgentd']) {
      fireEvent.click(screen.getByRole('button', { name: new RegExp(`^${name}`) }))
    }
    expect(actions()).toEqual(['show', 'settings', 'quit'])
    expect(screen.queryByRole('button', { name: /^New session/ })).toBeNull()
  })

  it('Esc closes the server menu first, then the popup', async () => {
    render(<TrayPopup />)
    fireEvent.click(await screen.findByRole('button', { name: /^Server/ }))
    expect(screen.getByRole('listbox', { name: 'Server' })).toBeInTheDocument()

    fireEvent.keyDown(document, { key: 'Escape' })
    // A boolean, not the element: the menu is still fading out on the first
    // check, and Bun crashes formatting a DOM node into the failure message.
    await waitFor(() => expect(Boolean(screen.queryByRole('listbox'))).toBe(false))
    expect(actions()).toEqual([])

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(actions()).toEqual(['hide'])
  })

  it('⌘R refreshes past the cache', async () => {
    render(<TrayPopup />)
    await screen.findByText('5-hour')

    fireEvent.keyDown(document, { key: 'r', metaKey: true })
    await waitFor(() => expect(usageCalls().at(-1)).toMatchObject({ force: true }))
  })

  it('runs the shortcut each action shows', async () => {
    render(<TrayPopup />)
    await screen.findByText('5-hour')

    for (const key of ['n', ',', 'q']) fireEvent.keyDown(document, { key, metaKey: true })
    // ⌘N is not the tray's: New session lives in the app window.
    expect(actions()).toEqual(['settings', 'quit'])
  })

  it('picks a server from the keyboard and reads its usage', async () => {
    render(<TrayPopup />)
    fireEvent.click(await screen.findByRole('button', { name: /^Server/ }))
    const list = screen.getByRole('listbox', { name: 'Server' })
    await waitFor(() => expect(document.activeElement === list).toBe(true))
    expect(within(list).getByRole('option', { name: /Auto/ })).toHaveAttribute('aria-selected', 'true')

    fireEvent.keyDown(document, { key: 'ArrowDown' })
    expect(list).toHaveAttribute('aria-activedescendant', 'tray-server-1')
    fireEvent.keyDown(document, { key: 'ArrowDown' })
    fireEvent.keyDown(document, { key: 'Enter' })

    await waitFor(() => expect(usageCalls().at(-1)).toMatchObject({ targetServer: 'http://192.168.1.10:4082' }))
  })

  it('keeps showing the last reading when a refresh fails', async () => {
    let fail = false
    answer = async () => (fail ? { ...usageResult, error: 'timeout' } : usageResult)
    render(<TrayPopup />)
    await screen.findByText('5-hour')

    fail = true
    fireEvent.keyDown(document, { key: 'r', metaKey: true })

    expect(await screen.findByText("Couldn't refresh")).toBeInTheDocument()
    expect(screen.getByText('5-hour')).toBeInTheDocument()
  })

  it('drops the refresh listener when unmounted before listen resolves', async () => {
    activeListeners = 0
    listenDelayMs = 20
    try {
      const { unmount } = render(<TrayPopup />)
      unmount()
      await act(() => new Promise((resolve) => setTimeout(resolve, 60)))
      expect(activeListeners).toBe(0)
    } finally {
      listenDelayMs = 0
    }
  })
})
