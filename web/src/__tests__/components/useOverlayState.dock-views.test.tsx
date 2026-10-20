/**
 * useOverlayState — dock views (Tasks / Schedule / Plan).
 *
 * On desktop with a workspace, Tasks / Scheduled Tasks open review-dock tabs; a second press
 * while that tab is focused hides the dock. Phones with a workspace open the
 * scheduler in the dock sheet too but keep the Tasks popover; without a
 * workspace both fall back to the popover / overlay. The Plan tab opens in the
 * dock (or the mobile sheet) whenever there is a workspace, and a new plan
 * review brings it forward on desktop.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import type React from 'react'
import { act, cleanup, renderHook } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useOverlayState, type UseOverlayStateArgs } from '@/components/AgentChatView/useOverlayState'
import { useAgentStore } from '@/stores/useAgentStore'
import { useBtwStore } from '@/stores/useBtwStore'
import { useUIStore } from '@/stores/useUIStore'
import type { ContentBlock, PendingQuestion } from '@/api/types'

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
  useUIStore.setState({ schedulerOpen: false, agentCapabilitiesOpen: false, paletteOpen: false, quickOpenOpen: false })
  useAgentStore.setState({ pendingQuestion: null, sessionId: 's-1', leadName: null, agentStreams: {}, sessionInteractionMode: 'code' })
  useBtwStore.setState({ sessions: {} })
})
afterEach(() => {
  cleanup()
  useAgentStore.setState({ pendingQuestion: null, leadName: null, agentStreams: {}, sessionInteractionMode: 'code' })
})

const planReview = (id: string): PendingQuestion => ({
  id,
  sessionId: 's-1',
  toolCallId: `call-${id}`,
  kind: 'plan_review',
  planRevision: 1,
  questions: [{ question: 'Review plan revision 1.', header: 'Plan review', multiple: false, options: [] }],
})

/** The lead's turn holding one ``plan`` call. */
function setPlanCall(id: string, done = false) {
  const block: ContentBlock = { id, type: 'tool', content: '', toolName: 'plan', toolCallId: id, toolArgs: '{"action":"write"', toolDone: done }
  useAgentStore.setState({ leadName: 'lead', agentStreams: { lead: { currentBlocks: [block] } } as never })
}

describe('useOverlayState dock views', () => {
  it('opens the dock with a tasks request on desktop instead of the popover', () => {
    const { result } = renderOverlay()
    expect(result.current.dockViewsEnabled).toBe(true)

    act(() => result.current.handleToggleTasks())

    expect(result.current.workspacePanel).toBe('changed')
    expect(result.current.dockViewRequest).toEqual({ view: 'tasks', key: 1 })
    expect(result.current.showTodos).toBe(false)
  })

  it('hides the dock on a second press while that view is focused', () => {
    const { result } = renderOverlay()
    act(() => result.current.handleToggleTasks())
    // The mounted dock reports its focused view back.
    act(() => result.current.setDockActiveView('tasks'))

    act(() => result.current.handleToggleTasks())
    expect(result.current.workspacePanel).toBeNull()
  })

  it('switches views without hiding when another view is focused', () => {
    const { result } = renderOverlay()
    act(() => result.current.handleToggleTasks())
    act(() => result.current.setDockActiveView('tasks'))

    act(() => result.current.handleToggleScheduler())
    expect(result.current.workspacePanel).toBe('changed')
    expect(result.current.dockViewRequest).toEqual({ view: 'schedule', key: 2 })
    expect(useUIStore.getState().schedulerOpen).toBe(false)
  })

  it('keeps the tasks popover on mobile but opens the scheduler in the dock sheet', () => {
    const { result, args } = renderOverlay({ isMobile: true })
    expect(result.current.dockViewsEnabled).toBe(false)
    expect(result.current.schedulerInDock).toBe(true)

    act(() => result.current.handleToggleTasks())
    expect(result.current.showTodos).toBe(true)
    expect(result.current.dockViewRequest).toBeNull()

    act(() => result.current.handleToggleScheduler())
    expect(args.toggleScheduler).not.toHaveBeenCalled()
    expect(useUIStore.getState().schedulerOpen).toBe(false)
    expect(result.current.workspacePanel).toBe('changed')
    expect(result.current.dockViewRequest).toEqual({ view: 'schedule', key: 1 })
    // Opening the sheet closes the tasks popover (single-overlay rule).
    expect(result.current.showTodos).toBe(false)

    act(() => result.current.setDockActiveView('schedule'))
    act(() => result.current.handleToggleScheduler())
    expect(result.current.workspacePanel).toBeNull()
  })

  it('keeps the scheduler overlay on mobile without a workspace', () => {
    const { result, args } = renderOverlay({ isMobile: true, workspace: null })
    expect(result.current.schedulerInDock).toBe(false)

    act(() => result.current.handleToggleScheduler())
    expect(args.toggleScheduler).toHaveBeenCalledTimes(1)
    expect(useUIStore.getState().schedulerOpen).toBe(true)
  })

  it('falls back to the popover and overlay on desktop without a workspace', () => {
    const { result, args } = renderOverlay({ workspace: null })

    act(() => result.current.handleToggleTasks())
    expect(result.current.showTodos).toBe(true)

    act(() => result.current.handleToggleScheduler())
    expect(args.toggleScheduler).toHaveBeenCalledTimes(1)
    expect(result.current.workspacePanel).toBeNull()
  })

  it('opens the dock on its Git tab, and never closes it on a second call', () => {
    const { result } = renderOverlay()

    act(() => result.current.handleOpenGit())
    expect(result.current.workspacePanel).toBe('changed')
    expect(result.current.dockViewRequest).toEqual({ view: 'review', key: 1 })

    act(() => result.current.setDockActiveView('review'))
    act(() => result.current.handleOpenGit())
    expect(result.current.workspacePanel).toBe('changed')
    expect(result.current.dockViewRequest).toEqual({ view: 'review', key: 2 })
  })
})

describe('useOverlayState Plan view', () => {
  it('opens the dock with a plan request when there is a workspace', () => {
    const { result } = renderOverlay()

    act(() => result.current.handleOpenPlan())

    expect(result.current.workspacePanel).toBe('changed')
    expect(result.current.dockViewRequest).toEqual({ view: 'plan', key: 1 })
  })

  it('opens the dock sheet on mobile too, closing the tasks popover', () => {
    const { result } = renderOverlay({ isMobile: true })
    act(() => result.current.handleToggleTasks())
    expect(result.current.showTodos).toBe(true)

    act(() => result.current.handleOpenPlan())

    expect(result.current.dockViewRequest).toEqual({ view: 'plan', key: 1 })
    expect(result.current.showTodos).toBe(false)
  })

  it('falls back to the tasks popover without a workspace', () => {
    const { result } = renderOverlay({ workspace: null })

    act(() => result.current.handleOpenPlan())

    expect(result.current.showTodos).toBe(true)
    expect(result.current.dockViewRequest).toBeNull()
  })

  it('brings the plan forward once per new plan review on desktop', () => {
    const { result } = renderOverlay()

    act(() => useAgentStore.setState({ pendingQuestion: planReview('q-1') }))
    expect(result.current.dockViewRequest).toEqual({ view: 'plan', key: 1 })

    // The user closes the dock; the same review must not reopen it.
    act(() => result.current.setWorkspacePanel(null))
    act(() => useAgentStore.setState({ pendingQuestion: { ...planReview('q-1') } }))
    expect(result.current.workspacePanel).toBeNull()

    act(() => useAgentStore.setState({ pendingQuestion: planReview('q-2') }))
    expect(result.current.dockViewRequest).toEqual({ view: 'plan', key: 2 })
  })

  it('leaves the chat on screen for a plan review on mobile', () => {
    const { result } = renderOverlay({ isMobile: true })

    act(() => useAgentStore.setState({ pendingQuestion: planReview('q-1') }))

    expect(result.current.dockViewRequest).toBeNull()
    expect(result.current.workspacePanel).toBeNull()
  })

  it('does not open the dock for an ask_user question', () => {
    const { result } = renderOverlay()

    act(() => useAgentStore.setState({ pendingQuestion: { ...planReview('q-1'), kind: undefined } }))

    expect(result.current.dockViewRequest).toBeNull()
  })

  it('brings the plan forward once per plan call in Plan mode on desktop, to watch it being written', () => {
    useAgentStore.setState({ sessionInteractionMode: 'plan' })
    const { result } = renderOverlay()

    act(() => setPlanCall('call-1'))
    expect(result.current.dockViewRequest).toEqual({ view: 'plan', key: 1 })

    act(() => result.current.setWorkspacePanel(null))
    act(() => setPlanCall('call-1', true))
    expect(result.current.workspacePanel).toBeNull()

    act(() => setPlanCall('call-2'))
    expect(result.current.dockViewRequest).toEqual({ view: 'plan', key: 2 })
  })

  it('leaves the dock alone for a plan call in Code mode, or on mobile', () => {
    const desktop = renderOverlay()
    act(() => setPlanCall('call-1'))
    expect(desktop.result.current.dockViewRequest).toBeNull()
    desktop.unmount()

    useAgentStore.setState({ sessionInteractionMode: 'plan', agentStreams: {} })
    const mobile = renderOverlay({ isMobile: true })
    act(() => setPlanCall('call-2'))
    expect(mobile.result.current.dockViewRequest).toBeNull()
  })
})

describe('useOverlayState side questions', () => {
  it('opens the dock on its BTW tab on desktop with a workspace', () => {
    const { result } = renderOverlay()

    act(() => result.current.handleOpenSideQuestions('s-1'))

    expect(result.current.workspacePanel).toBe('changed')
    expect(result.current.dockViewRequest).toEqual({ view: 'btw', key: 1 })
    // The panel above the composer stays closed: the dock shows them.
    expect(useBtwStore.getState().sessions['s-1']?.open ?? false).toBe(false)
  })

  it('never closes the dock on a second call while the tab is focused', () => {
    const { result } = renderOverlay()
    act(() => result.current.handleOpenSideQuestions('s-1'))
    act(() => result.current.setDockActiveView('btw'))

    act(() => result.current.handleOpenSideQuestions('s-1'))
    expect(result.current.workspacePanel).toBe('changed')
    expect(result.current.dockViewRequest).toEqual({ view: 'btw', key: 2 })
  })

  for (const [name, overrides] of [
    ['on mobile', { isMobile: true }],
    ['without a workspace', { workspace: null }],
  ] as const) {
    it(`opens the panel above the composer ${name}`, () => {
      const { result } = renderOverlay(overrides)

      act(() => result.current.handleOpenSideQuestions('s-1'))

      expect(useBtwStore.getState().sessions['s-1']?.open).toBe(true)
      expect(result.current.dockViewRequest).toBeNull()
      expect(result.current.workspacePanel).toBeNull()
    })
  }
})
