import type { ComponentProps } from 'react'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, mock } from 'bun:test'
import { cleanup, render, screen } from '@testing-library/react'
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

  it('has no command palette button: the title sits over the chat, the palette is a key away', () => {
    renderHeader({ isMobile: false, onOpenPalette: () => undefined })
    expect(screen.queryByRole('button', { name: /Command palette/ })).not.toBeInTheDocument()
    const main = document.querySelector('[data-header-main]') as HTMLElement
    expect(main.children[0]).toHaveTextContent('Fix updater restart')
  })

  describe('full-height columns on desktop', () => {
    // The header splits where the columns below it do, so the sidebar and
    // the Review panel read as columns from the top of the window down, as
    // in a native app, instead of starting under a full-width bar.
    const cap = (name: 'sidebar' | 'dock') => document.querySelector(`[data-header-cap="${name}"]`) as HTMLElement
    const css = readFileSync(fileURLToPath(new URL('../../index.css', import.meta.url)), 'utf8')
    const rule = (selector: string) => css.match(new RegExp(`\\${selector} \\{([^}]*)\\}`))?.[1] ?? ''

    it('puts the sidebar toggle in a cap that does not follow the sidebar width, with no line beside it', () => {
      renderHeader({ isMobile: false })
      const lead = cap('sidebar')
      expect(lead.contains(screen.getByRole('button', { name: 'Toggle sidebar' }))).toBe(true)
      // The title sits right after the toggle whatever the sidebar does.
      expect(css).not.toContain('--oa-sidebar-w')
      expect(rule('.oa-header-cap-sidebar')).toBe('')
      expect(lead.className).not.toContain('min-w')
      // The column edges start under the header: no "|" between the caps.
      expect(lead.className.split(' ').some((c) => c.startsWith('border'))).toBe(false)
    })

    it('puts the Task list and Review panel buttons in a cap as wide as the Review panel', () => {
      renderHeader({ isMobile: false })
      const trail = cap('dock')
      expect(trail.contains(screen.getByRole('button', { name: 'Task list' }))).toBe(true)
      expect(trail.contains(screen.getByRole('button', { name: 'Review panel' }))).toBe(true)
      expect(trail).toHaveClass('oa-header-cap-dock')
      const geometry = rule('.oa-header-cap-dock')
      expect(geometry).toContain('min-width: var(--oa-dock-w, 0px);')
      expect(geometry).not.toContain('border-left')
    })

    it("draws the header's bottom line across the whole window, over the sidebar too", () => {
      // With no "|" between the caps, a line that stopped at the sidebar's
      // edge left an open corner there; one full-width line makes one bar.
      const { container } = renderHeader({ isMobile: false })
      const header = container.querySelector('header') as HTMLElement
      expect(header.className.split(' ')).toContain('border-b')
      expect((document.querySelector('[data-header-main]') as HTMLElement).className.split(' ')).not.toContain('border-b')
      expect(cap('sidebar').className.split(' ').some((c) => c.startsWith('border'))).toBe(false)
    })

    it('keeps the traffic lights in the sidebar cap, with room before the sidebar toggle', () => {
      const { container } = renderHeader({ isMobile: false, isMacOverlay: true })
      // The buttons end near 66px; the toggle's glyph starts about 20px on,
      // as in native Mac apps, not against the zoom button.
      expect(cap('sidebar')).toHaveClass('pl-[80px]')
      expect(container.querySelector('header')).not.toHaveClass('pl-[80px]')
    })

    it('keeps one bar on phones', () => {
      const { container } = renderHeader({ isMobile: true })
      expect(document.querySelector('[data-header-cap]')).toBeNull()
      expect(container.querySelector('header')?.className.split(' ')).toContain('border-b')
    })
  })

  it('lets the title take the middle on phones', () => {
    const { container } = renderHeader({ isMobile: true })
    expect(container.querySelector('header')).toHaveClass('grid-cols-[auto_minmax(0,1fr)_auto]')
  })

  describe('the way back from a subagent to the lead', () => {
    const LEAD = { name: 'Open the lead agent' }

    for (const isMobile of [false, true]) {
      const where = isMobile ? 'phone' : 'desktop'

      it(`shows a lead button on the ${where} header only when given a way back, and it opens the lead`, async () => {
        const { unmount } = renderHeader({ isMobile })
        expect(screen.queryByRole('button', { name: LEAD.name })).toBeNull()
        unmount()

        const onOpenLead = mock(() => {})
        renderHeader({ isMobile, onOpenLead })
        const button = screen.getByRole('button', { name: LEAD.name })
        // The same touch footing as every header control.
        expect(button.className).toContain('pointer-coarse:size-9')
        expect(button.tabIndex).toBe(0)
        await userEvent.setup().click(button)
        expect(onOpenLead).toHaveBeenCalledTimes(1)
      })
    }

    it('puts it before the title on desktop, and with the sidebar button on phones', () => {
      const onOpenLead = () => undefined
      renderHeader({ isMobile: false, onOpenLead })
      const main = document.querySelector('[data-header-main]') as HTMLElement
      expect(main.contains(screen.getByRole('button', { name: LEAD.name }))).toBe(true)
      cleanup()

      const { container } = renderHeader({ isMobile: true, onOpenLead })
      const names = Array.from(container.querySelectorAll<HTMLElement>('header button')).map((el) => el.getAttribute('aria-label'))
      expect(names).toEqual(['Toggle sidebar', 'Open the lead agent', 'Review panel', 'More actions'])
    })

    it('says what it does in a tooltip', async () => {
      renderHeader({ isMobile: false, onOpenLead: () => undefined })
      await userEvent.setup().hover(screen.getByRole('button', { name: LEAD.name }))
      expect(await screen.findByRole('tooltip')).toHaveTextContent('Open the lead agent')
    })
  })

  // The run chip under the composer opens the picker; the More sheet no longer repeats it.
  it('leaves Model and thinking out of the mobile More sheet', () => {
    renderHeader({ isMobile: true, showMobileActions: true })
    expect(screen.getByRole('dialog', { name: 'More actions' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Model and thinking' })).toBeNull()
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

  describe('the session title is read-only: sessions are renamed from the sidebar', () => {
    it('shows the desktop title as text, with no rename button, and a double-click opens no field', async () => {
      const user = userEvent.setup()
      renderHeader({ isMobile: false })

      expect(screen.queryByRole('button', { name: /rename/i })).not.toBeInTheDocument()
      await user.dblClick(screen.getByText('Fix updater restart'))
      expect(screen.queryByLabelText('Session title')).not.toBeInTheDocument()
    })

    it('leaves a press on the title to the window: it drags, and a double-click maximizes', () => {
      renderHeader({ isMobile: false })

      // useTauriDrag ignores presses that land on one of these (its INTERACTIVE_SELECTOR).
      const interactive = 'button, a, input, select, textarea, [role="button"], [data-no-drag]'
      expect(screen.getByText('Fix updater restart').closest(interactive)).toBeNull()
    })

    it('shows the whole title in its tooltip, without a rename hint', async () => {
      const user = userEvent.setup()
      renderHeader({ isMobile: false })

      await user.hover(screen.getByText('Fix updater restart'))

      const tooltip = await screen.findByRole('tooltip')
      expect(tooltip).toHaveTextContent('Fix updater restart')
      expect(tooltip).not.toHaveTextContent(/rename/i)
    })

    it('has no field on phones either', async () => {
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
      'Task list',
      'Review panel',
    ])
    for (const el of buttons) {
      expect([el.getAttribute('aria-label'), /pointer-coarse:(?:size-9|h-9|min-h-9)/.test(el.className)]).toEqual([el.getAttribute('aria-label'), true])
      // No ``max-md:`` gate: a touch tablet in the desktop layout needs it too.
      expect(el.className).not.toContain('max-md:pointer-coarse')
    }
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
