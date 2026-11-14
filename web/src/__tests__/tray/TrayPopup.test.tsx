import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import '@testing-library/jest-dom'
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

mock.module('@tauri-apps/api/core', () => ({
  invoke: async (cmd: string, args?: Record<string, unknown>) => {
    calls.push([cmd, args])
    if (cmd === 'get_tray_usage_summary') return answer(args)
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

// The popup exists only on macOS, so its tests read it as a Mac does.
const realPlatform = navigator.platform
beforeEach(() => {
  calls = []
  answer = async () => usageResult
  listeners.clear()
  Object.defineProperty(navigator, 'platform', { value: 'MacIntel', configurable: true })
})
afterEach(() => {
  cleanup()
  Object.defineProperty(navigator, 'platform', { value: realPlatform, configurable: true })
})

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
    expect(screen.getByRole('button', { name: 'Refresh provider limits' })).toBeInTheDocument()
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
    render(<TrayPopup />)
    await screen.findByText('5-hour')
    expect(document.querySelectorAll('button[title]')).toHaveLength(0)
  })

  // The tray is for provider limits: the notch and the sidebar list sessions.
  it('lists no sessions and says nothing of what needs you', async () => {
    render(<TrayPopup />)
    await screen.findByText('5-hour')
    expect(document.querySelector('.sessions')).toBeNull()
    expect(screen.queryByText(/needs you|need you/i)).toBeNull()
    expect(calls.some(([cmd]) => cmd === 'tray_sessions')).toBe(false)
  })

  it('offers Settings → Providers when no provider is connected', async () => {
    answer = async () => ({ ...usageResult, summary: { checked_at: NOW, items: [] } })
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

  // The popup is a Mac window: Ctrl+Q there is not Quit, and no hint shows it.
  it('leaves a key held with another modifier alone', async () => {
    render(<TrayPopup />)
    await screen.findByText('5-hour')
    const before = usageCalls().length

    for (const key of ['r', ',', 'q']) fireEvent.keyDown(document, { key, ctrlKey: true })
    for (const key of ['r', ',', 'q']) fireEvent.keyDown(document, { key, metaKey: true, ctrlKey: true })
    expect(actions()).toEqual([])
    expect(usageCalls().length).toBe(before)
    expect(screen.getByRole('button', { name: 'Refresh provider limits' })).toHaveAttribute('aria-keyshortcuts', 'Meta+R')
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

  const MAC_STUDIO = 'http://192.168.1.10:4082'
  const studioResult: TrayUsageResult = {
    ...usageResult,
    server_name: 'Mac Studio',
    server_id: MAC_STUDIO,
    selected_server_id: MAC_STUDIO,
    summary: { checked_at: NOW, items: [{ provider: 'copilot', label: 'GitHub Copilot', status: 'credentials_missing', stale: false, usage: null }] },
  }

  async function pick(name: RegExp) {
    fireEvent.click(screen.getByRole('button', { name: /^Server/ }))
    fireEvent.click(within(screen.getByRole('listbox', { name: 'Server' })).getByRole('option', { name }))
  }

  // The numbers on screen always belong to the server named above them.
  it('shows placeholders under the picked server, not the last server\'s numbers', async () => {
    answer = (args) => (args?.targetServer === MAC_STUDIO ? new Promise(() => {}) : Promise.resolve(usageResult))
    render(<TrayPopup />)
    await screen.findByText('5-hour')

    await pick(/Mac Studio/)

    expect(screen.getByRole('button', { name: 'Server: Mac Studio' })).toBeInTheDocument()
    expect(screen.getByLabelText('Loading usage')).toBeInTheDocument()
    expect(screen.queryByText('5-hour')).toBeNull()
    expect(screen.getByText('Checking')).toBeInTheDocument()
  })

  it('reads a picked server once', async () => {
    answer = async (args) => (args?.targetServer === MAC_STUDIO ? studioResult : usageResult)
    render(<TrayPopup />)
    await screen.findByText('5-hour')
    const before = usageCalls().length

    await pick(/Mac Studio/)
    await screen.findByRole('button', { name: 'Reconnect GitHub Copilot' })
    await act(() => new Promise((resolve) => setTimeout(resolve, 20)))

    expect(usageCalls().slice(before)).toEqual([{ force: false, targetServer: MAC_STUDIO }])
  })

  it('drops an answer for a server that is no longer the picked one', async () => {
    let answerStudio: (result: TrayUsageResult) => void = () => {}
    answer = (args) => (args?.targetServer === MAC_STUDIO
      ? new Promise((resolve) => { answerStudio = resolve })
      : Promise.resolve({ ...usageResult, selected_server_id: String(args?.targetServer) }))
    render(<TrayPopup />)
    await screen.findByText('5-hour')

    await pick(/Mac Studio/)
    await pick(/^Built-in server/)
    await screen.findByText('5-hour')
    await act(async () => answerStudio(studioResult))

    expect(screen.getByRole('button', { name: 'Server: Built-in server' })).toBeInTheDocument()
    expect(screen.getByText('5-hour')).toBeInTheDocument()
  })

  it('says it cannot reach the picked server when reading it fails outright', async () => {
    answer = (args) => (args?.targetServer === MAC_STUDIO ? Promise.reject(new Error('ipc closed')) : Promise.resolve(usageResult))
    render(<TrayPopup />)
    await screen.findByText('5-hour')

    await pick(/Mac Studio/)

    expect(await screen.findByText("Can't reach Mac Studio")).toBeInTheDocument()
    expect(screen.queryByText('5-hour')).toBeNull()
  })

  // The shell falls back to Auto when the picked server went away.
  it('follows the shell when the picked server is gone', async () => {
    answer = async () => usageResult
    render(<TrayPopup />)
    await screen.findByText('5-hour')

    await pick(/Mac Studio/)
    await screen.findByText('5-hour')
    fireEvent.keyDown(document, { key: 'r', metaKey: true })

    await waitFor(() => expect(usageCalls().at(-1)).toEqual({ force: true, targetServer: 'auto' }))
    fireEvent.click(screen.getByRole('button', { name: /^Server/ }))
    expect(within(screen.getByRole('listbox', { name: 'Server' })).getByRole('option', { name: /Auto/ })).toHaveAttribute('aria-selected', 'true')
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

  // The numbers left on screen are old: the failure used to take the place
  // of the one line that said how old.
  it('still says how old the last reading is when a refresh fails', async () => {
    let fail = false
    answer = async () => (fail ? { ...usageResult, error: 'timeout' } : usageResult)
    render(<TrayPopup />)
    expect(await screen.findByText('Checked 2m ago')).toBeInTheDocument()

    fail = true
    fireEvent.keyDown(document, { key: 'r', metaKey: true })

    const alert = await screen.findByRole('alert')
    expect(within(alert).getByText("Couldn't refresh")).toBeInTheDocument()
    expect(within(alert).getByText('· checked 2m ago')).toBeInTheDocument()
  })

  // The popup is one webview kept for the whole run of the app, hidden
  // nearly all of it: the 30 s clock used to wake it the whole time.
  it('runs the "Checked" clock only while the popup is up', async () => {
    const alive = new Set<unknown>()
    const timers = globalThis as unknown as {
      setInterval: (handler: () => void, delay?: number) => unknown
      clearInterval: (id: unknown) => void
    }
    const { setInterval: realSet, clearInterval: realClear } = timers
    timers.setInterval = (handler, delay) => {
      const id = realSet(handler, delay)
      if (delay === 30_000) alive.add(id)
      return id
    }
    timers.clearInterval = (id) => {
      alive.delete(id)
      realClear(id)
    }
    try {
      render(<TrayPopup />)
      await screen.findByText('5-hour')

      act(() => { window.dispatchEvent(new Event('focus')) })
      expect(alive.size).toBe(1)
      act(() => { window.dispatchEvent(new Event('blur')) })
      expect(alive.size).toBe(0)
      act(() => { window.dispatchEvent(new Event('focus')) })
      expect(alive.size).toBe(1)
    } finally {
      timers.setInterval = realSet
      timers.clearInterval = realClear
    }
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
