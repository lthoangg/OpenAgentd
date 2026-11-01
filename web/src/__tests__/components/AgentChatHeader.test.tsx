import type { ComponentProps } from 'react'
import { beforeEach, describe, expect, it, mock } from 'bun:test'
import { fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'
import userEvent from '@testing-library/user-event'

// The header renames through the sidebar's mutation; the real one needs a QueryClient.
const renameMutate = mock((..._args: unknown[]) => {})
mock.module('@/queries/useSessionsQuery', () => ({
  useUpdateSessionTitleMutation: () => ({ mutate: renameMutate }),
}))

import { AgentChatHeader } from '@/components/AgentChatView/AgentChatHeader'
import { useTranscriptFollowStore } from '@/stores/useTranscriptFollowStore'
import { useToastStore } from '@/stores/useToastStore'

beforeEach(() => {
  renameMutate.mockClear()
  useToastStore.setState({ toasts: [] })
})

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
    onToggleRunPicker: () => undefined,
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

  it('keeps the mobile header to sidebar, title, Review panel and More: the run deck has the model and context', () => {
    const { container } = renderHeader({ isMobile: true, headerTokens: { input: 50_000, output: 1_000, trigger: 100_000 } })
    const names = Array.from(container.querySelectorAll<HTMLElement>('header button')).map((el) => el.getAttribute('aria-label'))
    expect(names).toEqual(['Toggle sidebar', 'Review panel', 'More actions'])
  })

  it('leaves context use to the run deck on desktop too', () => {
    renderHeader({ isMobile: false, headerTokens: { input: 50_000, output: 1_000, trigger: 100_000 } })
    const header = document.querySelector('header') as HTMLElement
    expect(header.querySelector('[aria-label^="Input:"]')).toBeNull()
    expect(header).not.toHaveTextContent('50K')
  })

  it('opens the run picker from the mobile More sheet, then closes the sheet', async () => {
    const user = userEvent.setup()
    const onToggleRunPicker = mock(() => undefined)
    const onCloseMobileActionsMenu = mock(() => undefined)
    renderHeader({ isMobile: true, showMobileActions: true, onToggleRunPicker, onCloseMobileActionsMenu })

    await user.click(screen.getByRole('button', { name: 'Model and thinking' }))
    expect(onToggleRunPicker).toHaveBeenCalledTimes(1)
    expect(onCloseMobileActionsMenu).toHaveBeenCalledTimes(1)
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

  describe('renaming from the header', () => {
    const TITLE_BUTTON = 'Rename session: Fix updater restart'

    it('shows the desktop title as a button that names its action, with no field until asked', () => {
      renderHeader({ isMobile: false })

      const button = screen.getByRole('button', { name: TITLE_BUTTON })
      expect(button).toHaveTextContent('Fix updater restart')
      expect(button.tabIndex).toBe(0)
      expect(screen.queryByLabelText('Session title')).not.toBeInTheDocument()
    })

    it('hints at the double-click in a tooltip', async () => {
      const user = userEvent.setup()
      renderHeader({ isMobile: false })

      await user.hover(screen.getByRole('button', { name: TITLE_BUTTON }))

      expect(await screen.findByRole('tooltip')).toHaveTextContent('Double-click to rename')
    })

    it('turns into a selected text field on double-click, in the title font, with a 1px field border', async () => {
      const user = userEvent.setup()
      renderHeader({ isMobile: false })

      await user.dblClick(screen.getByRole('button', { name: TITLE_BUTTON }))

      const field = screen.getByLabelText('Session title') as HTMLInputElement
      expect(document.activeElement).toBe(field)
      expect(field.value).toBe('Fix updater restart')
      expect(field.selectionStart).toBe(0)
      expect(field.selectionEnd).toBe('Fix updater restart'.length)
      const classes = field.className.split(/\s+/)
      expect(classes).toContain('bg-(--bg-input)')
      expect(classes).toContain('border')
      expect(classes).toContain('border-(--color-border-subtle)')
      // Size and weight come from the header's title, not a field-specific class.
      expect(classes.some((c) => /^text-(xs|sm|base|\[)/.test(c))).toBe(false)
      expect(screen.queryByRole('button', { name: TITLE_BUTTON })).not.toBeInTheDocument()
    })

    it('saves through the sidebar mutation on Enter, then shows the button again with focus on it', async () => {
      const user = userEvent.setup()
      renderHeader({ isMobile: false })

      await user.dblClick(screen.getByRole('button', { name: TITLE_BUTTON }))
      // Typing straight away replaces the whole title: it opened selected.
      await user.keyboard('Shorter title{Enter}')

      expect(renameMutate).toHaveBeenCalledTimes(1)
      expect(renameMutate.mock.calls[0]?.[0]).toEqual({ id: 'session-1', title: 'Shorter title' })
      expect(screen.queryByLabelText('Session title')).not.toBeInTheDocument()
      expect(document.activeElement).toBe(screen.getByRole('button', { name: TITLE_BUTTON }))
    })

    it('saves when focus leaves the field, without pulling focus back', async () => {
      const user = userEvent.setup()
      renderHeader({ isMobile: false })

      await user.dblClick(screen.getByRole('button', { name: TITLE_BUTTON }))
      await user.keyboard('{End} v2')
      await user.click(screen.getByRole('button', { name: 'Toggle sidebar' }))

      expect(renameMutate).toHaveBeenCalledTimes(1)
      expect(renameMutate.mock.calls[0]?.[0]).toEqual({ id: 'session-1', title: 'Fix updater restart v2' })
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Toggle sidebar' }))
    })

    it('cancels on Escape, and hands focus back to the title', async () => {
      const user = userEvent.setup()
      renderHeader({ isMobile: false })

      await user.dblClick(screen.getByRole('button', { name: TITLE_BUTTON }))
      await user.keyboard('Never saved{Escape}')

      expect(renameMutate).not.toHaveBeenCalled()
      expect(screen.queryByLabelText('Session title')).not.toBeInTheDocument()
      expect(document.activeElement).toBe(screen.getByRole('button', { name: TITLE_BUTTON }))
    })

    it('cancels an empty or an unchanged title', async () => {
      const user = userEvent.setup()
      renderHeader({ isMobile: false })

      await user.dblClick(screen.getByRole('button', { name: TITLE_BUTTON }))
      await user.keyboard('{Backspace}   {Enter}')
      expect(screen.queryByLabelText('Session title')).not.toBeInTheDocument()

      await user.dblClick(screen.getByRole('button', { name: TITLE_BUTTON }))
      fireEvent.blur(screen.getByLabelText('Session title'))
      expect(screen.queryByLabelText('Session title')).not.toBeInTheDocument()

      expect(renameMutate).not.toHaveBeenCalled()
    })

    it('opens with F2 while the title has focus', async () => {
      const user = userEvent.setup()
      renderHeader({ isMobile: false })

      screen.getByRole('button', { name: TITLE_BUTTON }).focus()
      await user.keyboard('{F2}')

      expect(screen.getByLabelText('Session title')).toHaveValue('Fix updater restart')
    })

    it('opens with Enter, but not on a single mouse click', async () => {
      const user = userEvent.setup()
      renderHeader({ isMobile: false })

      await user.click(screen.getByRole('button', { name: TITLE_BUTTON }))
      expect(screen.queryByLabelText('Session title')).toBeNull()

      screen.getByRole('button', { name: TITLE_BUTTON }).focus()
      await user.keyboard('{Enter}')
      expect(screen.getByLabelText('Session title')).toHaveValue('Fix updater restart')
    })

    it('says so when the server refuses the new name', async () => {
      const user = userEvent.setup()
      renderHeader({ isMobile: false })

      await user.dblClick(screen.getByRole('button', { name: TITLE_BUTTON }))
      await user.keyboard('{End}!{Enter}')
      const options = renameMutate.mock.calls[0]?.[1] as { onError: () => void }
      options.onError()

      expect(useToastStore.getState().toasts.map((toast) => toast.title)).toEqual(['Could not rename session'])
    })

    it('keeps a subagent session read-only, like its sidebar row', async () => {
      const user = userEvent.setup()
      renderHeader({ isMobile: false, canRenameSession: false })

      expect(screen.queryByRole('button', { name: /rename/i })).not.toBeInTheDocument()
      await user.dblClick(screen.getByText('Fix updater restart'))
      expect(screen.queryByLabelText('Session title')).not.toBeInTheDocument()
    })

    it('has nothing to rename before a session exists', () => {
      renderHeader({ isMobile: false, sessionId: null })

      expect(screen.queryByRole('button', { name: /rename/i })).not.toBeInTheDocument()
    })

    it('leaves renaming to the drawer on phones', async () => {
      const user = userEvent.setup()
      renderHeader({ isMobile: true })

      expect(screen.queryByRole('button', { name: /rename/i })).not.toBeInTheDocument()
      await user.dblClick(screen.getByText('Fix updater restart'))
      expect(screen.queryByLabelText('Session title')).not.toBeInTheDocument()
    })
  })

  it('opens the drawer from a menu icon on phones and folds the rail with a panel icon on desktop', () => {
    const phone = renderHeader({ isMobile: true })
    const phoneIcon = screen.getByRole('button', { name: 'Toggle sidebar' }).querySelector('svg')
    expect(phoneIcon?.getAttribute('class')).toContain('lucide-menu')
    expect(phoneIcon?.getAttribute('class')).not.toContain('lucide-panel-left')
    phone.unmount()

    renderHeader({ isMobile: false })
    const desktopIcon = screen.getByRole('button', { name: 'Toggle sidebar' }).querySelector('svg')
    expect(desktopIcon?.getAttribute('class')).toContain('lucide-panel-left')
    expect(desktopIcon?.getAttribute('class')).not.toContain('lucide-menu')
  })

  it('gives every desktop header control a 36px hit area on touch, not only on phones', () => {
    const { container } = renderHeader({ isMobile: false, onOpenPalette: () => undefined })
    const buttons = Array.from(container.querySelectorAll<HTMLElement>('header button'))

    expect(buttons.map((el) => el.getAttribute('aria-label'))).toEqual([
      'Toggle sidebar',
      'Rename session: Fix updater restart',
      expect.stringMatching(/^Command palette/),
      'Task list',
      'Review panel',
    ])
    for (const el of buttons) {
      expect([el.getAttribute('aria-label'), /pointer-coarse:(?:size-9|h-9|min-h-9)/.test(el.className)]).toEqual([el.getAttribute('aria-label'), true])
      // No ``max-md:`` gate: a touch tablet in the desktop layout needs it too.
      expect(el.className).not.toContain('max-md:pointer-coarse')
    }
    // The title grows to 36px on touch with its words centred in it, in line
    // with the workspace name, not stuck to the top.
    expect(screen.getByRole('button', { name: 'Rename session: Fix updater restart' }).className).toContain('items-center')
  })

  it('has two layout buttons on desktop: the sidebar on the left and the Review panel on the right', () => {
    const { container } = renderHeader({ isMobile: false, onOpenPalette: () => undefined })
    const labels = Array.from(container.querySelectorAll('header button')).map((el) => el.getAttribute('aria-label'))

    expect(labels[0]).toBe('Toggle sidebar')
    expect(labels.at(-1)).toBe('Review panel')
    expect(labels.filter((label) => /sidebar|review|files|panel|dock/i.test(label ?? ''))).toEqual(['Toggle sidebar', 'Review panel'])
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

  it('pads the More sheet list clear of the home indicator', () => {
    renderHeader({ isMobile: true, showMobileActions: true })
    const list = screen.getByRole('dialog', { name: 'More actions' }).querySelector('[data-mobile-actions-list]') as HTMLElement
    expect(list.className).toContain('pb-safe')
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

    await user.click(screen.getByRole('button', { name: /Command palette/ }))

    expect(onOpenPalette).toHaveBeenCalledTimes(1)
  })

  it('keeps the command center off the mobile header', () => {
    renderHeader({ isMobile: true, onOpenPalette: () => undefined })

    expect(screen.queryByRole('button', { name: /Command palette/ })).not.toBeInTheDocument()
  })

  it('reflects the review dock state on its toggle', () => {
    const { rerender } = renderHeader({ isMobile: false, workspacePanel: null })
    expect(screen.getByRole('button', { name: 'Review panel' })).toHaveAttribute('aria-pressed', 'false')

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
        onToggleRunPicker={() => undefined}
        showMobileActions={false}
        setShowMobileActions={() => undefined}
        onToggleScheduler={() => undefined}
        onCloseMobileActionsMenu={() => undefined}
      />,
    )
    expect(screen.getByRole('button', { name: 'Review panel' })).toHaveAttribute('aria-pressed', 'true')
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
