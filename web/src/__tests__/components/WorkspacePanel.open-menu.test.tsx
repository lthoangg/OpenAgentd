/**
 * Review dock "+" menu — opens any view or tool while other tabs are open.
 *
 * The empty dock's launcher only shows with no tabs, so without this menu a
 * phone showing the Plan had no way to reach Git from the dock. Phones keep
 * just "+" and Refresh in the strip; desktop keeps its icons beside "+".
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { gitDiffResponse } from '../git-diff-mock'
import type React from 'react'
import { act, cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useGitPanelStore } from '@/stores/useGitPanelStore'
import { _resetTerminalStoreForTests } from '@/stores/useTerminalStore'
import { useAgentStore } from '@/stores/useAgentStore'
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
  await userEvent.setup().click(screen.getByRole('button', { name: 'Open in dock' }))
  return screen.getByRole('menu', { name: 'Open in dock' })
}

const rowNames = (menu: HTMLElement) => within(menu).getAllByRole('menuitem').map((item) => item.getAttribute('aria-label'))

describe('Review dock "+" menu', () => {
  it('opens Git beside an open Plan and keeps the Plan tab', async () => {
    await renderPanel()
    await screen.findByRole('button', { name: 'Session plan' })

    const menu = await openMenu()
    expect(rowNames(menu)).toEqual(['Git', 'Goal', 'Plan (open)', 'Tasks', 'Side Questions', 'Schedule', 'Terminal', 'Preview', 'Open File'])

    await userEvent.setup().click(within(menu).getByRole('menuitem', { name: 'Git' }))
    expect(screen.queryByRole('menu')).toBeNull()
    expect(screen.getByRole('button', { name: 'Git' }).getAttribute('aria-current')).toBe('true')
    expect(screen.getByRole('button', { name: 'Session plan' })).toBeTruthy()
  })

  it('shows an open tab instead of adding another', async () => {
    await renderPanel()
    await screen.findByRole('button', { name: 'Session plan' })
    await userEvent.setup().click(within(await openMenu()).getByRole('menuitem', { name: 'Git' }))

    await userEvent.setup().click(within(await openMenu()).getByRole('menuitem', { name: 'Plan (open)' }))
    expect(screen.getAllByRole('button', { name: 'Session plan' })).toHaveLength(1)
    expect(screen.getByRole('button', { name: 'Session plan' }).getAttribute('aria-current')).toBe('true')
  })

  it('keeps only "+" and Refresh in the strip on phones, with Preview in the menu', async () => {
    await renderPanel({ mobile: true })
    await screen.findByRole('button', { name: 'Session plan' })

    expect(screen.queryByRole('button', { name: 'New terminal' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'New preview' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeTruthy()
    // Tasks and side questions open above the chat on phones, not in the
    // dock; the plan and the goal open here everywhere.
    expect(rowNames(await openMenu())).toEqual(['Git', 'Goal', 'Plan (open)', 'Schedule', 'Terminal', 'Preview', 'Open File'])
  })

  it('keeps desktop icons beside "+"', async () => {
    await renderPanel()
    await screen.findByRole('button', { name: 'Session plan' })
    expect(screen.getByRole('button', { name: 'New terminal' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'New preview' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Open in dock' })).toBeTruthy()
  })

  it('drops Git in a chat workspace and Plan without a plan', async () => {
    await renderPanel({ mobile: true, plan: null, chatWorkspace: true })
    expect(rowNames(await openMenu())).toEqual(['Goal', 'Schedule', 'Terminal', 'Preview', 'Open File'])
  })

  it('opens the Goal tab, titled with how far the goal has got', async () => {
    useAgentStore.setState({ isAgentWorking: true })
    try {
      const client = await renderPanel({ goal: GOAL })
      await screen.findByRole('button', { name: 'Session plan' })
      await userEvent.setup().click(within(await openMenu()).getByRole('menuitem', { name: 'Goal' }))

      const tab = screen.getByRole('button', { name: 'Goal 7/50' })
      expect(tab.getAttribute('aria-current')).toBe('true')
      expect(document.querySelector('[data-goal-now]')?.textContent).toBe('Working on turn 7 of 50')

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
    expect(screen.getByRole('group', { name: 'Open in the dock' }).textContent).toContain('Goal')
  })
})
