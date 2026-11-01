import { beforeEach, describe, expect, it } from 'bun:test'

import { LAYOUT_STORAGE_KEY, useLayoutStore, windowLayoutStorage } from '@/stores/useLayoutStore'
import { DOCK_DEFAULT_RATIO, DOCK_SPLIT_DEFAULT_RATIO } from '@/lib/workbench-layout'

beforeEach(() => {
  useLayoutStore.setState({ sidebarCollapsed: null, sidebarWidth: 264, dockRatio: DOCK_DEFAULT_RATIO, dockSplitRatio: DOCK_SPLIT_DEFAULT_RATIO, dockOpen: false, dockMaximized: false })
  localStorage.clear()
  sessionStorage.clear()
})

function persisted(): Record<string, unknown> {
  const raw = localStorage.getItem(LAYOUT_STORAGE_KEY)
  return raw ? (JSON.parse(raw).state as Record<string, unknown>) : {}
}

describe('useLayoutStore', () => {
  it('resolves functional collapse updates from the fallback until the user chooses', () => {
    useLayoutStore.getState().setSidebarCollapsed((prev) => !prev, false)
    expect(useLayoutStore.getState().sidebarCollapsed).toBe(true)
    useLayoutStore.getState().setSidebarCollapsed((prev) => !prev, true)
    expect(useLayoutStore.getState().sidebarCollapsed).toBe(false)
  })

  it('persists sidebar and dock geometry but never the maximized flag', () => {
    const store = useLayoutStore.getState()
    store.setSidebarWidth(300.4)
    store.setDockRatio(0.6)
    store.setDockMaximized(true)
    const saved = persisted()
    expect(saved.sidebarWidth).toBe(300)
    expect(saved.dockRatio).toBe(0.6)
    expect('dockMaximized' in saved).toBe(false)
    expect(useLayoutStore.getState().dockMaximized).toBe(true)
  })

  it('ignores out-of-range dock ratios and resets to the default', () => {
    const store = useLayoutStore.getState()
    store.setDockRatio(1.5)
    expect(useLayoutStore.getState().dockRatio).toBe(DOCK_DEFAULT_RATIO)
    store.setDockRatio(0.3)
    store.resetDockRatio()
    expect(useLayoutStore.getState().dockRatio).toBe(DOCK_DEFAULT_RATIO)
  })

  it('toggles maximize', () => {
    useLayoutStore.getState().toggleDockMaximized()
    expect(useLayoutStore.getState().dockMaximized).toBe(true)
    useLayoutStore.getState().toggleDockMaximized()
    expect(useLayoutStore.getState().dockMaximized).toBe(false)
  })

  it('remembers whether the Review panel is open and how it is split', () => {
    const store = useLayoutStore.getState()
    store.setDockOpen(true)
    store.setDockSplitRatio(0.7)
    expect(persisted().dockOpen).toBe(true)
    expect(persisted().dockSplitRatio).toBe(0.7)
    store.setDockSplitRatio(1.2)
    expect(useLayoutStore.getState().dockSplitRatio).toBe(0.7)
  })

  it('keeps each window to its own layout, and seeds a new window from the last one saved', () => {
    localStorage.setItem(LAYOUT_STORAGE_KEY, '{"state":{"sidebarWidth":300}}')
    // A new window has nothing of its own yet: it starts from the last layout.
    expect(windowLayoutStorage.getItem(LAYOUT_STORAGE_KEY)).toBe('{"state":{"sidebarWidth":300}}')
    windowLayoutStorage.setItem(LAYOUT_STORAGE_KEY, '{"state":{"sidebarWidth":320}}')
    expect(sessionStorage.getItem(LAYOUT_STORAGE_KEY)).toBe('{"state":{"sidebarWidth":320}}')
    // Another window saving later does not move this one.
    localStorage.setItem(LAYOUT_STORAGE_KEY, '{"state":{"sidebarWidth":400}}')
    expect(windowLayoutStorage.getItem(LAYOUT_STORAGE_KEY)).toBe('{"state":{"sidebarWidth":320}}')
  })

  it('resets the layout to its defaults', () => {
    const store = useLayoutStore.getState()
    store.setSidebarWidth(400)
    store.setDockRatio(0.7)
    store.setDockSplitRatio(0.3)
    store.setDockMaximized(true)
    store.setSidebarCollapsed(true, false)
    store.resetLayout()
    const state = useLayoutStore.getState()
    expect(state.sidebarWidth).toBe(264)
    expect(state.dockRatio).toBe(DOCK_DEFAULT_RATIO)
    expect(state.dockSplitRatio).toBe(DOCK_SPLIT_DEFAULT_RATIO)
    expect(state.dockMaximized).toBe(false)
    expect(state.sidebarCollapsed).toBeNull()
  })
})
