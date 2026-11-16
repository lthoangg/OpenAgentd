import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {
  WORKTREE_CHIP,
  cleanupSidebarHarness,
  fx,
  renderSidebarWithProps,
  resetSidebarHarness,
  worktreeChip,
} from './harness'

describe('Sidebar workspace trust flow', () => {
  beforeEach(resetSidebarHarness)
  afterEach(cleanupSidebarHarness)

  it('renames a worktree sidebar title', async () => {
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
    let renameBody: unknown
    globalThis.fetch = mock(async (input: unknown, init: unknown) => {
      const url = String(input)
      if (url.includes('/api/agent/workspace/tree')) {
        return new Response(JSON.stringify({ repositories: [{ path: '/repo/project', name: 'project', worktrees: [{ path: '/data/worktrees/project/task-a', name: 'task-a', managed: true }] }] }))
      }
      if (url.includes('/api/agent/workspace/worktrees')) {
        if ((init as RequestInit | undefined)?.method === 'PATCH') {
          renameBody = JSON.parse(String((init as RequestInit | undefined)?.body))
          return new Response(JSON.stringify({ name: 'Review UI', directory: '/data/worktrees/project/task-a', managed: true }))
        }
        return new Response(JSON.stringify([]))
      }
      return new Response(null, { status: 404 })
    }) as typeof fetch

    await renderSidebarWithProps({ currentSessionId: 'session-1', workspace: '/repo/project' })
    await user.click(await screen.findByRole('button', WORKTREE_CHIP))
    await user.click(screen.getByRole('menuitemradio', { name: 'task-a' }))
    // Worktree actions act on the selected worktree.
    await user.click(worktreeChip())
    await user.click(screen.getByRole('menuitem', { name: 'Rename task-a…' }))
    // One name for the action: the entry, the dialog and its title say Rename.
    expect(screen.getByRole('heading', { name: 'Rename worktree' })).toBeTruthy()
    expect(screen.queryByText('Edit worktree title')).toBeNull()
    // The dialog's own header and footer, not overridden: its footer keeps the
    // layout DialogFooter gives it, and the built-in × stays on.
    const renameDialog = screen.getByRole('heading', { name: 'Rename worktree' }).closest('[data-dialog-content]') as HTMLElement
    expect(renameDialog.getAttribute('data-show-close')).toBe('true')
    expect(within(renameDialog).getByRole('button', { name: 'Cancel' }).parentElement?.getAttribute('data-class')).toBe('')
    const input = screen.getByLabelText('Worktree title')
    expect(input.className).toContain('text-xs')
    expect(input.className).not.toContain('text-sm')
    await user.clear(input)
    await user.type(input, 'Review UI')
    await user.click(screen.getByRole('button', { name: /^save$/i }))

    expect(renameBody).toEqual({ directory: '/data/worktrees/project/task-a', name: 'Review UI' })
  })

  it('removes deleted managed worktrees without promoting stale inverse relationships', async () => {
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
    globalThis.fetch = mock(async (input: unknown, init: unknown) => {
      const url = String(input)
      if (url.includes('/api/agent/workspace/tree')) {
        return new Response(JSON.stringify({ repositories: [{ path: '/repo/project', name: 'project', worktrees: [{ path: '/data/worktrees/project/task-a', name: 'task-a', managed: true }] }] }))
      }
      if (url.includes('/api/agent/workspace/worktrees')) {
        if ((init as RequestInit | undefined)?.method === 'DELETE') return new Response(JSON.stringify({ removed: true }))
        return new Response(JSON.stringify([]))
      }
      return new Response(null, { status: 404 })
    }) as typeof fetch

    localStorage.setItem('oa-coding-workspaces', JSON.stringify([
      { id: 'main', path: '/repo/project', createdAt: '2026-05-01T00:00:00Z' },
      { id: 'worktree', path: '/data/worktrees/project/task-a', createdAt: '2026-05-02T00:00:00Z' },
    ]))

    await renderSidebarWithProps({
      currentSessionId: 'session-1',
      workspace: '/repo/project',
    })

    await user.click(await screen.findByRole('button', WORKTREE_CHIP))
    // No worktree is selected yet, so there is nothing to remove.
    expect(screen.queryByRole('menuitem', { name: /^Remove / })).toBeNull()
    await user.click(screen.getByRole('menuitemradio', { name: 'task-a' }))
    await user.click(worktreeChip())
    await user.click(screen.getByRole('menuitem', { name: 'Delete worktree task-a…' }))

    // Managed-worktree removal is destructive, so it now requires
    // confirmation before it commits (error prevention).
    await user.click(screen.getByRole('button', { name: 'Delete worktree' }))

    await waitFor(() => expect(screen.queryByRole('button', WORKTREE_CHIP)).toBeNull())
    // Without worktrees the filter chip goes, and the list is the repository alone.
    expect(fx.workspaceQueryArgs.at(-1)).toBe('/repo/project')
    expect(screen.getByLabelText('Collapse workspace project')).toBeTruthy()
    expect(screen.queryByLabelText('Collapse workspace task-a')).toBeNull()
    expect(screen.queryByLabelText('Expand workspace task-a')).toBeNull()
  })

  describe('what deleting a worktree does to its branch', () => {
    /** Open the Delete worktree dialog for task-a, whose dry run answers `preview`. */
    async function openDeleteDialog(preview: Record<string, unknown>) {
      const user = userEvent.setup()
      fx.sessionsData = []
      fx.workspaceSessionsData = []
      const deletes: Array<Record<string, unknown>> = []
      globalThis.fetch = mock(async (input: unknown, init: unknown) => {
        const url = String(input)
        const request = init as RequestInit | undefined
        if (url.includes('/api/agent/workspace/tree')) {
          return new Response(JSON.stringify({ repositories: [{ path: '/repo/project', name: 'project', worktrees: [{ path: '/data/worktrees/project/task-a', name: 'task-a', managed: true }] }] }))
        }
        if (url.includes('/api/agent/workspace/worktrees')) {
          if (request?.method !== 'DELETE') return new Response(JSON.stringify([]))
          const body = JSON.parse(String(request.body)) as Record<string, unknown>
          deletes.push(body)
          return new Response(JSON.stringify(body.dry_run ? { removed: false, ...preview } : { removed: true, ...preview }))
        }
        return new Response(null, { status: 404 })
      }) as typeof fetch
      localStorage.setItem('oa-coding-workspaces', JSON.stringify([
        { id: 'main', path: '/repo/project', createdAt: '2026-05-01T00:00:00Z' },
        { id: 'worktree', path: '/data/worktrees/project/task-a', createdAt: '2026-05-02T00:00:00Z' },
      ]))
      await renderSidebarWithProps({ workspace: '/repo/project' })
      await user.click(await screen.findByRole('button', WORKTREE_CHIP))
      await user.click(screen.getByRole('menuitemradio', { name: 'task-a' }))
      await user.click(worktreeChip())
      await user.click(screen.getByRole('menuitem', { name: 'Delete worktree task-a…' }))
      return { user, deletes }
    }

    it('says the branch is kept when its commits are on no other branch', async () => {
      const { user, deletes } = await openDeleteDialog({ branch: 'oad/task-a', branch_deleted: false, unmerged_commits: 2 })

      expect(await screen.findByText('Branch oad/task-a has 2 commits that are on no other branch, so the branch is kept.')).toBeTruthy()
      // Asking is not deleting.
      expect(deletes).toEqual([{ source_workspace: '/repo/project', directory: '/data/worktrees/project/task-a', dry_run: true }])

      await user.click(screen.getByRole('button', { name: 'Delete worktree' }))
      await waitFor(() => expect(deletes.at(-1)).toEqual({ source_workspace: '/repo/project', directory: '/data/worktrees/project/task-a' }))
    })

    it('says a merged branch is deleted too', async () => {
      await openDeleteDialog({ branch: 'oad/task-a', branch_deleted: true, unmerged_commits: 0 })

      expect(await screen.findByText('Branch oad/task-a is merged and is deleted too.')).toBeTruthy()
    })

    it('says nothing about a branch it leaves alone', async () => {
      const { deletes } = await openDeleteDialog({ branch: 'feature/login', branch_deleted: false, unmerged_commits: 0 })

      await waitFor(() => expect(deletes).toHaveLength(1))
      expect(screen.getByText(/will be deleted from disk/)).toBeTruthy()
      expect(screen.queryByText(/feature\/login/)).toBeNull()
    })
  })
})
