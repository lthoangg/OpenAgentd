import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { act, cleanup, renderHook } from '@testing-library/react'

import { UNREAD_STORAGE_KEY, useMarkSessionRead, useUnreadStore } from '@/stores/useUnreadStore'

function setVisibility(state: DocumentVisibilityState) {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state })
  document.dispatchEvent(new Event('visibilitychange'))
}

beforeEach(() => {
  useUnreadStore.setState({ ids: [], failed: [] })
  localStorage.removeItem(UNREAD_STORAGE_KEY)
  setVisibility('visible')
})

afterEach(cleanup)

describe('useUnreadStore', () => {
  it('marks a session unread once and reads it back', () => {
    useUnreadStore.getState().markUnread('a')
    useUnreadStore.getState().markUnread('a')
    expect(useUnreadStore.getState().ids).toEqual(['a'])

    useUnreadStore.getState().markRead('a')
    expect(useUnreadStore.getState().ids).toEqual([])
  })

  it('persists the unread ids', () => {
    useUnreadStore.getState().markUnread('a')
    const saved = JSON.parse(localStorage.getItem(UNREAD_STORAGE_KEY) ?? '{}') as { state?: unknown }
    expect(saved.state).toEqual({ ids: ['a'], failed: [] })
  })

  it('remembers which unread sessions ended in an error, until read', () => {
    useUnreadStore.getState().markUnread('ok')
    useUnreadStore.getState().markUnread('broken', { failed: true })
    expect(useUnreadStore.getState().failed).toEqual(['broken'])

    // A later clean finish replaces the failure.
    useUnreadStore.getState().markUnread('broken')
    expect(useUnreadStore.getState().failed).toEqual([])

    useUnreadStore.getState().markUnread('broken', { failed: true })
    useUnreadStore.getState().markRead('broken')
    expect(useUnreadStore.getState()).toMatchObject({ ids: ['ok'], failed: [] })
  })

  it('keeps only the newest 200 sessions', () => {
    for (let i = 0; i < 205; i += 1) useUnreadStore.getState().markUnread(`s${i}`)
    const { ids } = useUnreadStore.getState()
    expect(ids).toHaveLength(200)
    expect(ids[0]).toBe('s5')
    expect(ids.at(-1)).toBe('s204')
  })

  it('takes the list another window wrote', async () => {
    useUnreadStore.getState().markUnread('mine')
    localStorage.setItem(UNREAD_STORAGE_KEY, JSON.stringify({ state: { ids: ['theirs'], failed: ['theirs'] }, version: 0 }))

    window.dispatchEvent(new StorageEvent('storage', { key: UNREAD_STORAGE_KEY }))
    await Promise.resolve()

    expect(useUnreadStore.getState().ids).toEqual(['theirs'])
    expect(useUnreadStore.getState().failed).toEqual(['theirs'])
  })
})

describe('useMarkSessionRead', () => {
  it('reads the session it shows', () => {
    useUnreadStore.getState().markUnread('a')
    useUnreadStore.getState().markUnread('b')

    renderHook(() => useMarkSessionRead('a'))

    expect(useUnreadStore.getState().ids).toEqual(['b'])
  })

  it('waits until the window is visible', () => {
    setVisibility('hidden')
    useUnreadStore.getState().markUnread('a')

    renderHook(() => useMarkSessionRead('a'))
    expect(useUnreadStore.getState().ids).toEqual(['a'])

    act(() => setVisibility('visible'))
    expect(useUnreadStore.getState().ids).toEqual([])
  })

  it('clears a mark set while the session is on screen', () => {
    renderHook(() => useMarkSessionRead('a'))

    act(() => useUnreadStore.getState().markUnread('a'))

    expect(useUnreadStore.getState().ids).toEqual([])
  })
})
