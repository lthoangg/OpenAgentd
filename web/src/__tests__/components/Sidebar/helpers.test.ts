import { describe, expect, it } from 'bun:test'
import {
  addExpandedPaths,
  buildWorktreeSourceByDirectory,
  groupSessionsByWorkspace,
  repositoryCheckouts,
  sourceWorkspacePaths,
  toggleExpandedPath,
  visibleNestedWorktrees,
} from '@/components/Sidebar/helpers'

describe('Sidebar helpers', () => {
  it('toggles expanded paths and can batch-add active paths', () => {
    expect([...toggleExpandedPath(new Set<string>(), '/repo')]).toEqual(['/repo'])
    expect([...toggleExpandedPath(new Set<string>(['/repo']), '/repo')]).toEqual([])
    expect([...addExpandedPaths(new Set<string>(), ['/repo', null, '/worktree'])]).toEqual([
      '/repo',
      '/worktree',
    ])
  })

  it('builds worktree source lookup and filters removed worktrees', () => {
    const workspaceTree = [
      {
        path: '/repo',
        name: 'repo',
        worktrees: [
          { path: '/repo-wt', name: 'repo-wt', managed: true },
        ],
      },
    ]
    const removed = new Set<string>(['/repo-wt'])
    const sources = buildWorktreeSourceByDirectory(workspaceTree)

    expect(sources.get('/repo-wt')).toBe('/repo')
    expect(sourceWorkspacePaths(workspaceTree, removed)).toEqual(['/repo'])
    expect(visibleNestedWorktrees(workspaceTree[0], removed)).toEqual([])
  })

  it('lists every checkout of a repository unless one is selected', () => {
    const repository = {
      path: '/repo',
      name: 'repo',
      worktrees: [
        { path: '/wt/a', name: 'a', managed: true },
        { path: '/wt/b', name: 'b', managed: false },
      ],
    }
    const none = new Set<string>()

    const all = repositoryCheckouts('/repo', repository, none, undefined)
    expect(all.selected).toBeNull()
    expect(all.selectedWorktree).toBeNull()
    expect(all.listPaths).toEqual(['/repo', '/wt/a', '/wt/b'])
    expect([...all.worktreeNames]).toEqual([['/wt/a', 'a'], ['/wt/b', 'b']])

    const oneWorktree = repositoryCheckouts('/repo', repository, none, '/wt/b')
    expect(oneWorktree.selected).toBe('/wt/b')
    expect(oneWorktree.selectedWorktree?.name).toBe('b')
    expect(oneWorktree.listPaths).toEqual(['/wt/b'])

    const mainOnly = repositoryCheckouts('/repo', repository, none, '/repo')
    expect(mainOnly.selected).toBe('/repo')
    expect(mainOnly.selectedWorktree).toBeNull()
    expect(mainOnly.listPaths).toEqual(['/repo'])

    // A selection that no longer exists (removed or unknown) falls back to all.
    const removed = repositoryCheckouts('/repo', repository, new Set(['/wt/a']), '/wt/a')
    expect(removed.selected).toBeNull()
    expect(removed.listPaths).toEqual(['/repo', '/wt/b'])
    expect(repositoryCheckouts('/chat', undefined, none, '/elsewhere').listPaths).toEqual(['/chat'])
  })

  it('groups sessions by workspace and drops sessions without one', () => {
    const makeSession = (id: string, workspace: string | null) => ({
      id,
      title: null,
      agent_name: null,
      created_at: null,
      updated_at: null,
      workspace,
    })

    const sessions = [
      makeSession('a', '/repo'),
      makeSession('b', '/repo-wt'),
      makeSession('c', '/repo'),
      makeSession('d', null),
    ]

    const byWorkspace = groupSessionsByWorkspace(sessions)

    expect(byWorkspace.get('/repo')?.map((s) => s.id)).toEqual(['a', 'c'])
    expect(byWorkspace.get('/repo-wt')?.map((s) => s.id)).toEqual(['b'])
    expect([...byWorkspace.keys()]).toEqual(['/repo', '/repo-wt'])
  })
})
