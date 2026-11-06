/**
 * Review dock "+" menu — opens any view or tool while other tabs are open.
 *
 * The empty dock's launcher only shows with no tabs, so without this menu a
 * phone showing the Plan had no way to reach Git from the dock. Phones keep
 * just "+" in the strip; desktop adds Maximize and the pane's ⋯ menu beside
 * it. Refresh lives in the toolbar of the view it reloads, not in the strip.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { gitDiffResponse } from '../git-diff-mock'
import type React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useGitPanelStore } from '@/stores/useGitPanelStore'
import { _resetTerminalStoreForTests } from '@/stores/useTerminalStore'
import { useAgentStore } from '@/stores/useAgentStore'
import { useUIStore } from '@/stores/useUIStore'
import { queryKeys } from '@/queries/keys'
import type { SessionGoal, SessionPlan } from '@/api/types'

const WORKSPACE = '/repo/project'

mock.module('@/hooks/useReducedMotion', () => ({ useReducedMotion: () => false }))
mock.module('@/hooks/use-platform', () => ({
  usePlatform: () => ({ isTauri: false, os: 'linux', isMacOverlay: false }),
  getPlatform: () => ({ isTauri: false, os: 'linux', isMacOverlay: false }),
}))
mock.module('framer-motion', () => ({
  motion: {
    aside: ({ children, className, 'aria-label': ariaLabel }: { children: React.ReactNode; className?: string; 'aria-label'?: string }) => (
      <aside className={className} aria-label={ariaLabel}>{children}</aside>
    ),
  },
  AnimatePresence: ({ children }: { children: React.ReactNode }) => children,
}))

const PLAN: SessionPlan = {
  content: '# Ship it\n\n1. Write the migration',
  updated_at: '2026-01-01T00:00:00Z',
  revision: 1,
  approved_revision: null,
  path: `${WORKSPACE}/.agents/plans/ship-it-0000abcd.md`,
  workspace_path: '.agents/plans/ship-it-0000abcd.md',
}

beforeEach(() => {
  _resetTerminalStoreForTests()
  useGitPanelStore.setState({ workspaces: {} })
  globalThis.fetch = mock(async (input: unknown) => {
    const url = String(input)
    if (url.includes('/workspace/files/list')) return new Response(JSON.stringify({ workspace: WORKSPACE, truncated: false, files: [] }))
    if (url.includes('/workspace/git-diff')) return gitDiffResponse(url, { workspace: WORKSPACE, is_git_repo: false, diff: '' })
    if (url.includes('/workspace/status')) return new Response(JSON.stringify({ workspace: WORKSPACE }))
    return new Response(JSON.stringify({}), { status: 404 })
  }) as typeof fetch
})
afterEach(cleanup)

const GOAL: SessionGoal = {
  id: 'g1', session_id: 'session-1', objective: 'web tests pass', status: 'active', pause_reason: null, detail: null,
  max_turns: 50, token_budget: null, turns_used: 6, tokens_used: 1200, active_seconds: 90, rejected_claims: 0,
  created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', ended_at: null,
}

async function renderPanel({ mobile = false, plan = PLAN, chatWorkspace = false, goal = null }: { mobile?: boolean; plan?: SessionPlan | null; chatWorkspace?: boolean; goal?: SessionGoal | null } = {}) {
  const { WorkspacePanel } = await import('@/components/WorkspacePanel')
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  queryClient.setQueryData(queryKeys.goal('session-1'), { goal })
  await act(async () => {
    render(
      <QueryClientProvider client={queryClient}>
        <WorkspacePanel
          workspace={WORKSPACE}
          open
          mobile={mobile}
          chatWorkspace={chatWorkspace}
          sessionId="session-1"
          plan={plan}
          viewRequest={plan ? { view: 'plan', key: 1 } : null}
        />
      </QueryClientProvider>,
    )
  })
  return queryClient
}

async function openMenu() {
  await userEvent.setup().click(screen.getByRole('button', { name: 'Open in Review panel' }))
  return screen.getByRole('menu', { name: 'Open in Review panel' })
}

const rowNames = (menu: HTMLElement) => within(menu).getAllByRole('menuitem').map((item) => item.getAttribute('aria-label'))

describe('Review dock "+" menu', () => {
  it('opens Git beside an open Plan and keeps the Plan tab', async () => {
    await renderPanel()
    await screen.findByRole('button', { name: 'Session plan' })

    const menu = await openMenu()
    // Opening things only: the pane's splits are in its ⋯ menu.
    expect(rowNames(menu)).toEqual(['Git', 'Goal', 'Plan (open)', 'Tasks', 'Side questions', 'Scheduled tasks', 'Terminal', 'Preview', 'Find file…'])

    await userEvent.setup().click(within(menu).getByRole('menuitem', { name: 'Git' }))
    expect(screen.queryByRole('menu')).toBeNull()
    expect(screen.getByRole('button', { name: 'Git' }).getAttribute('aria-current')).toBe('true')
    expect(screen.getByRole('button', { name: 'Session plan' })).toBeTruthy()
  })

  // A double-click on a tab bar's free space opens the same menu as "+",
  // where the pointer is.
  it('opens the same menu from a double-click or right-click on the free end of the strip', async () => {
    await renderPanel()
    await screen.findByRole('button', { name: 'Session plan' })
    const gap = document.querySelector<HTMLElement>('[data-dock-strip-gap]')!

    fireEvent.doubleClick(gap, { clientX: 120, clientY: 18 })
    const menu = screen.getByRole('menu', { name: 'Open in Review panel' })
    expect(rowNames(menu)).toContain('Git')
    expect(menu.style.left).toBe('120px')
    fireEvent.keyDown(menu, { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()

    fireEvent.contextMenu(gap, { clientX: 140, clientY: 18 })
    expect(screen.getByRole('menu', { name: 'Open in Review panel' })).toBeTruthy()
  })

  it('shows an open tab instead of adding another', async () => {
    await renderPanel()
    await screen.findByRole('button', { name: 'Session plan' })
    await userEvent.setup().click(within(await openMenu()).getByRole('menuitem', { name: 'Git' }))

    await userEvent.setup().click(within(await openMenu()).getByRole('menuitem', { name: 'Plan (open)' }))
    expect(screen.getAllByRole('button', { name: 'Session plan' })).toHaveLength(1)
    expect(screen.getByRole('button', { name: 'Session plan' }).getAttribute('aria-current')).toBe('true')
  })

  it('keeps only "+" in the strip on phones (no Maximize, no ⋯ menu), with Preview in the menu', async () => {
    await renderPanel({ mobile: true })
    await screen.findByRole('button', { name: 'Session plan' })

    expect(screen.queryByRole('button', { name: 'New terminal' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'New preview' })).toBeNull()
    // Refresh is not in the strip on any platform: it is in the view's toolbar.
    expect(screen.queryByRole('button', { name: /^Refresh/ })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Pane actions' })).toBeNull()
    expect(screen.queryByRole('button', { name: /Review panel \(/ })).toBeNull()
    expect(screen.getByRole('button', { name: 'Open in Review panel' })).toBeTruthy()
    // Icon only on phones: the + carries the name, no "Open…" text.
    expect(screen.getByRole('button', { name: 'Open in Review panel' }).textContent).toBe('')
    // Tasks and side questions open above the chat on phones, not in the
    // dock; the plan and the goal open here everywhere.
    expect(rowNames(await openMenu())).toEqual(['Git', 'Goal', 'Plan (open)', 'Scheduled tasks', 'Terminal', 'Preview', 'Find file…'])
  })

  it('has one icon-only "+" open button in the strip, and no New terminal / New preview buttons', async () => {
    await renderPanel()
    await screen.findByRole('button', { name: 'Session plan' })
    expect(screen.queryByRole('button', { name: 'New terminal' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'New preview' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Open in dock' })).toBeNull()
    const open = screen.getByRole('button', { name: 'Open in Review panel' })
    expect(open.textContent).toBe('')
  })

  it('keeps Refresh out of the strip: a Git tab outside a repository offers it in its empty state', async () => {
    await renderPanel()
    await screen.findByRole('button', { name: 'Session plan' })
    expect(screen.queryByRole('button', { name: /^Refresh/ })).toBeNull()

    await userEvent.setup().click(within(await openMenu()).getByRole('menuitem', { name: 'Git' }))
    expect(await screen.findByText('Not a git repository')).toBeTruthy()
    // The strip still has none; the empty state carries the way to look again.
    const strip = document.querySelector<HTMLElement>('[data-dock-strip]')!
    expect(within(strip).queryByRole('button', { name: /^Refresh/ })).toBeNull()
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeTruthy()
  })

  it('opens a terminal through the "Open…" menu', async () => {
    await renderPanel()
    await screen.findByRole('button', { name: 'Session plan' })

    await userEvent.setup().click(within(await openMenu()).getByRole('menuitem', { name: 'Terminal' }))
    expect(screen.queryByRole('menu')).toBeNull()
    expect(screen.getByRole('button', { name: /^Close Terminal 1/ })).toBeTruthy()
  })

  it('drops Git in a chat workspace and Plan without a plan', async () => {
    await renderPanel({ mobile: true, plan: null, chatWorkspace: true })
    expect(rowNames(await openMenu())).toEqual(['Goal', 'Scheduled tasks', 'Terminal', 'Preview', 'Find file…'])
  })

  // The phone has no More sheet: terminal, find file and scheduled tasks open
  // from the Review panel. Once it shows (the header button, or a swipe from
  // the right edge), the empty launcher opens each in one tap and the "+"
  // menu, beside open tabs, in two.
  describe('on a phone, without the More sheet', () => {
    beforeEach(() => useUIStore.setState({ quickOpenOpen: false }))

    it('opens find file and terminal from the empty launcher in one tap', async () => {
      await renderPanel({ mobile: true, plan: null })
      const user = userEvent.setup()
      const launcher = () => screen.getByRole('group', { name: 'Open in Review panel' })

      await user.click(within(launcher()).getByRole('button', { name: /^Find file…/ }))
      expect(useUIStore.getState().quickOpenOpen).toBe(true)

      await user.click(within(launcher()).getByRole('button', { name: 'Terminal' }))
      expect(screen.getByRole('button', { name: /^Close Terminal 1/ })).toBeTruthy()
    })

    it('opens scheduled tasks from the empty launcher in one tap', async () => {
      await renderPanel({ mobile: true, plan: null })
      await userEvent.setup().click(within(screen.getByRole('group', { name: 'Open in Review panel' })).getByRole('button', { name: 'Scheduled tasks' }))
      expect(screen.getByRole('button', { name: 'Scheduled tasks' }).getAttribute('aria-current')).toBe('true')
    })

    it('opens each from "+" beside open tabs in two taps', async () => {
      await renderPanel({ mobile: true })
      await screen.findByRole('button', { name: 'Session plan' })
      const user = userEvent.setup()

      await user.click(within(await openMenu()).getByRole('menuitem', { name: 'Terminal' }))
      expect(screen.getByRole('button', { name: /^Close Terminal 1/ })).toBeTruthy()

      await user.click(within(await openMenu()).getByRole('menuitem', { name: 'Scheduled tasks' }))
      expect(screen.getByRole('button', { name: 'Scheduled tasks' }).getAttribute('aria-current')).toBe('true')

      await user.click(within(await openMenu()).getByRole('menuitem', { name: 'Find file…' }))
      expect(useUIStore.getState().quickOpenOpen).toBe(true)
    })
  })

  it('opens the Goal tab, titled with how far the goal has got', async () => {
    useAgentStore.setState({ isAgentWorking: true })
    try {
      const client = await renderPanel({ goal: GOAL })
      await screen.findByRole('button', { name: 'Session plan' })
      await userEvent.setup().click(within(await openMenu()).getByRole('menuitem', { name: 'Goal' }))

      const tab = screen.getByRole('button', { name: 'Goal 7/50' })
      expect(tab.getAttribute('aria-current')).toBe('true')
      // The tab's view loads on first use (``lazySurface``).
      await waitFor(() => expect(document.querySelector('[data-goal-now]')?.textContent).toBe('Working · turn 7/50'))

      await act(async () => {
        client.setQueryData(queryKeys.goal('session-1'), { goal: { ...GOAL, status: 'paused', pause_reason: 'stopped' } })
      })
      expect((await screen.findByRole('button', { name: 'Goal paused' })).getAttribute('aria-current')).toBe('true')
    } finally {
      useAgentStore.setState({ isAgentWorking: false })
    }
  })

  it('puts a live goal on the empty launcher', async () => {
    await renderPanel({ plan: null, goal: GOAL })
    const launcher = screen.getByRole('group', { name: 'Open in Review panel' })
    expect(launcher.textContent).toContain('Goal')
    expect(screen.getByRole('heading', { name: 'Open in Review panel' })).toBeTruthy()
  })

  it('lists on the empty launcher what the "+" menu lists, views then tools', async () => {
    await renderPanel({ plan: null })
    const launcher = screen.getByRole('group', { name: 'Open in Review panel' })
    const names = within(launcher).getAllByRole('button').map((row) => row.getAttribute('aria-label')?.replace(/ \(.*\)$/, ''))
    expect(names).toEqual(['Git', 'Goal', 'Tasks', 'Side questions', 'Scheduled tasks', 'Terminal', 'Preview', 'Find file…'])
    expect(launcher.querySelectorAll('[data-launcher-divider]')).toHaveLength(1)

    await userEvent.setup().click(within(launcher).getByRole('button', { name: 'Tasks (Ctrl+T)' }))
    expect(screen.getByRole('button', { name: 'Tasks' }).getAttribute('aria-current')).toBe('true')
  })

  it('opened by the user with nothing in it, puts focus on the launcher, and the arrows move down its rows', async () => {
    const { WorkspacePanel } = await import('@/components/WorkspacePanel')
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    // The shell mounts the panel as it opens, with the request that opened it.
    const handled = { current: 0 }
    render(
      <QueryClientProvider client={queryClient}>
        <WorkspacePanel workspace={WORKSPACE} open sessionId="session-1" plan={null} launcherFocusKey={1} handledLauncherFocusKeyRef={handled} />
      </QueryClientProvider>,
    )
    const launcher = await screen.findByRole('group', { name: 'Open in Review panel' })
    const rows = within(launcher).getAllByRole('button')
    // Two animation frames after opening; give a loaded machine time for them.
    await waitFor(() => expect(document.activeElement).toBe(rows[0]), { timeout: 3000 })
    expect(handled.current).toBe(1)

    const user = userEvent.setup()
    await user.keyboard('{ArrowDown}')
    expect(document.activeElement).toBe(rows[1])
    await user.keyboard('{End}')
    expect(document.activeElement).toBe(rows.at(-1))
    await user.keyboard('{ArrowDown}')
    expect(document.activeElement).toBe(rows[0])
    await user.keyboard('{ArrowUp}')
    expect(document.activeElement).toBe(rows.at(-1))
    await user.keyboard('{Home}')
    expect(document.activeElement).toBe(rows[0])
    // Mounts the whole panel and waits two frames: slow on a loaded machine.
  }, 20_000)

  it('leaves focus alone when it opens on remembered tabs, or already open at start', async () => {
    await renderPanel({ plan: null })
    // Open from the start (restored with the window): nothing is taken.
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(document.activeElement).toBe(document.body)
  })
})
