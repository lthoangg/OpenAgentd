import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import '@testing-library/jest-dom'
import type { TrayUsageResult } from '@/tray/usage'

const NOW = Math.floor(Date.now() / 1000)

const usageResult: TrayUsageResult = {
  server_name: 'Local Bundled',
  server_id: 'bundled',
  selected_server_id: 'auto',
  servers: [
    { id: 'auto', name: 'Auto (Active Window)', detail: 'Local Bundled' },
    { id: 'bundled', name: 'Local Bundled', detail: null },
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
mock.module('@tauri-apps/api/event', () => ({
  listen: async () => {
    if (listenDelayMs) await new Promise((resolve) => setTimeout(resolve, listenDelayMs))
    activeListeners++
    return () => {
      activeListeners--
    }
  },
}))

const { TrayPopup } = await import('@/tray/TrayPopup')

const actions = () => calls.filter(([cmd]) => cmd === 'tray_action').map(([, args]) => args?.action)
const usageCalls = () => calls.filter(([cmd]) => cmd === 'get_tray_usage_summary').map(([, args]) => args)

beforeEach(() => {
  calls = []
  answer = async () => usageResult
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

  it('exposes each limit as a meter', async () => {
    render(<TrayPopup />)

    const meter = await screen.findByRole('meter', { name: 'OpenAI Codex 5-hour' })
    expect(meter).toHaveAttribute('aria-valuenow', '42')
    expect(screen.getByRole('meter', { name: 'OpenAI Codex Weekly' })).toHaveAttribute('aria-valuenow', '76')
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

    expect(await screen.findByText("Can't reach Local Bundled")).toBeInTheDocument()
    expect(screen.getByText('Offline')).toBeInTheDocument()
    expect(screen.queryByText(/error sending request/)).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(usageCalls().at(-1)).toMatchObject({ force: true }))
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

    for (const name of ['Open OpenAgentd', 'New session', 'Settings', 'Quit OpenAgentd']) {
      fireEvent.click(screen.getByRole('button', { name: new RegExp(`^${name}`) }))
    }
    expect(actions()).toEqual(['show', 'new_session', 'settings', 'quit'])
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
    expect(actions()).toEqual(['new_session', 'settings', 'quit'])
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
