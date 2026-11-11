import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import React from 'react'
import { act, cleanup, renderHook } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useFakeTimers } from '../fake-timers'

/** What the shell's `app_backend_status` answers: the server the sessions are on. */
let backendStatus: unknown = null
const invoke = mock(async (...args: unknown[]) => (args[0] === 'app_backend_status' ? backendStatus : undefined))
/** Snapshot pushes only (the push also asks which server is in use). */
const pushes = () => invoke.mock.calls.filter((call) => call[0] === 'widget_update_snapshot')
mock.module('@tauri-apps/api/core', () => ({ invoke }))

const { useWidgetSnapshot, WIDGET_PUSH_DEBOUNCE_MS } = await import('@/hooks/use-widget-snapshot')
const { queryKeys } = await import('@/queries')

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
  localStorage.clear()
})

afterEach(() => {
  cleanup()
  timers.restore()
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' })
})

interface PushedSnapshot { inbox: Record<string, unknown>[]; updatedAt: string; server?: string }

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
})
