import type { ComponentProps } from 'react'
import { describe, expect, it, mock } from 'bun:test'
import { render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'
import userEvent from '@testing-library/user-event'

import { AgentChatHeader } from '@/components/AgentChatView/AgentChatHeader'
import { useTranscriptFollowStore } from '@/stores/useTranscriptFollowStore'

function renderHeader(overrides: Partial<ComponentProps<typeof AgentChatHeader>> = {}) {
  const props: ComponentProps<typeof AgentChatHeader> = {
    dragHandlers: {},
    isMacOverlay: false,
    isMobile: true,
    workspace: '/Users/name/Workspace A',
    sessionTitle: 'Fix updater restart',
    onSidebarToggle: () => undefined,
    headerTokens: undefined,
    sessionId: 'session-1',
    todos: [],
    onToggleTasks: () => undefined,
    tasksViewActive: false,
    workspacePanel: null,
    onWorkspaceFiles: () => undefined,
    agentCapabilitiesOpen: false,
    onToggleAgentCapabilities: () => undefined,
    showMobileActions: false,
    setShowMobileActions: () => undefined,
    mobileActionsDragOffset: null,
    onToggleScheduler: () => undefined,
    onOpenTerminal: () => undefined,
    onCloseMobileActionsMenu: () => undefined,
    ...overrides,
  }
  return render(<AgentChatHeader {...props} />)
}

describe('AgentChatHeader', () => {
  it('shows the session title with its workspace under it on mobile', () => {
    renderHeader()

    const header = document.querySelector('header') as HTMLElement
    expect(header).toHaveTextContent('Fix updater restart')
    expect(screen.getByText('Workspace A')).toBeInTheDocument()
  })

  it('keeps the mobile header to sidebar, title, Review panel and More', () => {
    const { container } = renderHeader({ isMobile: true })
    const names = Array.from(container.querySelectorAll<HTMLElement>('header button')).map((el) => el.getAttribute('aria-label'))
    expect(names).toEqual(['Toggle sidebar', 'Review panel', 'More actions'])
  })

  it('keeps the desktop header on the page tone in light mode', () => {
    const { container } = renderHeader({ isMobile: false })
    const header = container.querySelector('header') as HTMLElement
    expect(header.className).toContain('bg-(--bg-page)')
    expect(header.className).toContain('md:dark:bg-(--bg-sidebar)')
    expect(header.className.split(' ')).not.toContain('md:bg-(--bg-sidebar)')
  })

  it('keeps desktop coding sessions showing workspace and session title', () => {
    renderHeader({ isMobile: false })

    expect(screen.getByText('Workspace A')).toBeInTheDocument()
    expect(screen.getByText('Fix updater restart')).toBeInTheDocument()
  })

  it('keeps every header control in Tab order', () => {
    const { container } = renderHeader({ isMobile: false })
    const buttons = Array.from(container.querySelectorAll<HTMLElement>('header button'))
    expect(buttons.length).toBeGreaterThan(1)
    expect(buttons.every((el) => el.tabIndex === 0)).toBe(true)
    expect(screen.getByRole('button', { name: 'Toggle sidebar' }).tabIndex).toBe(0)
  })

  // Sessions are renamed from the sidebar; the header only shows the title.
  it('shows the desktop session title as text, not a rename control', async () => {
    const user = userEvent.setup()
    renderHeader({ isMobile: false })

    const title = screen.getByText('Fix updater restart')
    expect(title.closest('button')).toBeNull()
    expect(screen.queryByRole('button', { name: /rename/i })).not.toBeInTheDocument()

    await user.dblClick(title)
    expect(screen.queryByLabelText('Session title')).not.toBeInTheDocument()
  })

  it('sizes every mobile header action to the full header height on touch', () => {
    renderHeader({ isMobile: true })

    for (const name of ['Toggle sidebar', 'Review panel', 'More actions']) {
      expect(screen.getByRole('button', { name }).className).toContain('pointer-coarse:size-9')
    }
  })

  it('shows context use in the mobile More sheet, even with zero usage', () => {
    renderHeader({
      isMobile: true,
      showMobileActions: true,
      headerTokens: { input: 0, output: 0, cached: 0 },
    })

    expect(screen.getByRole('dialog', { name: 'More actions' })).toHaveTextContent('Context (tokens)')
  })

  it('hides token meter when headerTokens is undefined', () => {
    renderHeader({ headerTokens: undefined })
    expect(screen.queryByRole('button', { name: /Input:/i })).not.toBeInTheDocument()
  })

  it('runs the mobile terminal action before closing the drawer', async () => {
    const user = userEvent.setup()
    const onOpenTerminal = mock(() => {})
    const onCloseMobileActionsMenu = mock(() => {})
    renderHeader({
      showMobileActions: true,
      onOpenTerminal,
      onCloseMobileActionsMenu,
    })

    await user.click(screen.getByRole('button', { name: 'Terminal' }))

    expect(onOpenTerminal).toHaveBeenCalledTimes(1)
    expect(onCloseMobileActionsMenu).toHaveBeenCalledTimes(1)
  })

  it('steps prompts, searches files, and opens the palette from the mobile drawer, then closes it', async () => {
    const user = userEvent.setup()
    const jumpToPrompt = mock((..._args: unknown[]) => {})
    const onQuickOpen = mock(() => {})
    const onOpenPalette = mock(() => {})
    const onCloseMobileActionsMenu = mock(() => {})
    useTranscriptFollowStore.setState({ jumpToPrompt })
    try {
      renderHeader({ showMobileActions: true, onQuickOpen, onOpenPalette, onCloseMobileActionsMenu })

      await user.click(screen.getByRole('button', { name: 'Previous prompt' }))
      await user.click(screen.getByRole('button', { name: 'Next prompt' }))
      await user.click(screen.getByRole('button', { name: 'Find file' }))
      await user.click(screen.getByRole('button', { name: 'Command palette' }))

      expect(jumpToPrompt.mock.calls).toEqual([[-1], [1]])
      expect(onQuickOpen).toHaveBeenCalledTimes(1)
      expect(onOpenPalette).toHaveBeenCalledTimes(1)
      expect(onCloseMobileActionsMenu).toHaveBeenCalledTimes(4)
    } finally {
      useTranscriptFollowStore.setState({ jumpToPrompt: null })
    }
  })

  it('disables mobile prompt stepping in a chat with no session yet', () => {
    useTranscriptFollowStore.setState({ jumpToPrompt: () => {} })
    try {
      renderHeader({ showMobileActions: true, sessionId: null })

      expect(screen.getByRole('button', { name: 'Previous prompt' })).toBeDisabled()
      expect(screen.getByRole('button', { name: 'Next prompt' })).toBeDisabled()
    } finally {
      useTranscriptFollowStore.setState({ jumpToPrompt: null })
    }
  })

  it('labels the chat workspace "Chat" instead of its home-directory basename', () => {
    renderHeader({
      isMobile: false,
      workspace: '/Users/name',
      chatWorkspace: { path: '/Users/name', name: 'Chat' },
      sessionTitle: null,
    })

    expect(screen.getByText('Chat')).toBeInTheDocument()
    expect(screen.queryByText('name')).not.toBeInTheDocument()
  })

  it('keeps revealing the real path when hovering a coding workspace', async () => {
    const user = userEvent.setup()
    renderHeader({ isMobile: false, sessionTitle: null })

    await user.hover(screen.getByText('Workspace A'))

    // Tooltips open after the hover delay.
    expect(await screen.findByRole('tooltip')).toHaveTextContent('/Users/name/Workspace A')
  })

  it('never leaks the home path into the chat workspace tooltip', async () => {
    const user = userEvent.setup()
    renderHeader({
      isMobile: false,
      workspace: '/Users/name',
      chatWorkspace: { path: '/Users/name', name: 'Chat' },
      sessionTitle: null,
    })

    await user.hover(screen.getByText('Chat'))

    expect(await screen.findByRole('tooltip')).toHaveTextContent('Chat')
    expect(screen.queryByText('/Users/name')).not.toBeInTheDocument()
  })

  it('opens the command palette from the desktop command center', async () => {
    const user = userEvent.setup()
    const onOpenPalette = mock(() => {})
    renderHeader({ isMobile: false, onOpenPalette })

    await user.click(screen.getByRole('button', { name: /Search or run a command/ }))

    expect(onOpenPalette).toHaveBeenCalledTimes(1)
  })

  it('keeps the command center off the mobile header', () => {
    renderHeader({ isMobile: true, onOpenPalette: () => undefined })

    expect(screen.queryByRole('button', { name: /Search or run a command/ })).not.toBeInTheDocument()
  })

  it('reflects the review dock state on its toggle', () => {
    const { rerender } = renderHeader({ isMobile: false, workspacePanel: null })
    expect(screen.getByRole('button', { name: 'Changed files and workspace files' })).toHaveAttribute('aria-pressed', 'false')

    rerender(
      <AgentChatHeader
        dragHandlers={{}}
        isMacOverlay={false}
        isMobile={false}
        workspace="/Users/name/Workspace A"
        sessionTitle={null}
        onSidebarToggle={() => undefined}
        sessionId="session-1"
        todos={[]}
        onToggleTasks={() => undefined}
        tasksViewActive={false}
        workspacePanel="changed"
        onWorkspaceFiles={() => undefined}
        agentCapabilitiesOpen={false}
        onToggleAgentCapabilities={() => undefined}
        showMobileActions={false}
        setShowMobileActions={() => undefined}
        onToggleScheduler={() => undefined}
        onCloseMobileActionsMenu={() => undefined}
      />,
    )
    expect(screen.getByRole('button', { name: 'Changed files and workspace files' })).toHaveAttribute('aria-pressed', 'true')
  })

  it('routes the desktop Tasks button through onToggleTasks with progress and pressed state', async () => {
    const user = userEvent.setup()
    const onToggleTasks = mock(() => {})
    renderHeader({
      isMobile: false,
      onToggleTasks,
      tasksViewActive: true,
      todos: [
        { task_id: '1', content: 'Plan', status: 'completed' },
        { task_id: '2', content: 'Build', status: 'in_progress' },
        { task_id: '3', content: 'Ship', status: 'pending' },
      ],
    })

    const button = screen.getByRole('button', { name: 'Task list' })
    expect(button).toHaveAttribute('aria-pressed', 'true')
    expect(button).toHaveTextContent('1/3')
    await user.click(button)
    expect(onToggleTasks).toHaveBeenCalledTimes(1)
  })

  it('shows the live goal as a ring on the Task list button (More on phones), and nothing without one', () => {
    const goalState = { tone: 'wait' as const, text: 'Goal · Waiting for your answer' }
    const { unmount } = renderHeader({ isMobile: false, goalState })
    expect(screen.getByRole('button', { name: 'Task list' }).querySelector('[data-goal-ring="wait"]')).not.toBeNull()
    unmount()

    const phone = renderHeader({ isMobile: true, goalState })
    expect(screen.getByRole('button', { name: 'More actions' }).querySelector('[data-goal-ring="wait"]')).not.toBeNull()
    phone.unmount()

    renderHeader({ isMobile: false })
    expect(document.querySelector('[data-goal-ring]')).toBeNull()
  })

  it('disables the desktop Tasks button without a session', () => {
    renderHeader({ isMobile: false, sessionId: null })
    expect(screen.getByRole('button', { name: 'Task list' })).toBeDisabled()
  })

  it('opens tasks from the mobile More sheet through the same handler, then closes the sheet', async () => {
    const user = userEvent.setup()
    const onToggleTasks = mock(() => {})
    const onCloseMobileActionsMenu = mock(() => {})
    renderHeader({ isMobile: true, showMobileActions: true, onToggleTasks, onCloseMobileActionsMenu })

    await user.click(screen.getByRole('button', { name: 'Tasks' }))
    expect(onToggleTasks).toHaveBeenCalledTimes(1)
    expect(onCloseMobileActionsMenu).toHaveBeenCalledTimes(1)
  })
})
