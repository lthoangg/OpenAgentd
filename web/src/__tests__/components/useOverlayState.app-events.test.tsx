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

function wrapper({ children }: { children: React.ReactNode }) {
  return <QueryClientProvider client={new QueryClient()}>{children}</QueryClientProvider>
}

function renderOverlay(overrides: Partial<UseOverlayStateArgs> = {}) {
  const args: UseOverlayStateArgs = {
    isMobile: false,
    workspace: '/repo/project',
    toggleScheduler: mock(() => useUIStore.getState().toggleScheduler()),
    toggleAgentCapabilities: mock(() => {}),
    togglePalette: mock(() => {}),
    toggleQuickOpen: mock(() => {}),
    ...overrides,
  }
  return { args, ...renderHook(() => useOverlayState(args), { wrapper }) }
}

beforeEach(() => {
  useUIStore.setState({
    schedulerOpen: false,
    agentCapabilitiesOpen: false,
    paletteOpen: false,
    quickOpenOpen: false,
    schedulerOpenPending: false,
    scheduledTaskFocus: null,
  })
})
afterEach(cleanup)

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
    useLayoutStore.getState().setSidebarCollapsed(true, false)
    const { result } = renderOverlay()

    act(() => dispatchAppEvent(APP_EVENTS.openWorkspace))

    expect(result.current.openWorkspaceDialogKey).toBe(1)
    expect(result.current.sidebarCollapsed).toBe(false)
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
