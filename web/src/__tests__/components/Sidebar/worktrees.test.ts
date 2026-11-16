import { describe, expect, it } from 'bun:test'
import {
  loadWorktreesForSource,
  recoverCreatedWorktreeAfterTransientError,
  removeManagedWorktree,
} from '@/components/Sidebar/worktrees'

describe('Sidebar helpers', () => {
  it('exports worktree helpers used by the component', async () => {
    expect(await loadWorktreesForSource('/repo', async () => [{
      name: 'task-a',
      directory: '/repo/task-a',
      branch: 'feat',
      managed: true,
    }])).toEqual([{ name: 'task-a', directory: '/repo/task-a', branch: 'feat', managed: true }])

    expect(await loadWorktreesForSource('/repo', async () => { throw new Error('boom') })).toEqual([])

    const removed = await removeManagedWorktree(
      { name: 'task-a', directory: '/repo/task-a', branch: 'feat', managed: true },
      {
        worktreeTarget: '/repo',
        worktreeSourceByDirectory: new Map([['/repo/task-a', '/repo']]),
        loadWorktreesForSource: async () => [],
        refreshWorkspaceTree: async () => undefined,
        removeWorktreeFn: async () => undefined,
      },
    )
    expect(removed?.removedDirectory).toBe('/repo/task-a')

    const recovered = await recoverCreatedWorktreeAfterTransientError({
      error: new TypeError("Failed to fetch"),
      worktreeTarget: '/repo',
      worktreeName: 'task a',
      loadWorktreesForSource: async () => [{
        name: 'task-a',
        directory: '/repo/task-a',
        branch: 'feat',
        managed: true,
      }],
      refreshWorkspaceTree: async () => undefined,
      navigate: () => undefined,
      onMobileClose: () => undefined,
    })
    expect(recovered).toEqual({ kind: 'recovered', workspace: '/repo/task-a' })
  })
})
