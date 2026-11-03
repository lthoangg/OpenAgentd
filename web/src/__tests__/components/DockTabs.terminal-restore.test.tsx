/**
 * Terminals across a reload, seen from the dock: restored shells keep their
 * saved order and the previously active one is shown (only when restore is
 * what fills the pane), and "Open terminal" right after a reload waits for
 * the restore instead of spawning an extra shell.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'

import { useFakeTimers } from '../fake-timers'

type SessionInfo = { session_id: string; workspace: string; created_at: number; attached: boolean; busy: boolean }
const fn = (impl: (...args: never[]) => unknown) => mock(impl as unknown as (...args: unknown[]) => unknown)

const WS = '/w'
let sessionList: SessionInfo[] = []
let listGate: Promise<void> | null = null
let spawned = 0
const connectOptions: Array<{ sessionId?: string; since?: number } | undefined> = []

mock.module('@/api/terminal', () => ({
  connectTerminal: fn(async (_t: unknown, _cb: unknown, _size: unknown, options?: { sessionId?: string; since?: number }) => {
    connectOptions.push(options)
    return {
      protocol: 2,
      sessionId: options?.sessionId ?? `new-${++spawned}`,
      sendInput: () => {},
      sendResize: () => {},
      close: () => {},
    }
  }),
}))
mock.module('@/api/terminal-sessions', () => ({
  listTerminalSessions: fn(async () => {
    if (listGate) await listGate
    return sessionList
  }),
  deleteTerminalSession: fn(async () => {}),
}))

const { useTerminalStore, _resetTerminalStoreForTests, TERMINAL_LAYOUT_KEY, TERMINAL_RESTORE_WAIT_MS } =
  await import('@/stores/useTerminalStore')
const { _resetKeyboardForTests } = await import('@/lib/keyboard/dispatcher')
const { useDockTabs } = await import('@/components/WorkspacePanel/useDockTabs')
const { terminalTabId } = await import('@/components/WorkspacePanel/dock-tabs')

const info = (session_id: string, created_at: number, attached = false): SessionInfo => ({
  session_id,
  workspace: WS,
  created_at,
  attached,
  busy: false,
})
const saveLayout = (order: string[], active?: string) =>
  localStorage.setItem(TERMINAL_LAYOUT_KEY, JSON.stringify({ [WS]: { order, active } }))
const savedLayout = () =>
  (JSON.parse(localStorage.getItem(TERMINAL_LAYOUT_KEY) ?? '{}') as Record<string, { order: string[]; active?: string }>)[WS]
const sessions = () => useTerminalStore.getState().sessionsForContext(WS)
const idOf = (backendId: string) => sessions().find((m) => m.backendId === backendId)!.id

let release: () => void
const holdList = () => {
  listGate = new Promise<void>((r) => (release = r))
}

beforeEach(() => {
  _resetKeyboardForTests()
  _resetTerminalStoreForTests()
  sessionList = []
  listGate = null
  spawned = 0
  connectOptions.length = 0
  localStorage.removeItem(TERMINAL_LAYOUT_KEY)
  localStorage.removeItem('oad:terminal-titles')
})
afterEach(cleanup)

function renderTabs(terminalOpenKey = 0) {
  return renderHook(
    ({ key }: { key: number }) => useDockTabs({ workspace: WS, chatWorkspace: false, terminalOpenKey: key, viewRequest: null }),
    { initialProps: { key: terminalOpenKey } },
  )
}

const terminalTabs = (visible: ReadonlyArray<{ type: string; termId?: string }>) =>
  visible.filter((t) => t.type === 'terminal').map((t) => useTerminalStore.getState().sessions[t.termId!]?.backendId)

describe('restore in the dock', () => {
  it('shows restored shells in their saved order with the previously active one on show', async () => {
    sessionList = [info('a', 1), info('b', 2), info('c', 3)]
    saveLayout(['c', 'a', 'b'], 'a')
    const { result } = renderTabs()
    await waitFor(() => expect(sessions()).toHaveLength(3))
    await waitFor(() => expect(result.current.activeTabId).toBe(terminalTabId(idOf('a'))))
    expect(terminalTabs(result.current.visibleTabs)).toEqual(['c', 'a', 'b'])
  })

  it('leaves a file the user is on in front', async () => {
    sessionList = [info('a', 1), info('b', 2)]
    saveLayout(['a', 'b'], 'b')
    holdList()
    const { result } = renderTabs()
    act(() =>
      result.current.openFileTab({ path: '/w/x.ts', name: 'x.ts', size: 1, mtime: 0, mime: 'text/plain' }),
    )
    release()
    await waitFor(() => expect(sessions()).toHaveLength(2))
    await waitFor(() => expect(terminalTabs(result.current.visibleTabs)).toEqual(['a', 'b']))
    expect(result.current.activeTab?.type).toBe('file')
  })

  it('writes the dock tab order back, so a reordered strip survives the next reload', async () => {
    sessionList = [info('a', 1), info('b', 2), info('c', 3)]
    saveLayout(['a', 'b', 'c'], 'a')
    const { result } = renderTabs()
    await waitFor(() => expect(terminalTabs(result.current.visibleTabs)).toEqual(['a', 'b', 'c']))
    act(() => result.current.moveWithin(terminalTabId(idOf('c')), 0))
    await waitFor(() => expect(terminalTabs(result.current.visibleTabs)[0]).toBe('c'))
    expect(savedLayout().order).toEqual(terminalTabs(result.current.visibleTabs) as string[])
  })

  it('does not wipe the saved order while the restore is still running', async () => {
    sessionList = [info('a', 1), info('b', 2)]
    saveLayout(['b', 'a'], 'b')
    holdList()
    renderTabs()
    await new Promise((r) => setTimeout(r, 20))
    expect(savedLayout().order).toEqual(['b', 'a'])
    release()
    await waitFor(() => expect(sessions()).toHaveLength(2))
    expect(savedLayout().order).toEqual(['b', 'a'])
  })
})

describe('Open terminal right after a reload', () => {
  it('waits for the restore and shows the previously active shell instead of spawning a new one', async () => {
    sessionList = [info('a', 1), info('b', 2)]
    saveLayout(['a', 'b'], 'a')
    holdList()
    const { result } = renderTabs(1)
    expect(sessions()).toHaveLength(0) // nothing spawned while the list is in flight
    expect(connectOptions).toHaveLength(0)
    release()
    await waitFor(() => expect(result.current.activeTabId).toBe(terminalTabId(idOf('a'))))
    expect(sessions()).toHaveLength(2)
    expect(connectOptions.every((o) => o?.sessionId !== undefined)).toBe(true)
    expect(spawned).toBe(0)
  })

  it('falls back to the last shell when no active one was saved', async () => {
    sessionList = [info('a', 1), info('b', 2)]
    holdList()
    const { result } = renderTabs(1)
    release()
    await waitFor(() => expect(result.current.activeTabId).toBe(terminalTabId(idOf('b'))))
    expect(spawned).toBe(0)
  })

  it('spawns exactly one shell when nothing came back', async () => {
    holdList()
    const { result } = renderTabs(1)
    expect(sessions()).toHaveLength(0)
    release()
    await waitFor(() => expect(sessions()).toHaveLength(1))
    expect(connectOptions[0]).toBeUndefined() // a new shell, not a reattach
    expect(result.current.activeTab?.type).toBe('terminal')
  })

  it('does not wait longer than the bound for a server that does not answer', async () => {
    const timers = useFakeTimers()
    try {
      listGate = new Promise<void>(() => {})
      renderTabs(1)
      expect(sessions()).toHaveLength(0)
      await act(async () => {
        timers.tick(TERMINAL_RESTORE_WAIT_MS - 1)
      })
      expect(sessions()).toHaveLength(0)
      await act(async () => {
        timers.tick(1)
      })
      expect(sessions()).toHaveLength(1)
    } finally {
      timers.restore()
    }
  })

  it('acts at once when no restore is pending (the old behaviour)', async () => {
    const first = renderTabs(1)
    await waitFor(() => expect(sessions()).toHaveLength(1))
    first.unmount()
    const { result, rerender } = renderTabs(0)
    await waitFor(() => expect(result.current.visibleTabs).toHaveLength(1))
    // The restore is long done: the request focuses the shell that exists, synchronously.
    act(() => rerender({ key: 2 }))
    expect(sessions()).toHaveLength(1)
    expect(result.current.activeTab?.type).toBe('terminal')
  })

  it('does nothing if the dock went away while it waited', async () => {
    holdList()
    const { unmount } = renderTabs(1)
    unmount()
    release()
    await new Promise((r) => setTimeout(r, 20))
    expect(sessions()).toHaveLength(0)
  })
})
