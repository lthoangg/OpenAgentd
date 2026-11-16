import { describe, expect, it, mock } from 'bun:test'
import { QueryClient } from '@tanstack/react-query'
import {
  confirmWorkspaceRemoval,
  openWorkspaceDraft,
} from '@/components/Sidebar/workspace'

describe('Sidebar helpers', () => {
  it('exports workspace helpers used by the component', async () => {
    // Open workspace on a folder the sidebar does not list registers it first.
    const setVisibility = mock(async (..._args: unknown[]) => ({ workspace: '/repo/new', hidden: false, updated: 0 }))
    let refreshCount = 0
    const folderNavigate = mock((..._args: unknown[]) => {})
    await openWorkspaceDraft({
      path: '/repo/new',
      listed: false,
      refreshWorkspaceTree: async () => { refreshCount += 1 },
      navigate: folderNavigate,
      setCodingWorkspaceVisibilityFn: setVisibility as never,
    })
    expect(setVisibility).toHaveBeenCalledWith('/repo/new', false)
    expect(refreshCount).toBe(1)
    expect(folderNavigate).toHaveBeenCalledWith({ to: '/', search: { workspace: '/repo/new' }, replace: false })
    await openWorkspaceDraft({
      path: '/repo/listed',
      listed: true,
      refreshWorkspaceTree: async () => { refreshCount += 1 },
      navigate: folderNavigate,
      setCodingWorkspaceVisibilityFn: setVisibility as never,
    })
    expect(setVisibility).toHaveBeenCalledTimes(1)
    expect(refreshCount).toBe(1)

    const removeNavigate = mock(() => {})
    const nextExpanded = await confirmWorkspaceRemoval({
      path: '/repo/project',
      activeWorkspace: '/repo/project',
      expandedWorkspaces: new Set<string>(['/repo/project', '/repo/other']),
      queryClient: new QueryClient(),
      refreshWorkspaceTree: async () => undefined,
      navigate: removeNavigate,
      setCodingWorkspaceVisibilityFn: async () => ({
        workspace: '/repo/project',
        hidden: true,
        updated: 1,
      }),
    })
    expect(nextExpanded.has('/repo/project')).toBe(false)
    expect(nextExpanded.has('/repo/other')).toBe(true)
    expect(removeNavigate).toHaveBeenCalledWith({ to: '/', replace: true })
  })
})
