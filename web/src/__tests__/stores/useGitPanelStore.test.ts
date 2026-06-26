import { afterEach, describe, expect, it } from 'bun:test'
import { useGitPanelStore, DEFAULT_WORKSPACE_STATE } from '@/stores/useGitPanelStore'

function resetStore(): void {
  useGitPanelStore.setState({ workspaces: {} })
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

  it('toggles allBranches checkbox state', () => {
    const path = '/repo/project-a'
    useGitPanelStore.getState().setAllBranches(path, true)

    let state = useGitPanelStore.getState().getWorkspaceState(path)
    expect(state.allBranches).toBe(true)

    useGitPanelStore.getState().setAllBranches(path, false)
    state = useGitPanelStore.getState().getWorkspaceState(path)
    expect(state.allBranches).toBe(false)
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

    useGitPanelStore.getState().setSubTab(pathA, 'tree')
    useGitPanelStore.getState().setSubTab(pathB, 'commits')

    expect(useGitPanelStore.getState().getWorkspaceState(pathA).subTab).toBe('tree')
    expect(useGitPanelStore.getState().getWorkspaceState(pathB).subTab).toBe('commits')
  })
})
