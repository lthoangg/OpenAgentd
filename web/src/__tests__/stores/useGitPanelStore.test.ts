import { afterEach, describe, expect, it } from 'bun:test'
import { useGitPanelStore, DEFAULT_WORKSPACE_STATE } from '@/stores/useGitPanelStore'

function resetStore(): void {
  useGitPanelStore.setState({ workspaces: {} })
  localStorage.removeItem('oa.gitPanelStore')
}

afterEach(resetStore)

describe('useGitPanelStore', () => {
  it('returns default state for uninitialized workspaces', () => {
    const state = useGitPanelStore.getState().getWorkspaceState('/repo/unknown')
    expect(state).toEqual(DEFAULT_WORKSPACE_STATE)
  })

  it('sets subTab correctly', () => {
    const path = '/repo/project-a'
    useGitPanelStore.getState().setSubTab(path, 'commits')

    const state = useGitPanelStore.getState().getWorkspaceState(path)
    expect(state.subTab).toBe('commits')
  })

  it('opens a stored Graph view as the commit list and forgets All branches', async () => {
    // Builds before v3.40.0 stored the graph as `tree`, with its toggle.
    localStorage.setItem('oa.gitPanelStore', JSON.stringify({
      state: {
        workspaces: {
          '/repo/graph': { subTab: 'tree', allBranches: true, expandedCommitSha: 'abc', expandedDiffs: ['a.ts'], expandedCommitFiles: [] },
          '/repo/changes': { subTab: 'changes', allBranches: false, expandedCommitSha: null, expandedDiffs: [], expandedCommitFiles: [] },
        },
      },
      version: 0,
    }))

    await useGitPanelStore.persist.rehydrate()

    const graph = useGitPanelStore.getState().getWorkspaceState('/repo/graph')
    expect(graph).toEqual({ subTab: 'commits', expandedCommitSha: 'abc', expandedDiffs: ['a.ts'], expandedCommitFiles: [] })
    expect(useGitPanelStore.getState().getWorkspaceState('/repo/changes').subTab).toBe('changes')
  })

  it('sets and toggles expandedDiffs correctly', () => {
    const path = '/repo/project-a'
    const fileA = 'src/index.ts'
    const fileB = 'package.json'

    // Add fileA
    useGitPanelStore.getState().toggleDiffExpanded(path, fileA)
    let state = useGitPanelStore.getState().getWorkspaceState(path)
    expect(state.expandedDiffs).toEqual([fileA])

    // Add fileB
    useGitPanelStore.getState().toggleDiffExpanded(path, fileB)
    state = useGitPanelStore.getState().getWorkspaceState(path)
    expect(state.expandedDiffs).toEqual([fileA, fileB])

    // Toggle fileA (should remove it)
    useGitPanelStore.getState().toggleDiffExpanded(path, fileA)
    state = useGitPanelStore.getState().getWorkspaceState(path)
    expect(state.expandedDiffs).toEqual([fileB])
  })

  it('sets and toggles expandedCommitFiles correctly', () => {
    const path = '/repo/project-a'
    const file = 'README.md'

    useGitPanelStore.getState().toggleCommitFileExpanded(path, file)
    let state = useGitPanelStore.getState().getWorkspaceState(path)
    expect(state.expandedCommitFiles).toEqual([file])

    useGitPanelStore.getState().toggleCommitFileExpanded(path, file)
    state = useGitPanelStore.getState().getWorkspaceState(path)
    expect(state.expandedCommitFiles).toEqual([])
  })

  it('sets expandedCommitSha correctly', () => {
    const path = '/repo/project-a'
    const sha = 'abcdef0123'

    useGitPanelStore.getState().setExpandedCommitSha(path, sha)
    let state = useGitPanelStore.getState().getWorkspaceState(path)
    expect(state.expandedCommitSha).toBe(sha)

    useGitPanelStore.getState().setExpandedCommitSha(path, null)
    state = useGitPanelStore.getState().getWorkspaceState(path)
    expect(state.expandedCommitSha).toBeNull()
  })

  it('keeps states isolated between different workspaces', () => {
    const pathA = '/repo/project-a'
    const pathB = '/repo/project-b'

    useGitPanelStore.getState().setSubTab(pathA, 'changes')
    useGitPanelStore.getState().setSubTab(pathB, 'commits')

    expect(useGitPanelStore.getState().getWorkspaceState(pathA).subTab).toBe('changes')
    expect(useGitPanelStore.getState().getWorkspaceState(pathB).subTab).toBe('commits')
  })
})
