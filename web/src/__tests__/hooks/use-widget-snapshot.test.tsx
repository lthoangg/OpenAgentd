import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import React from 'react'
import { act, cleanup, renderHook } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useFakeTimers } from '../fake-timers'

/** What the shell's `app_backend_status` answers: the server the sessions are on. */
let backendStatus: unknown = null
/** The shell refuses the snapshot (no widget storage yet, say). */
let failPush = false
const invoke = mock(async (...args: unknown[]) => {
  if (args[0] === 'widget_update_snapshot' && failPush) throw new Error('no widget storage')
  return args[0] === 'app_backend_status' ? backendStatus : undefined
})
/** Snapshot pushes only (the push also asks which server is in use). */
const pushes = () => invoke.mock.calls.filter((call) => call[0] === 'widget_update_snapshot')
mock.module('@tauri-apps/api/core', () => ({ invoke }))

const { useWidgetSnapshot, WIDGET_PUSH_DEBOUNCE_MS } = await import('@/hooks/use-widget-snapshot')
const { forgetWidgetServer } = await import('@/lib/widget-snapshot')
const { setApiBaseUrl } = await import('@/api/base-url')
const { queryKeys } = await import('@/queries')
// The push loads these on first use; loaded here, its import settles in a few microtasks.
await import('@/lib/notification-taps')
await import('@/lib/server-refs')

function sessionPages(ids: string[], extra: Record<string, unknown> = {}) {
  return {
    pages: [{
      data: ids.map((id) => ({
        id,
        title: id,
        agent_name: 'lead',
        created_at: '2026-10-25T11:00:00Z',
        updated_at: '2026-10-25T11:00:00Z',
        workspace: '/w/repo',
        ...extra,
      })),
      next_cursor: null,
      has_more: false,
    }],
    pageParams: [null],
  }
}

function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } })
  client.setQueryData(queryKeys.session.sessions.active(), sessionPages([]))
  client.setQueryData(queryKeys.session.sessions.workspace('__all_coding__', 'activity'), sessionPages(['a']))
  client.setQueryData(queryKeys.scheduler.list(), { tasks: [] })
  // The Chat workspace comes from the workspace tree (no request in a test).
  client.setQueryData(queryKeys.coding.tree(), { repositories: [], chat: null })
  const wrapper = ({ children }: { children: React.ReactNode }) =>
    React.createElement(QueryClientProvider, { client }, children)
  renderHook(() => useWidgetSnapshot(), { wrapper })
  return client
}

async function flushImport() {
  await act(async () => { for (let i = 0; i < 20; i += 1) await Promise.resolve() })
}

/** Let TanStack's batched notify (a zero-delay timeout) re-render, then run the debounce. */
async function settle() {
  act(() => timers.tick(0))
  await flushImport()
  timers.tick(WIDGET_PUSH_DEBOUNCE_MS)
  await flushImport()
}

let timers: ReturnType<typeof useFakeTimers>

beforeEach(() => {
  timers = useFakeTimers()
  invoke.mockClear()
  backendStatus = null
  failPush = false
  localStorage.clear()
})

afterEach(() => {
  cleanup()
  timers.restore()
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' })
  delete window.__OAD_API_BASE_URL__
})

interface PushedSnapshot { inbox: Record<string, unknown>[]; lastSession: unknown; nextTask: unknown; updatedAt: string; server?: string }

function pushed(): PushedSnapshot {
  const call = pushes().at(-1)
  if (!call) throw new Error('no snapshot pushed')
  expect(call[0]).toBe('widget_update_snapshot')
  return (call[1] as { snapshot: PushedSnapshot }).snapshot
}

describe('useWidgetSnapshot', () => {
  it('pushes the snapshot once the session lists load, after a short pause', async () => {
    setup()
    await flushImport()
    expect(pushes()).toHaveLength(0)

    timers.tick(WIDGET_PUSH_DEBOUNCE_MS)
    await flushImport()

    expect(pushes()).toHaveLength(1)
    expect(pushed().inbox.map((row) => row.id)).toEqual(['a'])
  })

  // The lists still held the last server's sessions; the push would have
  // filed them under the new server's token.
  it('pushes nothing built on one server once the app is on another', async () => {
    setApiBaseUrl('http://192.168.1.20:4082')
    setup()
    await flushImport()
    setApiBaseUrl('http://192.168.1.30:4082')

    timers.tick(WIDGET_PUSH_DEBOUNCE_MS)
    await flushImport()
    expect(pushes()).toHaveLength(0)

    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' })
    document.dispatchEvent(new Event('visibilitychange'))
    await flushImport()
    expect(pushes()).toHaveLength(0)

    // Back on the server they are from: they are current again.
    setApiBaseUrl('http://192.168.1.20:4082')
    document.dispatchEvent(new Event('visibilitychange'))
    await flushImport()
    expect(pushed().inbox.map((row) => row.id)).toEqual(['a'])
  })

  it('pushes again when what the widgets show changes, and not otherwise', async () => {
    const client = setup()
    timers.tick(WIDGET_PUSH_DEBOUNCE_MS)
    await flushImport()

    act(() => {
      client.setQueryData(queryKeys.scheduler.list(), { tasks: [] })
    })
    await settle()
    expect(pushes()).toHaveLength(1)

    act(() => {
      client.setQueryData(queryKeys.session.sessions.active(), sessionPages(['a'], { running: true, needs_input: true }))
    })
    await settle()
    expect(pushes()).toHaveLength(2)
    expect(pushed().inbox.map((row) => [row.id, row.state])).toEqual([['a', 'needs_input']])
  })

  it('pushes right away as the app goes to the background', async () => {
    setup()
    await flushImport()

    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' })
    act(() => { document.dispatchEvent(new Event('visibilitychange')) })
    await flushImport()

    expect(pushes()).toHaveLength(1)
    // The pending debounced push carries nothing new.
    timers.tick(WIDGET_PUSH_DEBOUNCE_MS)
    await flushImport()
    expect(pushes()).toHaveLength(1)
  })

  it('names the server the sessions are on by a token, never by its address', async () => {
    backendStatus = { base_url: 'http://192.168.1.20:4082', external: true, sidecar_running: false, supports_bundled: false, servers: [] }
    setup()
    timers.tick(WIDGET_PUSH_DEBOUNCE_MS)
    await flushImport()

    const snapshot = pushed()
    expect(snapshot.server).toMatch(/^[a-z0-9]{8,32}$/)
    expect(JSON.stringify(snapshot)).not.toContain('192.168.1.20')
    const { serverForToken } = await import('@/lib/server-refs')
    expect(serverForToken(snapshot.server!)).toEqual({ baseUrl: 'http://192.168.1.20:4082' })
  })

  // The same content used to count as sent even when the shell refused it.
  it('sends a snapshot again after a push that failed', async () => {
    failPush = true
    const client = setup()
    timers.tick(WIDGET_PUSH_DEBOUNCE_MS)
    await flushImport()
    expect(pushes()).toHaveLength(1)

    failPush = false
    // The lists change in a way the widgets do not show: the content is the same.
    act(() => {
      client.setQueryData(queryKeys.session.sessions.workspace('__all_coding__', 'activity'), sessionPages(['a'], { agent_name: 'reviewer' }))
    })
    await settle()

    expect(pushes()).toHaveLength(2)
    expect(pushed().inbox.map((row) => row.id)).toEqual(['a'])
  })
})

describe('forgetWidgetServer', () => {
  const LAN = { base_url: 'http://192.168.1.20:4082', external: true, sidecar_running: false, supports_bundled: false, servers: [] }

  async function showServer(status: unknown) {
    backendStatus = status
    setup()
    timers.tick(WIDGET_PUSH_DEBOUNCE_MS)
    await flushImport()
    expect(pushed().inbox).toHaveLength(1)
  }

  it('empties the widgets when the server they show is removed from the list', async () => {
    await showServer(LAN)

    await forgetWidgetServer({ baseUrl: 'http://192.168.1.20:4082/' })

    expect(pushes()).toHaveLength(2)
    expect(pushed()).toMatchObject({ inbox: [], lastSession: null, nextTask: null })
    expect(pushed().server).toBeUndefined()
  })

  it('leaves the widgets alone when another server is removed', async () => {
    await showServer(LAN)

    await forgetWidgetServer({ baseUrl: 'http://192.168.1.30:4082' })

    expect(pushes()).toHaveLength(1)
  })

  it('empties the widgets on sign-out when they show a computer of the account', async () => {
    await showServer({ ...LAN, base_url: 'http://127.0.0.1:5999', account_device: { device_id: 'dev-mac', fingerprint: '3F9A 21C4', kind: 'macos' } })

    await forgetWidgetServer({ account: true })

    expect(pushed()).toMatchObject({ inbox: [], lastSession: null })
  })

  it('keeps a saved server\'s sessions on the widgets through a sign-out', async () => {
    await showServer(LAN)

    await forgetWidgetServer({ account: true })

    expect(pushes()).toHaveLength(1)
  })
})
