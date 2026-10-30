/**
 * In the desktop app, reading a session is shared with the notch island,
 * the pet and the other windows through the shell.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'

let platform = { isTauri: true, os: 'macos', isMacOverlay: false }
let calls: [string, unknown][] = []
const handlers = new Map<string, (event: { payload: unknown }) => void>()

mock.module('@/hooks/use-platform', () => ({
  usePlatform: () => platform,
  getPlatform: () => platform,
}))
mock.module('@tauri-apps/api/core', () => ({
  invoke: async (cmd: string, args?: unknown) => {
    calls.push([cmd, args])
  },
}))
mock.module('@tauri-apps/api/event', () => ({
  listen: async (event: string, handler: (event: { payload: unknown }) => void) => {
    handlers.set(event, handler)
    return () => handlers.delete(event)
  },
}))

const { SESSION_READ_EVENT, installSessionReadSync, useUnreadStore } = await import('@/stores/useUnreadStore')

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))
let uninstall: () => void = () => {}

beforeEach(() => {
  platform = { isTauri: true, os: 'macos', isMacOverlay: false }
  calls = []
  handlers.clear()
  useUnreadStore.setState({ ids: [] })
})
afterEach(() => uninstall())

describe('sharing reads with the desktop shell', () => {
  it('reports a session read here', async () => {
    useUnreadStore.setState({ ids: ['a', 'b'] })
    useUnreadStore.getState().markRead('a')
    await tick()
    expect(useUnreadStore.getState().ids).toEqual(['b'])
    expect(calls).toEqual([['session_read', { sessionId: 'a' }]])
  })

  it('reports nothing when the session was not unread', async () => {
    useUnreadStore.getState().markRead('a')
    await tick()
    expect(calls).toEqual([])
  })

  it('clears a session read in the notch, the pet or another window, without reporting it back', async () => {
    uninstall = installSessionReadSync()
    await tick()
    useUnreadStore.setState({ ids: ['aa-bb-cc', 'dd'] })
    handlers.get(SESSION_READ_EVENT)?.({ payload: { sessionId: 'AABBCC' } })
    expect(useUnreadStore.getState().ids).toEqual(['dd'])
    handlers.get(SESSION_READ_EVENT)?.({ payload: { sessionId: 42 } })
    expect(useUnreadStore.getState().ids).toEqual(['dd'])
    await tick()
    expect(calls).toEqual([])
  })

  it('stays out of the browser and the mobile apps', async () => {
    for (const next of [{ isTauri: false, os: 'macos' }, { isTauri: true, os: 'ios' }]) {
      platform = { ...next, isMacOverlay: false }
      useUnreadStore.setState({ ids: ['a'] })
      useUnreadStore.getState().markRead('a')
      uninstall = installSessionReadSync()
      await tick()
    }
    expect(calls).toEqual([])
    expect(handlers.size).toBe(0)
  })
})
