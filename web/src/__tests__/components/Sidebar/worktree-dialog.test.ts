import { describe, expect, it, mock } from 'bun:test'
import {
  beginWorktreeTitleEdit,
  buildOpenWorktreeDialogState,
  prepareWorktreeRename,
  submitWorktreeRename,
} from '@/components/Sidebar/worktree-dialog'

describe('Sidebar helpers', () => {
  it('exports worktree dialog helpers used by the component', async () => {
    expect(buildOpenWorktreeDialogState('/repo/project')).toEqual({
      target: '/repo/project',
      name: '',
      branch: '',
      removing: null,
      error: null,
    })

    const editState = beginWorktreeTitleEdit({
      name: 'task-a',
      directory: '/repo/project/task-a',
      branch: 'feat',
      managed: true,
    })
    expect(editState).toEqual({
      target: {
        name: 'task-a',
        directory: '/repo/project/task-a',
        branch: 'feat',
        managed: true,
      },
      title: 'task-a',
    })

    expect(prepareWorktreeRename(editState.target, '  Review UI  ')).toEqual({
      directory: '/repo/project/task-a',
      title: 'Review UI',
    })
    expect(prepareWorktreeRename(editState.target, '   ')).toBeNull()
    expect(prepareWorktreeRename(null, 'Review UI')).toBeNull()

    const renameWorktreeFn = mock(async () => ({
      name: 'Review UI',
      directory: '/repo/project/task-a',
      managed: true,
    }))
    let refreshed = 0
    expect(await submitWorktreeRename({
      target: editState.target,
      title: '  Review UI  ',
      refreshWorkspaceTree: async () => { refreshed += 1 },
      renameWorktreeFn,
    })).toBe(true)
    expect(renameWorktreeFn).toHaveBeenCalledWith('/repo/project/task-a', 'Review UI')
    expect(refreshed).toBe(1)
    expect(await submitWorktreeRename({
      target: editState.target,
      title: '   ',
      refreshWorkspaceTree: async () => undefined,
      renameWorktreeFn,
    })).toBe(false)
  })
})
