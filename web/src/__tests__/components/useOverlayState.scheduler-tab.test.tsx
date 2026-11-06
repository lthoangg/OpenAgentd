/**
 * useOverlayState — scheduled tasks open as a Review panel tab.
 *
 * Whichever way in (the sidebar's Scheduled section, which focuses a task and
 * then asks for the scheduler; the command palette; a /scheduler or deep
 * link), they share one opener. With a workspace it opens the dock's Schedule
 * tab; the overlay is only for a window with no workspace, where there is no
 * Review panel to open.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import type React from 'react'
import { act, cleanup, renderHook } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { SCHEDULER_LINK_SETTLE_MS, useOverlayState, type UseOverlayStateArgs } from '@/components/AgentChatView/useOverlayState'
import { APP_EVENTS, dispatchAppEvent } from '@/lib/app-events'
import { useUIStore } from '@/stores/useUIStore'
import { useFakeTimers } from '../fake-timers'

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

/** A chat view whose workspace arrives later, as it does at ``/`` while the last one is restored. */
function renderWithLateWorkspace() {
  const toggleScheduler = mock(() => useUIStore.getState().toggleScheduler())
  const hook = renderHook(
    ({ workspace }: { workspace: string | null }) =>
      useOverlayState({
        isMobile: false,
        workspace,
        toggleScheduler,
        toggleRunPicker: () => {},
        togglePalette: () => {},
        toggleQuickOpen: () => {},
      }),
    { wrapper, initialProps: { workspace: null as string | null } },
  )
  return { toggleScheduler, ...hook }
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
afterEach(cleanup)

describe('scheduled tasks on desktop with a workspace', () => {
  it("takes the sidebar's Open and task rows to the tab, with the task left to focus", () => {
    const { result } = renderOverlay()

    act(() => {
      useUIStore.getState().focusScheduledTask('task-3')
      dispatchAppEvent(APP_EVENTS.openScheduler)
    })

    expect(result.current.workspacePanel).toBe('changed')
    expect(result.current.dockViewRequest).toEqual({ view: 'schedule', key: 1 })
    expect(useUIStore.getState().schedulerOpen).toBe(false)
    // The Schedule tab reads the task from the store when it mounts.
    expect(useUIStore.getState().scheduledTaskFocus).toBe('task-3')
  })

  it('takes the command palette to the tab, and a second press hides the Review panel', () => {
    const { result, args } = renderOverlay()

    act(() => result.current.handleToggleScheduler())
    expect(result.current.dockViewRequest).toEqual({ view: 'schedule', key: 1 })

    act(() => result.current.setDockActiveView('schedule'))
    act(() => result.current.handleToggleScheduler())
    expect(result.current.workspacePanel).toBeNull()
    expect(args.toggleScheduler).not.toHaveBeenCalled()
    expect(useUIStore.getState().schedulerOpen).toBe(false)
  })

  it('takes the /scheduler link to the tab, on the linked task', () => {
    const { result } = renderOverlay()

    act(() => useUIStore.getState().requestSchedulerOpen('task-9'))

    expect(result.current.dockViewRequest).toEqual({ view: 'schedule', key: 1 })
    expect(useUIStore.getState().schedulerOpen).toBe(false)
    expect(useUIStore.getState().scheduledTaskFocus).toBe('task-9')
  })

  it('closes an overlay that was open when the tab opens, so the two are never up together', () => {
    const { result } = renderOverlay()
    act(() => useUIStore.setState({ schedulerOpen: true }))

    act(() => dispatchAppEvent(APP_EVENTS.openScheduler))

    expect(result.current.dockViewRequest).toEqual({ view: 'schedule', key: 1 })
    expect(useUIStore.getState().schedulerOpen).toBe(false)
  })
})

describe('scheduled tasks without a workspace', () => {
  it('use the overlay, since no Review panel can open, and keep the task for it to focus', () => {
    const { result, args } = renderOverlay({ workspace: null })

    act(() => {
      useUIStore.getState().focusScheduledTask('task-3')
      dispatchAppEvent(APP_EVENTS.openScheduler)
    })

    expect(args.toggleScheduler).toHaveBeenCalledTimes(1)
    expect(useUIStore.getState().schedulerOpen).toBe(true)
    expect(result.current.dockViewRequest).toBeNull()
    expect(result.current.workspacePanel).toBeNull()
    expect(useUIStore.getState().scheduledTaskFocus).toBe('task-3')
  })

  it('open the overlay for the command palette too', () => {
    const { result, args } = renderOverlay({ workspace: null })

    act(() => result.current.handleToggleScheduler())
    expect(args.toggleScheduler).toHaveBeenCalledTimes(1)
    expect(useUIStore.getState().schedulerOpen).toBe(true)
  })
})

describe('a /scheduler link before the workspace is known', () => {
  it('waits for the workspace, then opens the tab and never the overlay', () => {
    const timers = useFakeTimers()
    try {
      const { result, rerender } = renderWithLateWorkspace()
      act(() => useUIStore.getState().requestSchedulerOpen('task-9'))

      // Nothing opens yet: the bare route is still restoring the last workspace.
      expect(useUIStore.getState().schedulerOpen).toBe(false)
      expect(result.current.dockViewRequest).toBeNull()
      expect(useUIStore.getState().schedulerOpenPending).toBe(true)

      act(() => timers.tick(SCHEDULER_LINK_SETTLE_MS - 100))
      rerender({ workspace: '/repo/project' })

      expect(result.current.workspacePanel).toBe('changed')
      expect(result.current.dockViewRequest).toEqual({ view: 'schedule', key: 1 })
      expect(useUIStore.getState().schedulerOpen).toBe(false)
      expect(useUIStore.getState().schedulerOpenPending).toBe(false)
      expect(useUIStore.getState().scheduledTaskFocus).toBe('task-9')

      // The settle timer is gone with it: no overlay later either.
      act(() => timers.tick(SCHEDULER_LINK_SETTLE_MS * 2))
      expect(useUIStore.getState().schedulerOpen).toBe(false)
    } finally {
      timers.restore()
    }
  })

  it('settles for the overlay when no workspace turns up', () => {
    const timers = useFakeTimers()
    try {
      const { result, toggleScheduler } = renderWithLateWorkspace()
      act(() => useUIStore.getState().requestSchedulerOpen('task-9'))
      expect(useUIStore.getState().schedulerOpen).toBe(false)

      act(() => timers.tick(SCHEDULER_LINK_SETTLE_MS))

      expect(toggleScheduler).toHaveBeenCalledTimes(1)
      expect(useUIStore.getState().schedulerOpen).toBe(true)
      expect(useUIStore.getState().schedulerOpenPending).toBe(false)
      expect(result.current.dockViewRequest).toBeNull()
      expect(useUIStore.getState().scheduledTaskFocus).toBe('task-9')
    } finally {
      timers.restore()
    }
  })
})

describe('scheduled tasks on a phone', () => {
  it('keep their sheet: the dock sheet with a workspace, the overlay without', () => {
    const withWorkspace = renderOverlay({ isMobile: true })
    act(() => dispatchAppEvent(APP_EVENTS.openScheduler))
    expect(withWorkspace.result.current.dockViewRequest).toEqual({ view: 'schedule', key: 1 })
    expect(useUIStore.getState().schedulerOpen).toBe(false)
    cleanup()

    const without = renderOverlay({ isMobile: true, workspace: null })
    act(() => dispatchAppEvent(APP_EVENTS.openScheduler))
    expect(without.args.toggleScheduler).toHaveBeenCalledTimes(1)
    expect(useUIStore.getState().schedulerOpen).toBe(true)
  })
})
