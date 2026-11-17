import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { act, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useAgentStore } from '@/stores/useAgentStore'
import { createDefaultAgentStream } from '@/stores/useAgentStore/defaults'
import {
  cleanupSidebarHarness,
  fx,
  navigate,
  renderSidebarWithProps,
  resetSidebarHarness,
  settleWorkspaceTree,
  worktreeChip,
} from './harness'
import { runOf } from '@/stores/useAgentStore/run-state'

describe('Sidebar workspace trust flow', () => {
  beforeEach(resetSidebarHarness)
  afterEach(cleanupSidebarHarness)

  it('filters a repository to one worktree and starts sessions there', async () => {
    const user = userEvent.setup()
    fx.sessionsData = [
      {
        id: 'session-1',
        title: 'Worktree session',
        agent_name: 'lead',
        created_at: '2026-05-13T00:00:00Z',
        updated_at: '2026-05-13T00:00:00Z',
        mode: 'coding',
        workspace: '/data/worktrees/project/task-a',
      },
    ]
    fx.workspaceSessionsData = fx.sessionsData
    let resolveCalled = false
    globalThis.fetch = mock(async (input: unknown, init: unknown) => {
      const url = String(input)
      if (url.includes('/api/agent/workspace/tree')) {
        return new Response(JSON.stringify({ repositories: [{ path: '/repo/project', name: 'project', worktrees: [{ path: '/data/worktrees/project/task-a', name: 'task-a', managed: true }] }] }))
      }
      if (url.startsWith('/api/agent/workspace/worktrees')) return new Response(JSON.stringify([]))
      if (url.endsWith('/api/agent/sessions/resolve')) {
        void init
        resolveCalled = true
        return new Response(null, { status: 500 })
      }
      return new Response(JSON.stringify({ workspace: '/repo/project' }))
    }) as typeof fetch

    localStorage.setItem('oa-coding-workspaces', JSON.stringify([{ id: 'main', path: '/repo/project', createdAt: '2026-05-01T00:00:00Z' }]))

    await renderSidebarWithProps({ currentSessionId: 'session-1', workspace: '/repo/project' })
    useAgentStore.setState({
      sessionId: 'session-1',
      sessionRun: runOf(false),
      agentNames: ['lead'],
      agentStreams: { lead: createDefaultAgentStream() },
    })

    const chip = await screen.findByRole('button', { name: '1 worktree' })
    expect(screen.getByLabelText('Collapse workspace project')).toBeTruthy()
    expect(screen.queryByLabelText(/(Expand|Collapse) worktree/)).toBeNull()
    // The filter chip grows on touch like the row actions (DESIGN.md touch parity).
    expect(chip.className).toContain('pointer-coarse:h-9')
    // It is the one count pill every row uses, muted: a branch mark and the
    // number ("⑂ 1") on every device, never the words "1 worktree", so the
    // repository name keeps the row. The name and the filter are for assistive tech.
    expect(chip.hasAttribute('data-count-chip')).toBe(true)
    expect(chip.textContent).toBe('1')
    expect(chip.className.split(' ')).toContain('text-(--color-text-muted)')
    expect(chip.getAttribute('aria-description')).toBe('project: Showing the workspace and 1 worktree')

    await user.click(chip)
    const menu = screen.getByRole('menu', { name: 'Worktrees for project' })
    expect(within(menu).getByRole('menuitemradio', { name: 'Workspace and worktrees' }).getAttribute('aria-checked')).toBe('true')
    expect(within(menu).getByRole('menuitemradio', { name: 'Workspace' }).getAttribute('aria-checked')).toBe('false')
    expect(menu.textContent).not.toMatch(/checkout|main worktree/i)
    await user.click(within(menu).getByRole('menuitemradio', { name: 'task-a' }))

    expect(screen.queryByRole('menu')).toBeNull()
    expect(worktreeChip().getAttribute('aria-description')).toBe('project: Showing task-a only · change worktree')
    // A filter inks the pill.
    expect(worktreeChip().className.split(' ')).toContain('text-(--color-text)')
    expect(fx.workspaceQueryArgs.at(-1)).toBe('/data/worktrees/project/task-a')
    // One checkout listed: the tag would only repeat the chip.
    expect(document.querySelector('[data-checkout-tag]')).toBeNull()
    const newSession = screen.getByLabelText('New session in worktree task-a')
    expect(newSession.className).toContain('pointer-coarse:size-9')

    await user.click(newSession)

    // The worktree's "+" opens a draft there; nothing is created yet.
    expect(navigate).toHaveBeenCalledWith({
      to: '/',
      search: { workspace: '/data/worktrees/project/task-a' },
      replace: false,
    })
    expect(useAgentStore.getState()._workspace).toBe('/data/worktrees/project/task-a')
    expect(useAgentStore.getState().sessionId).toBeNull()
    expect(resolveCalled).toBe(false)

    // The list names its filter and clears it in one step.
    await user.click(screen.getByRole('button', { name: 'Show all worktrees in project' }))
    expect(worktreeChip().getAttribute('aria-description')).toBe('project: Showing the workspace and 1 worktree')
    expect(fx.workspaceQueryArgs.at(-1)).toEqual(['/repo/project', '/data/worktrees/project/task-a'])
  })

  it('shows every checkout again when the current session is filtered out', async () => {
    const user = userEvent.setup()
    fx.sessionsData = [
      {
        id: 'main-1',
        title: 'Main session',
        agent_name: 'lead',
        created_at: '2026-05-13T00:00:00Z',
        updated_at: '2026-05-13T00:00:00Z',
        workspace: '/repo/project',
      },
    ]
    fx.workspaceSessionsData = fx.sessionsData
    globalThis.fetch = mock(async (input: unknown) => {
      const url = String(input)
      if (url.includes('/api/agent/workspace/tree')) {
        return new Response(JSON.stringify({ repositories: [{ path: '/repo/project', name: 'project', worktrees: [{ path: '/data/worktrees/project/task-a', name: 'task-a', managed: true }] }] }))
      }
      if (url.startsWith('/api/agent/workspace/worktrees')) return new Response(JSON.stringify([]))
      return new Response(null, { status: 404 })
    }) as typeof fetch

    const { Sidebar } = await import('@/components/Sidebar')
    const queryClient = new QueryClient()
    const sidebar = (currentSessionId: string) => (
      <QueryClientProvider client={queryClient}>
        <Sidebar currentSessionId={currentSessionId} workspace="/repo/project" />
      </QueryClientProvider>
    )
    let view: ReturnType<typeof render> | undefined
    await act(async () => {
      view = render(sidebar('main-1'))
      await Promise.resolve()
    })
    await settleWorkspaceTree(queryClient)

    // Picking a worktree is deliberate, even though it hides the open session.
    await user.click(worktreeChip())
    await user.click(screen.getByRole('menuitemradio', { name: 'task-a' }))
    expect(worktreeChip().getAttribute('aria-description')).toContain('Showing task-a only')

    // Opening another main-checkout session (Needs you, search) brings it back.
    await act(async () => { view!.rerender(sidebar('main-2')) })
    expect(worktreeChip().getAttribute('aria-description')).toContain('Showing the workspace and')
  })
})
