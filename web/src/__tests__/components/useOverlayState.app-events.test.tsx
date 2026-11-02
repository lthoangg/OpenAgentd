/**
 * useOverlayState — app events.
 *
 * Native menus and other shells reach chat-shell actions that have no
 * keyboard shortcut through window events (``APP_EVENTS``).
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import type React from 'react'
import { act, cleanup, renderHook } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useOverlayState, type UseOverlayStateArgs } from '@/components/AgentChatView/useOverlayState'
import { APP_EVENTS, dispatchAppEvent } from '@/lib/app-events'
import { useUIStore } from '@/stores/useUIStore'
import { useLayoutStore } from '@/stores/useLayoutStore'

const DEFAULT_WIDTH = window.innerWidth

function setViewportWidth(width: number) {
  Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: width })
  window.dispatchEvent(new Event('resize'))
}

const realMatchMedia = window.matchMedia
/** A touch-first device: ``(pointer: coarse)`` matches. */
function setTouchFirst(touch: boolean) {
  window.matchMedia = ((query: string) => ({
    matches: touch && query === '(pointer: coarse)',
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia
}

function wrapper({ children }: { children: React.ReactNode }) {
  return <QueryClientProvider client={new QueryClient()}>{children}</QueryClientProvider>
}

function renderOverlay(overrides: Partial<UseOverlayStateArgs> = {}) {
  const args: UseOverlayStateArgs = {
    isMobile: false,
    workspace: '/repo/project',
    toggleScheduler: mock(() => useUIStore.getState().toggleScheduler()),
    toggleRunPicker: mock(() => {}),
    togglePalette: mock(() => {}),
    toggleQuickOpen: mock(() => {}),
    ...overrides,
  }
  return { args, ...renderHook(() => useOverlayState(args), { wrapper }) }
}

beforeEach(() => {
  useUIStore.setState({
    schedulerOpen: false,
    runPickerOpen: false,
    paletteOpen: false,
    quickOpenOpen: false,
    schedulerOpenPending: false,
    scheduledTaskFocus: null,
  })
})
afterEach(() => {
  cleanup()
  setViewportWidth(DEFAULT_WIDTH)
  window.matchMedia = realMatchMedia
})

describe('useOverlayState app events', () => {
  it('opens the scheduler dock tab on toggleScheduler', () => {
    const { result } = renderOverlay()

    act(() => dispatchAppEvent(APP_EVENTS.toggleScheduler))

    expect(result.current.workspacePanel).toBe('changed')
    expect(result.current.dockViewRequest).toEqual({ view: 'schedule', key: 1 })
  })

  it('falls back to the scheduler overlay without a workspace', () => {
    const { args } = renderOverlay({ workspace: null })

    act(() => dispatchAppEvent(APP_EVENTS.toggleScheduler))

    expect(args.toggleScheduler).toHaveBeenCalledTimes(1)
    expect(useUIStore.getState().schedulerOpen).toBe(true)
  })

  // A sidebar task opens the scheduler on it; asking again must not close it.
  it('opens the scheduler and keeps it open on openScheduler', () => {
    const { result } = renderOverlay()

    act(() => dispatchAppEvent(APP_EVENTS.openScheduler))
    act(() => dispatchAppEvent(APP_EVENTS.openScheduler))

    expect(result.current.workspacePanel).toBe('changed')
    expect(result.current.dockViewRequest).toEqual({ view: 'schedule', key: 2 })

    cleanup()
    renderOverlay({ workspace: null })
    act(() => dispatchAppEvent(APP_EVENTS.openScheduler))
    act(() => dispatchAppEvent(APP_EVENTS.openScheduler))
    expect(useUIStore.getState().schedulerOpen).toBe(true)
  })

  it('expands the sidebar and requests the folder picker on openWorkspace', () => {
    setViewportWidth(1440)
    useLayoutStore.getState().setSidebarCollapsed(true, false)
    const { result } = renderOverlay()

    act(() => dispatchAppEvent(APP_EVENTS.openWorkspace))

    expect(result.current.openWorkspaceDialogKey).toBe(1)
    expect(result.current.sidebarCollapsed).toBe(false)
  })

  // A narrow desktop window still pushes the chat with the sidebar, as
  // desktop apps do, while the chat keeps its width beside it.
  it('pushes the chat with the sidebar in an 856px desktop window', () => {
    setViewportWidth(856)
    useLayoutStore.getState().setSidebarCollapsed(true, false)
    const { result } = renderOverlay()
    expect(result.current.sidebarDrawer).toBe(false)

    act(() => result.current.handleSidebarToggle())

    expect(result.current.sidebarCollapsed).toBe(false)
    expect(result.current.sidebarDrawerOpen).toBe(false)
  })

  // With the Review panel open there is no room to push: the sidebar covers
  // the chat as a drawer, and the remembered column state is left alone.
  it('makes the sidebar a drawer in an 856px window while the Review panel is open', () => {
    setViewportWidth(856)
    useLayoutStore.getState().setSidebarCollapsed(false, false)
    const { result } = renderOverlay()
    expect(result.current.sidebarDrawer).toBe(false)

    act(() => result.current.handleOpenGit())

    expect(result.current.sidebarDrawer).toBe(true)
    expect(result.current.sidebarDrawerOpen).toBe(false)
    act(() => result.current.handleSidebarToggle())
    expect(result.current.sidebarDrawerOpen).toBe(true)
    expect(useLayoutStore.getState().sidebarCollapsed).toBe(false)
  })

  // Below 1180 px a touch tablet's sidebar is a drawer over the chat: it
  // opens instead, and the remembered column state is left alone.
  it('opens the sidebar drawer on openWorkspace on a narrow touch tablet', () => {
    setTouchFirst(true)
    setViewportWidth(1024)
    useLayoutStore.getState().setSidebarCollapsed(true, false)
    const { result } = renderOverlay()
    expect(result.current.sidebarDrawer).toBe(true)

    act(() => dispatchAppEvent(APP_EVENTS.openWorkspace))

    expect(result.current.openWorkspaceDialogKey).toBe(1)
    expect(result.current.sidebarDrawerOpen).toBe(true)
    expect(useLayoutStore.getState().sidebarCollapsed).toBe(true)
  })

  it('closes the drawer once the window is wide enough for the sidebar column', () => {
    setTouchFirst(true)
    setViewportWidth(1024)
    const { result } = renderOverlay()
    act(() => result.current.handleSidebarToggle())
    expect(result.current.sidebarDrawerOpen).toBe(true)

    act(() => setViewportWidth(1440))

    expect(result.current.sidebarDrawer).toBe(false)
    expect(result.current.sidebarDrawerOpen).toBe(false)
  })

  it('focus mode hides the sidebar and the Review panel, and puts both back', () => {
    setViewportWidth(1440)
    useLayoutStore.getState().setSidebarCollapsed(false, false)
    const { result } = renderOverlay()
    act(() => result.current.handleOpenGit())
    expect(result.current.workspacePanel).toBe('changed')

    act(() => dispatchAppEvent(APP_EVENTS.toggleFocusMode))
    expect(result.current.focusMode).toBe(true)
    expect(result.current.sidebarCollapsed).toBe(true)
    expect(result.current.workspacePanel).toBeNull()

    act(() => dispatchAppEvent(APP_EVENTS.toggleFocusMode))
    expect(result.current.focusMode).toBe(false)
    expect(result.current.sidebarCollapsed).toBe(false)
    expect(result.current.workspacePanel).toBe('changed')
  })

  it('showing the sidebar in focus mode ends it, as is', () => {
    setViewportWidth(1440)
    useLayoutStore.getState().setSidebarCollapsed(false, false)
    const { result } = renderOverlay()
    act(() => result.current.handleOpenGit())
    act(() => dispatchAppEvent(APP_EVENTS.toggleFocusMode))

    act(() => result.current.handleSidebarToggle())

    expect(result.current.focusMode).toBe(false)
    expect(result.current.sidebarCollapsed).toBe(false)
    // The Review panel stays hidden: focus mode ended without restoring it.
    expect(result.current.workspacePanel).toBeNull()
  })

  it('opens the Review panel and asks it to split on splitReviewPanel', () => {
    const { result } = renderOverlay()

    act(() => dispatchAppEvent(APP_EVENTS.splitReviewPanel))

    expect(result.current.workspacePanel).toBe('changed')
    expect(result.current.dockLayoutRequest).toEqual({ action: 'split', key: 1 })
  })

  it('asks to show the terminal group with the panel closed, and to toggle it once open', () => {
    const { result } = renderOverlay()

    act(() => dispatchAppEvent(APP_EVENTS.toggleTerminalGroup))
    expect(result.current.workspacePanel).toBe('changed')
    expect(result.current.dockLayoutRequest).toEqual({ action: 'terminal-show', key: 1 })

    act(() => dispatchAppEvent(APP_EVENTS.toggleTerminalGroup))
    expect(result.current.dockLayoutRequest).toEqual({ action: 'terminal-toggle', key: 2 })
  })

  it('opens a terminal tab for the terminal key on phones (one strip, no groups)', () => {
    const { result } = renderOverlay({ isMobile: true })

    act(() => dispatchAppEvent(APP_EVENTS.toggleTerminalGroup))

    expect(result.current.dockLayoutRequest).toBeNull()
    expect(result.current.terminalOpenKey).toBe(1)
  })

  it('opens a terminal tab on openTerminal', () => {
    const { result } = renderOverlay()

    act(() => dispatchAppEvent(APP_EVENTS.openTerminal))

    expect(result.current.workspacePanel).toBe('files')
    expect(result.current.terminalOpenKey).toBe(1)
  })

  // The transcript's plan review card opens the plan through this event.
  it('opens the Plan tab on openPlan', () => {
    const { result } = renderOverlay()

    act(() => dispatchAppEvent(APP_EVENTS.openPlan))

    expect(result.current.workspacePanel).toBe('changed')
    expect(result.current.dockViewRequest).toEqual({ view: 'plan', key: 1 })
  })

  it('stops listening once unmounted', () => {
    const { args, unmount } = renderOverlay({ workspace: null })
    unmount()

    dispatchAppEvent(APP_EVENTS.toggleScheduler)

    expect(args.toggleScheduler).not.toHaveBeenCalled()
  })

  // The home-screen widget's deep link can arrive before the chat view mounts.
  it('opens the scheduler a deep link asked for before it mounted, once', () => {
    useUIStore.getState().requestSchedulerOpen('task-7')

    const { result } = renderOverlay()

    expect(result.current.dockViewRequest).toEqual({ view: 'schedule', key: 1 })
    expect(useUIStore.getState().scheduledTaskFocus).toBe('task-7')
    expect(useUIStore.getState().schedulerOpenPending).toBe(false)

    cleanup()
    const again = renderOverlay()
    expect(again.result.current.dockViewRequest).toBeNull()
  })

  it('opens the scheduler when a deep link asks while mounted', () => {
    const { result } = renderOverlay()

    act(() => useUIStore.getState().requestSchedulerOpen(null))

    expect(result.current.dockViewRequest).toEqual({ view: 'schedule', key: 1 })
  })
})
