import type { ComponentProps } from 'react'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, mock } from 'bun:test'
import { cleanup, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

import { AgentChatHeader } from '@/components/AgentChatView/AgentChatHeader'
import { queryKeys } from '@/queries/keys'

function renderHeader(overrides: Partial<ComponentProps<typeof AgentChatHeader>> = {}) {
  const props: ComponentProps<typeof AgentChatHeader> = {
    dragHandlers: {},
    isMacOverlay: false,
    isMobile: true,
    workspace: '/Users/name/Workspace A',
    sessionTitle: 'Fix updater restart',
    onSidebarToggle: () => undefined,
    sessionId: 'session-1',
    todos: [],
    onToggleTasks: () => undefined,
    tasksViewActive: false,
    workspacePanel: null,
    onWorkspaceFiles: () => undefined,
    ...overrides,
  }
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  client.setQueryData(queryKeys.coding.status(props.workspace ?? ''), { is_git_repo: true, branch: 'feat/phone-bar' })
  return render(<QueryClientProvider client={client}><AgentChatHeader {...props} /></QueryClientProvider>)
}

/**
 * A 36px hit area on touch: the ``Button`` primitive carries it in CSS
 * (``[data-slot="button"]`` in index.css, guarded by touch-targets.test), the
 * header's own icon buttons carry a ``pointer-coarse:`` size class.
 */
function hasTouchFooting(el: HTMLElement): boolean {
  return el.dataset.slot === 'button' || /pointer-coarse:(?:size-9|h-9|min-h-9)/.test(el.className)
}

describe('AgentChatHeader', () => {
  it('shows the session title with its workspace under it on mobile', () => {
    renderHeader()

    const header = document.querySelector('header') as HTMLElement
    expect(header).toHaveTextContent('Fix updater restart')
    expect(screen.getByText('Workspace A')).toBeInTheDocument()
  })

  it('keeps the mobile header to sidebar, title, Tasks and Review panel, with no More sheet', () => {
    const { container } = renderHeader({ isMobile: true })
    const names = Array.from(container.querySelectorAll<HTMLElement>('header button')).map((el) => el.getAttribute('aria-label'))
    expect(names).toEqual(['Toggle sidebar', 'Tasks', 'Review panel'])
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('leaves context use to the run deck', () => {
    for (const isMobile of [false, true]) {
      const { unmount } = renderHeader({ isMobile })
      const header = document.querySelector('header') as HTMLElement
      expect(header.querySelector('[aria-label^="Input:"]')).toBeNull()
      unmount()
    }
  })

  it('has no command palette button: the title sits over the chat, the palette is a key away', () => {
    renderHeader({ isMobile: false })
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

    it('puts the Tasks and Review panel buttons in a cap as wide as the Review panel', () => {
      renderHeader({ isMobile: false })
      const trail = cap('dock')
      expect(trail.contains(screen.getByRole('button', { name: 'Tasks' }))).toBe(true)
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
      // as in native Mac apps, not against the zoom button. One token
      // (--spacing-mac-traffic-inset) plus the 8px gap sets it.
      expect(cap('sidebar')).toHaveClass('pl-[calc(var(--spacing-mac-traffic-inset)+0.5rem)]')
      expect(container.querySelector('header')).not.toHaveClass('pl-(--spacing-mac-traffic-inset)')
    })

    it('uses the same traffic-light token on the phone bar, with the cluster padding as the gap', () => {
      const { container } = renderHeader({ isMobile: true, isMacOverlay: true })
      const header = container.querySelector('header') as HTMLElement
      expect(header).toHaveClass('pl-(--spacing-mac-traffic-inset)')
      // No second literal inset anywhere in the header.
      expect(header.className).not.toMatch(/pl-\[\d+px\]/)
      expect((screen.getByRole('button', { name: 'Toggle sidebar' }).closest('header > div') as HTMLElement).className.split(' ')).toContain('pl-2')
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
    const LEAD = { name: 'Open the main agent' }

    for (const isMobile of [false, true]) {
      const where = isMobile ? 'phone' : 'desktop'

      it(`shows a main-agent button on the ${where} header only when given a way back, and it opens the main agent`, async () => {
        const { unmount } = renderHeader({ isMobile })
        expect(screen.queryByRole('button', { name: LEAD.name })).toBeNull()
        unmount()

        const onOpenLead = mock(() => {})
        renderHeader({ isMobile, onOpenLead })
        const button = screen.getByRole('button', { name: LEAD.name })
        // The same touch footing as every header control.
        expect(hasTouchFooting(button)).toBe(true)
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
      expect(names).toEqual(['Toggle sidebar', 'Open the main agent', 'Tasks', 'Review panel'])
    })

    it('says what it does in a tooltip', async () => {
      renderHeader({ isMobile: false, onOpenLead: () => undefined })
      await userEvent.setup().hover(screen.getByRole('button', { name: LEAD.name }))
      expect(await screen.findByRole('tooltip')).toHaveTextContent('Open the main agent')
    })

    it('is the Button primitive, not a hand-rolled icon button', () => {
      renderHeader({ isMobile: false, onOpenLead: () => undefined })
      const button = screen.getByRole('button', { name: LEAD.name })
      expect(button.dataset.slot).toBe('button')
      expect(button.dataset.variant).toBe('ghost')
    })
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

  it('lets the desktop title take the free width: no fixed cap, it truncates at the buttons', () => {
    renderHeader({ isMobile: false })
    const title = document.querySelector('[data-header-title]') as HTMLElement
    expect(title.className.split(' ').some((c) => /(^|:)max-w-/.test(c))).toBe(false)
    expect(title.className.split(' ')).toContain('min-w-0')
  })

  it('names a worktree "repo (worktree)" on desktop and on phones', () => {
    for (const isMobile of [false, true]) {
      const { unmount } = renderHeader({ isMobile, workspace: '/wt/openagentd-1a2b/fix-login', workspaceTitle: 'openagentd', checkoutName: 'fix-login' })
      expect(document.querySelector('header')).toHaveTextContent('openagentd (fix-login)')
      unmount()
    }
  })

  it('keeps the main checkout to the repository name', () => {
    renderHeader({ isMobile: false, workspace: '/code/openagentd', workspaceTitle: 'openagentd', checkoutName: null })
    expect((document.querySelector('[data-header-workspace]') as HTMLElement).textContent).toBe('openagentd')
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
    const { container } = renderHeader({ isMobile: false })
    const buttons = Array.from(container.querySelectorAll<HTMLElement>('header button'))

    expect(buttons.map((el) => el.getAttribute('aria-label'))).toEqual([
      'Toggle sidebar',
      'Tasks',
      'Review panel',
    ])
    for (const el of buttons) {
      expect([el.getAttribute('aria-label'), hasTouchFooting(el)]).toEqual([el.getAttribute('aria-label'), true])
      // No ``max-md:`` gate: a touch tablet in the desktop layout needs it too.
      expect(el.className).not.toContain('max-md:pointer-coarse')
    }
  })

  it('builds the header icon buttons from the Button primitive: 32px, ghost, no hand-rolled sizes', () => {
    for (const isMobile of [false, true]) {
      const { unmount } = renderHeader({ isMobile, onOpenLead: () => undefined })
      for (const name of ['Toggle sidebar', 'Open the main agent']) {
        const button = screen.getByRole('button', { name })
        expect([name, button.dataset.slot, button.dataset.variant]).toEqual([name, 'button', 'ghost'])
        expect(button.className.split(' ')).toContain('size-8')
        expect(button.className).not.toMatch(/(?:^|\s)md:(?:h|w|size)-/)
      }
      unmount()
    }
  })

  it('has two layout buttons on desktop: the sidebar on the left and the Review panel on the right', () => {
    const { container } = renderHeader({ isMobile: false })
    const labels = Array.from(container.querySelectorAll('header button')).map((el) => el.getAttribute('aria-label'))

    expect(labels[0]).toBe('Toggle sidebar')
    expect(labels.at(-1)).toBe('Review panel')
    expect(labels.filter((label) => /sidebar|review|files|panel|dock/i.test(label ?? ''))).toEqual(['Toggle sidebar', 'Review panel'])
  })

  it('words every desktop tooltip with a shortcut as "Name (key)", the platform\'s own key', async () => {
    const user = userEvent.setup()
    renderHeader({ isMobile: false })
    const cases: Array<[string, RegExp]> = [
      ['Toggle sidebar', /^Toggle sidebar \((⌘B|Ctrl\+B)\)$/],
      ['Tasks', /^Tasks \((⌘T|Ctrl\+T)\)$/],
      ['Review panel', /^Show Review panel \((⌘D|Ctrl\+D)\)$/],
    ]
    for (const [name, form] of cases) {
      await user.hover(screen.getByRole('button', { name }))
      expect([name, (await screen.findByRole('tooltip')).textContent?.match(form) !== null]).toEqual([name, true])
      await user.unhover(screen.getByRole('button', { name }))
    }
  })

  it('sizes every mobile header action to the full header height on touch', () => {
    renderHeader({ isMobile: true })

    for (const name of ['Toggle sidebar', 'Tasks', 'Review panel']) {
      expect([name, hasTouchFooting(screen.getByRole('button', { name }))]).toEqual([name, true])
    }
  })

  it('keeps the phone Review panel button off the right edge, as the sidebar button is off the left', () => {
    renderHeader({ isMobile: true })
    const cluster = (name: string) => screen.getByRole('button', { name }).closest('header > div') as HTMLElement
    expect(cluster('Review panel').className.split(' ')).toContain('pr-2')
    expect(cluster('Toggle sidebar').className.split(' ')).toContain('pl-2')
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

    const button = screen.getByRole('button', { name: 'Tasks' })
    expect(button).toHaveAttribute('aria-pressed', 'true')
    expect(button).toHaveTextContent('1/3')
    await user.click(button)
    expect(onToggleTasks).toHaveBeenCalledTimes(1)
  })

  it('shows the live goal as a ring on the Tasks button, and nothing without one', () => {
    const goalState = { tone: 'wait' as const, text: 'Goal · Waiting for your answer' }
    const { unmount } = renderHeader({ isMobile: false, goalState })
    expect(screen.getByRole('button', { name: 'Tasks' }).querySelector('[data-goal-ring="wait"]')).not.toBeNull()
    unmount()

    const phone = renderHeader({ isMobile: true, goalState })
    expect(screen.getByRole('button', { name: 'Tasks' }).querySelector('[data-goal-ring="wait"]')).not.toBeNull()
    phone.unmount()

    renderHeader({ isMobile: false })
    expect(document.querySelector('[data-goal-ring]')).toBeNull()
  })

  it('disables the desktop Tasks button without a session', () => {
    renderHeader({ isMobile: false, sessionId: null })
    expect(screen.getByRole('button', { name: 'Tasks' })).toBeDisabled()
  })

  it('opens tasks from the phone header through the same handler, with the open-task count', async () => {
    const user = userEvent.setup()
    const onToggleTasks = mock(() => {})
    renderHeader({
      isMobile: true,
      onToggleTasks,
      todos: [
        { task_id: '1', content: 'Build', status: 'in_progress' },
        { task_id: '2', content: 'Ship', status: 'pending' },
      ],
    })

    const button = screen.getByRole('button', { name: 'Tasks, 2 open' })
    expect(button).toHaveTextContent('2')
    await user.click(button)
    expect(onToggleTasks).toHaveBeenCalledTimes(1)
  })

  it('disables the phone Tasks button without a session', () => {
    renderHeader({ isMobile: true, sessionId: null })
    expect(screen.getByRole('button', { name: 'Tasks' })).toBeDisabled()
  })

  it('opens the Review panel (terminal, find file, scheduled tasks) from the phone header in one tap', async () => {
    const onWorkspaceFiles = mock(() => {})
    renderHeader({ isMobile: true, onWorkspaceFiles })
    await userEvent.setup().click(screen.getByRole('button', { name: 'Review panel' }))
    expect(onWorkspaceFiles).toHaveBeenCalledTimes(1)
  })

  describe('on a phone stack', () => {
    it('trades the sidebar toggle for ‹ Sessions, which goes back', async () => {
      const onBack = mock(() => {})
      const onSidebarToggle = mock(() => {})
      renderHeader({ onBack, onSidebarToggle })
      expect(screen.queryByRole('button', { name: 'Toggle sidebar' })).toBeNull()
      const back = screen.getByRole('button', { name: 'Back to Sessions' })
      expect(back.textContent).toBe('')
      await userEvent.setup().click(back)
      expect(onBack).toHaveBeenCalledTimes(1)
      expect(onSidebarToggle).not.toHaveBeenCalled()
    })

    it('left-aligns the title (a tap opens Session info) and its workspace, then Tasks and Review panel', () => {
      const { container } = renderHeader({ onBack: () => undefined })
      const title = container.querySelector('[data-phone-nav-title]')!
      expect(title).toHaveTextContent('Fix updater restart')
      expect(title).toHaveTextContent('Workspace A')
      expect(title.className).toContain('text-left')
      expect(title.className).not.toContain('text-center')
      const names = Array.from(container.querySelectorAll<HTMLElement>('header button')).map((el) => el.getAttribute('aria-label'))
      expect(names).toEqual(['Back to Sessions', 'Session info', 'Tasks', 'Review panel'])
    })

    it('draws the tappable title as the bar title, not as a 40px muted button', () => {
      renderHeader({ onBack: () => undefined })
      const trigger = screen.getByRole('button', { name: 'Session info' })
      // The phone button floor would stand the title over its workspace line.
      expect(trigger.className).toContain('min-h-0!')
      // ``cn`` does not merge: the bar's type has to win over the ghost's.
      expect(trigger.className).toContain('font-semibold!')
      expect(trigger.className).toContain('text-(--color-text)!')
    })

    it('draws every bar button with the Button primitive', () => {
      const { container } = renderHeader({ onBack: () => undefined, onOpenLead: () => undefined })
      for (const button of container.querySelectorAll<HTMLElement>('header button')) {
        expect(button.dataset.slot).toBe('button')
      }
    })

    it('opens the Review panel in one tap, and the session info (with the branch) from the title', async () => {
      const onWorkspaceFiles = mock(() => {})
      renderHeader({ onBack: () => undefined, onWorkspaceFiles })
      const user = userEvent.setup()
      await user.click(screen.getByRole('button', { name: 'Review panel' }))
      expect(onWorkspaceFiles).toHaveBeenCalledTimes(1)

      await user.click(screen.getByRole('button', { name: 'Session info' }))
      const info = document.querySelector('[data-session-info]')!
      expect(info).toHaveTextContent('Fix updater restart')
      expect(info).toHaveTextContent('Workspace A')
      expect(info.querySelector('[data-session-branch]')).toHaveTextContent('feat/phone-bar')
    })

    it('opens Tasks in one tap, even before the agent makes any', async () => {
      const onToggleTasks = mock(() => {})
      renderHeader({ onBack: () => undefined, onToggleTasks, todos: [] })
      await userEvent.setup().click(screen.getByRole('button', { name: 'Tasks' }))
      expect(onToggleTasks).toHaveBeenCalledTimes(1)
    })
  })
})
