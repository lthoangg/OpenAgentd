import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, renderHook } from '@testing-library/react'

// The store's busy frames are covered in useTerminalStore.test.ts; here only
// the finished event, the sessions and which terminal is on screen matter.
type Listener = (id: string, durationMs: number) => void
const listeners = new Set<Listener>()
const sessions: Record<string, { title: string; contextKey: string }> = {}
const attached = new Set<string>()

mock.module('@/stores/useTerminalStore', () => ({
  onTerminalCommandFinished: (listener: Listener) => {
    listeners.add(listener)
    return () => listeners.delete(listener)
  },
  getTerminalRuntime: (id: string) => ({ attached: attached.has(id) }),
  useTerminalStore: { getState: () => ({ sessions }) },
}))

const { TERMINAL_FINISHED_NOTICE_MS, useTerminalFinishedNotice } = await import('@/components/Terminal/use-terminal-finished-notice')
const { useToastStore } = await import('@/stores/useToastStore')

const finish = (id: string, durationMs: number) => {
  for (const listener of listeners) listener(id, durationMs)
}

beforeEach(() => {
  useToastStore.setState({ toasts: [] })
  sessions['1'] = { title: 'Terminal 1', contextKey: '/repo' }
  sessions['2'] = { title: 'Server', contextKey: '/other' }
  attached.clear()
})
afterEach(cleanup)

describe('useTerminalFinishedNotice', () => {
  it('says when a long command finishes in a hidden terminal, and Show brings it up', () => {
    const onShow = mock(() => {})
    renderHook(() => useTerminalFinishedNotice('/repo', onShow))
    finish('1', TERMINAL_FINISHED_NOTICE_MS)
    const [toast] = useToastStore.getState().toasts
    expect(toast?.title).toBe('Terminal 1 · Command finished')
    expect(toast?.action?.label).toBe('Show')
    toast?.action?.onAction()
    expect(onShow).toHaveBeenCalledWith('1')
  })

  it('stays quiet for a short command', () => {
    renderHook(() => useTerminalFinishedNotice('/repo', () => {}))
    finish('1', TERMINAL_FINISHED_NOTICE_MS - 1)
    expect(useToastStore.getState().toasts).toHaveLength(0)
  })

  it('stays quiet for the terminal on screen', () => {
    attached.add('1')
    renderHook(() => useTerminalFinishedNotice('/repo', () => {}))
    finish('1', 60_000)
    expect(useToastStore.getState().toasts).toHaveLength(0)
  })

  it("ignores another workspace's terminals, and does nothing without a workspace", () => {
    renderHook(() => useTerminalFinishedNotice('/repo', () => {}))
    finish('2', 60_000)
    expect(useToastStore.getState().toasts).toHaveLength(0)
    cleanup()
    renderHook(() => useTerminalFinishedNotice(null, () => {}))
    finish('1', 60_000)
    expect(useToastStore.getState().toasts).toHaveLength(0)
  })
})
