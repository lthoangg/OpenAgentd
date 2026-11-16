import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { useFakeTimers } from '../../fake-timers'
import userEvent from '@testing-library/user-event'
import { useSidebarViewStore } from '@/stores/useSidebarViewStore'
import { TREE_INDENT_PX } from '@/components/Sidebar/tree-indent'
import {
  cleanupSidebarHarness,
  fetchWorkspaceNextPage,
  fx,
  renderSidebarForSessions,
  renderSidebarWithProps,
  resetSidebarHarness,
  worktreeChip,
} from './harness'

describe('Sidebar workspace trust flow', () => {
  beforeEach(resetSidebarHarness)
  afterEach(cleanupSidebarHarness)

  it('shows a running indicator on every running coding session', async () => {
    fx.sessionsData = [
      {
        id: 'session-2',
        title: 'Background running session',
        agent_name: 'lead',
        created_at: '2026-05-12T00:00:00Z',
        updated_at: '2026-05-12T00:00:00Z',
        mode: 'coding',
        workspace: '/repo/project',
        running: true,
      },
    ]
    fx.workspaceSessionsData = [
      {
        id: 'session-1',
        title: 'Selected idle session',
        agent_name: 'lead',
        created_at: '2026-05-13T00:00:00Z',
        updated_at: '2026-05-13T00:00:00Z',
        mode: 'coding',
        workspace: '/repo/project',
      },
      {
        id: 'session-2',
        title: 'Background running session',
        agent_name: 'lead',
        created_at: '2026-05-12T00:00:00Z',
        updated_at: '2026-05-12T00:00:00Z',
        mode: 'coding',
        workspace: '/repo/project',
        running: true,
      },
    ]

    await renderSidebarForSessions('session-1')

    expect(screen.getByLabelText('Session running')).toBeTruthy()
    expect(screen.getByText('Selected idle session')).toBeTruthy()
    expect(screen.getByText('Background running session')).toBeTruthy()
  })

  it('keeps running sessions visible when a workspace is collapsed', async () => {
    fx.sessionsData = [
      {
        id: 'session-2',
        title: 'Background running session',
        agent_name: 'lead',
        created_at: '2026-05-12T00:00:00Z',
        updated_at: '2026-05-12T00:00:00Z',
        mode: 'coding',
        workspace: '/repo/project',
        running: true,
      },
    ]
    fx.workspaceSessionsData = fx.sessionsData

    await renderSidebarForSessions(undefined)
    await userEvent.setup().click(screen.getByLabelText('Collapse workspace project'))

    expect(screen.getByLabelText('Expand workspace project')).toBeTruthy()
    expect(screen.getByText('Background running session')).toBeTruthy()
    expect(screen.getByLabelText('Session running')).toBeTruthy()
  })

  it('folds a workspace shut with the height motion, its rows staying until the fold ends', async () => {
    fx.sessionsData = [
      {
        id: 'session-1',
        title: 'Idle session',
        agent_name: 'lead',
        created_at: '2026-05-12T00:00:00Z',
        updated_at: '2026-05-12T00:00:00Z',
        mode: 'coding',
        workspace: '/repo/project',
      },
    ]
    fx.workspaceSessionsData = fx.sessionsData

    await renderSidebarForSessions(undefined)
    const timers = useFakeTimers()
    try {
      act(() => { fireEvent.click(screen.getByLabelText('Collapse workspace project')) })

      // Folding, not cut: the rows ride the closing fold out of sight.
      const row = screen.getByText('Idle session')
      expect(row.closest('[data-slot="collapsible"]')?.getAttribute('data-state')).toBe('closed')
      act(() => timers.tick(300))
      expect(screen.queryByText('Idle session')).toBeNull()
    } finally {
      timers.restore()
    }

    act(() => { fireEvent.click(screen.getByLabelText('Expand workspace project')) })
    expect(screen.getByText('Idle session').closest('[data-slot="collapsible"]')?.getAttribute('data-state')).toBe('open')
  })

  it('does not show a running indicator for idle coding sessions', async () => {
    fx.sessionsData = [
      {
        id: 'session-1',
        title: 'Idle session',
        agent_name: 'lead',
        created_at: '2026-05-13T00:00:00Z',
        updated_at: '2026-05-13T00:00:00Z',
        mode: 'coding',
        workspace: '/repo/project',
      },
    ]
    fx.workspaceSessionsData = fx.sessionsData

    await renderSidebarForSessions('session-1')

    expect(screen.queryByLabelText('Session running')).toBeNull()
  })

  /**
   * A session suspended on `ask_user` is still "running", so without a
   * distinct marker it is indistinguishable from one that is busy working — and
   * the whole point is that it is busy waiting for *this* user.
   */
  it('badges a session that is waiting for the user to answer a question', async () => {
    fx.sessionsData = [
      {
        id: 'session-1',
        title: 'Waiting session',
        agent_name: 'lead',
        created_at: '2026-05-13T00:00:00Z',
        updated_at: '2026-05-13T00:00:00Z',
        mode: 'coding',
        workspace: '/repo/project',
        running: true,
        needs_input: true,
      },
    ]
    fx.workspaceSessionsData = fx.sessionsData

    await renderSidebarForSessions(undefined)

    expect(screen.getByLabelText('Session needs your input')).toBeTruthy()
    expect(screen.queryByLabelText('Session running')).toBeNull()
  })

  it('loads more sessions from an explicit "Show more" row instead of a nested scroller', async () => {
    const user = userEvent.setup()
    fx.sessionsData = [
      {
        id: 'session-1',
        title: 'First page session',
        agent_name: 'lead',
        created_at: '2026-05-13T00:00:00Z',
        updated_at: '2026-05-13T00:00:00Z',
        mode: 'coding',
        workspace: '/repo/project',
      },
    ]
    fx.workspaceSessionsData = fx.sessionsData
    fx.workspaceHasNextPage = true

    await renderSidebarForSessions('session-1')

    const showMore = await screen.findByRole('button', { name: 'Show more' })
    expect(fetchWorkspaceNextPage).not.toHaveBeenCalled()
    await user.click(showMore)
    expect(fetchWorkspaceNextPage).toHaveBeenCalledTimes(1)
  })

  it('lists worktree sessions in the source repository, tagged with the worktree', async () => {
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
    globalThis.fetch = mock(async (input: unknown) => {
      const url = String(input)
      if (url.includes('/api/agent/workspace/tree')) {
        return new Response(JSON.stringify({ repositories: [{ path: '/repo/project', name: 'project', worktrees: [{ path: '/data/worktrees/project/task-a', name: 'task-a', managed: true }] }] }))
      }
      if (url.startsWith('/api/agent/workspace/worktrees')) return new Response(JSON.stringify([]))
      return new Response(null, { status: 404 })
    }) as typeof fetch

    localStorage.setItem('oa-coding-workspaces', JSON.stringify([
      { id: 'main', path: '/repo/project', createdAt: '2026-05-01T00:00:00Z' },
      { id: 'worktree', path: '/data/worktrees/project/task-a', createdAt: '2026-05-02T00:00:00Z' },
    ]))

    await renderSidebarWithProps({
      currentSessionId: 'session-1',
      workspace: '/data/worktrees/project/task-a',
    })

    // The row's tag is gone (the worktree is in its tooltip), so wait on the
    // row itself and the repository's worktree pill.
    await waitFor(() => expect(screen.getByText('Worktree session')).toBeTruthy())
    expect(worktreeChip()).toBeTruthy()
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(screen.getByLabelText('Collapse workspace project')).toBeTruthy()
    expect(screen.queryByLabelText('Collapse workspace task-a')).toBeNull()
    // No nested worktree row: its sessions sit in the repository list, tagged.
    expect(screen.queryByLabelText(/(Expand|Collapse) worktree/)).toBeNull()
    const row = screen.getByText('Worktree session').closest('[data-session-row]')
    // The worktree is in the row's tooltip, not drawn on the row at rest.
    expect(row?.querySelector('[data-checkout-tag]')).toBeNull()
    expect(screen.getByText('Worktree session').closest('button')?.getAttribute('title')).toContain('worktree task-a')
    // The repository's guide sits at the tree's one indent, the same constant
    // a session's subagent rows are inset by.
    expect(row).toBeTruthy()
    expect((row!.closest('.border-l') as HTMLElement).style.marginLeft).toBe(`${TREE_INDENT_PX}px`)
    expect(fx.workspaceQueryArgs.at(-1)).toEqual(['/repo/project', '/data/worktrees/project/task-a'])
  })

  it('files subfolders and outside worktrees under the repository and marks missing folders', async () => {
    const user = userEvent.setup()
    fx.sessionsData = []
    fx.workspaceSessionsData = fx.sessionsData
    globalThis.fetch = mock(async (input: unknown) => {
      const url = String(input)
      if (url.includes('/api/agent/workspace/tree')) {
        return new Response(JSON.stringify({
          repositories: [{
            path: '/repo/project',
            name: 'project',
            missing: true,
            worktrees: [
              { path: '/repo/project/web', name: 'web', managed: false, kind: 'folder', missing: false },
              { path: '/repo/project-fix', name: 'project-fix', managed: false, kind: 'worktree', missing: true },
            ],
          }],
        }))
      }
      if (url.startsWith('/api/agent/workspace/worktrees')) return new Response(JSON.stringify([]))
      return new Response(null, { status: 404 })
    }) as typeof fetch
    localStorage.setItem('oa-coding-workspaces', JSON.stringify([{ id: 'main', path: '/repo/project', createdAt: '2026-05-01T00:00:00Z' }]))

    await renderSidebarWithProps({ workspace: '/repo/project' })

    const repoRow = await waitFor(() => screen.getByLabelText('Open workspace project'))
    // A missing folder is a small ⚠ in the warning tone, not a chip: the name
    // keeps the row (muted), and the row's tooltip says where it was.
    const mark = repoRow.querySelector('[data-sidebar-missing]') as HTMLElement
    expect(mark.textContent).toBe('')
    expect(mark.getAttribute('aria-label')).toBe('Folder not found')
    expect(mark.className).toContain('text-(--accent-orange-text)')
    expect(repoRow.querySelector('[data-slot="chip"]')).toBeNull()
    expect(within(repoRow).getByText('project').className).toContain('text-(--color-text-muted)')
    await user.hover(repoRow)
    expect((await screen.findByRole('tooltip')).textContent).toBe('Folder not found at /repo/project')
    await user.unhover(repoRow)
    // Neither the subfolder nor the outside worktree is a repository row.
    expect(screen.queryByLabelText(/(Expand|Collapse) repository (web|project-fix)/)).toBeNull()
    await user.click(worktreeChip())
    const menu = await waitFor(() => screen.getByRole('menu', { name: 'Worktrees for project' }))
    const items = Array.from(menu.querySelectorAll('[role="menuitemradio"], [role="menuitemcheckbox"], [role="menuitem"]')).map((el) => el.textContent)
    // Subfolders come after the worktrees, under their own heading.
    expect(items.indexOf('web')).toBeGreaterThan(items.indexOf('project-fix'))
    expect(menu.querySelector('[data-checkout-folders-heading]')?.textContent).toBe('Folders')
    // A missing checkout gets the same mark (its row's title names the folder).
    expect(items).toContain('project-fix')
    const missingItem = within(menu).getByRole('menuitemradio', { name: /^project-fix/ })
    expect(missingItem.querySelector('[data-sidebar-missing]')).toBeTruthy()
    expect(missingItem.getAttribute('title')).toBe('Folder not found at /repo/project-fix')
  })

  it('keeps the source repository visible when the active session is a worktree', async () => {
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
    globalThis.fetch = mock(async (input: unknown) => {
      const url = String(input)
      if (url.includes('/api/agent/workspace/tree')) {
        return new Response(JSON.stringify({ repositories: [{ path: '/repo/project', name: 'project', worktrees: [{ path: '/data/worktrees/project/task-a', name: 'task-a', managed: true }] }] }))
      }
      if (url.startsWith('/api/agent/workspace/worktrees')) return new Response(JSON.stringify([]))
      return new Response(null, { status: 404 })
    }) as typeof fetch

    localStorage.setItem('oa-coding-workspaces', JSON.stringify([
      { id: 'main', path: '/repo/project', createdAt: '2026-05-01T00:00:00Z' },
      { id: 'worktree', path: '/data/worktrees/project/task-a', createdAt: '2026-05-02T00:00:00Z' },
    ]))

    await renderSidebarWithProps({
      currentSessionId: 'session-1',
      workspace: '/data/worktrees/project/task-a',
    })

    await waitFor(() => expect(screen.getByText('Worktree session')).toBeTruthy())
    expect(worktreeChip()).toBeTruthy()
    expect(screen.getByLabelText('Collapse workspace project')).toBeTruthy()
    expect(fx.workspaceQueryArgs.at(-1)).toEqual(['/repo/project', '/data/worktrees/project/task-a'])
    expect(screen.getAllByText('Worktree session').length).toBeGreaterThan(0)
  })

  it('marks grouped repositories and narrows the tree to one group', async () => {
    const user = userEvent.setup()
    fx.sessionsData = [
      { id: 'session-1', title: 'Feature', agent_name: 'lead', created_at: '2026-05-13T00:00:00Z', updated_at: '2026-05-13T00:00:00Z', mode: 'coding', workspace: '/repo/project' },
      { id: 'session-2', title: 'Other', agent_name: 'lead', created_at: '2026-05-13T00:00:00Z', updated_at: '2026-05-13T00:00:00Z', mode: 'coding', workspace: '/repo/other' },
    ]
    fx.workspaceSessionsData = fx.sessionsData
    fx.workspaceGroupsData = [{ id: 'g-acme', name: 'acme', brief: 'project = app' }]
    fx.groupIdsByRepo = { '/repo/project': ['g-acme'] }

    await renderSidebarForSessions('session-1')

    expect(screen.getByRole('img', { name: 'Groups: acme' })).toBeTruthy()
    expect(screen.getByLabelText('Open workspace other')).toBeTruthy()

    await act(async () => { useSidebarViewStore.getState().setGroupFilter('g-acme') })
    expect(screen.queryByLabelText('Open workspace other')).toBeNull()
    expect(screen.getByLabelText('Open workspace project')).toBeTruthy()

    await user.click(screen.getByRole('button', { name: 'Show all workspaces' }))
    expect(useSidebarViewStore.getState().groupFilter).toBeNull()
    expect(screen.getByLabelText('Open workspace other')).toBeTruthy()
  })

  it('pins the chat workspace and keeps repository actions off it', async () => {
    fx.chatWorkspaceEntry = { path: '/home/user', name: 'Chat' }
    fx.sessionsData = [
      {
        id: 'chat-1',
        title: 'Trip planning',
        agent_name: 'code',
        created_at: '2026-09-15T00:00:00Z',
        updated_at: '2026-09-15T00:00:00Z',
        workspace: '/home/user',
      },
    ]
    fx.workspaceSessionsData = fx.sessionsData

    await renderSidebarForSessions('chat-1')

    // Labelled "Chat" rather than the home directory's basename, and the
    // session list under it is reachable from the pinned row.
    expect(screen.getByText('Chat')).toBeTruthy()
    expect(screen.queryByText('user')).toBeNull()

    // No worktree/repo action menu: the chat root is not a repository.
    expect(screen.queryByLabelText('Actions for Chat')).toBeNull()
    expect(screen.getByLabelText('New session in Chat')).toBeTruthy()
  })

  it('keeps repository rows and their action menu unchanged', async () => {
    fx.chatWorkspaceEntry = { path: '/home/user', name: 'Chat' }
    fx.sessionsData = [
      {
        id: 'session-1',
        title: 'Feature session',
        agent_name: 'lead',
        created_at: '2026-05-13T00:00:00Z',
        updated_at: '2026-05-13T00:00:00Z',
        mode: 'coding',
        workspace: '/repo/project',
      },
    ]
    fx.workspaceSessionsData = fx.sessionsData

    await renderSidebarForSessions('session-1')

    expect(screen.getByText('project')).toBeTruthy()
    expect(screen.getByLabelText('Actions for project')).toBeTruthy()
  })
})
