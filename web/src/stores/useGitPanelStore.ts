import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { immer } from 'zustand/middleware/immer'

export interface WorkspaceGitState {
  subTab: 'changes' | 'commits' | 'tree'
  allBranches: boolean
  expandedCommitSha: string | null
  expandedDiffs: string[]
  expandedCommitFiles: string[]
}

export const DEFAULT_WORKSPACE_STATE: WorkspaceGitState = {
  subTab: 'changes',
  allBranches: false,
  expandedCommitSha: null,
  expandedDiffs: [],
  expandedCommitFiles: [],
}

interface GitPanelStore {
  workspaces: Record<string, WorkspaceGitState>
  getWorkspaceState: (workspacePath: string) => WorkspaceGitState
  setSubTab: (workspacePath: string, subTab: 'changes' | 'commits' | 'tree') => void
  setAllBranches: (workspacePath: string, allBranches: boolean) => void
  setExpandedCommitSha: (workspacePath: string, sha: string | null) => void
  setExpandedDiffs: (workspacePath: string, paths: string[]) => void
  toggleDiffExpanded: (workspacePath: string, path: string) => void
  setExpandedCommitFiles: (workspacePath: string, paths: string[]) => void
  toggleCommitFileExpanded: (workspacePath: string, path: string) => void
}

const ensureWorkspaceState = (state: { workspaces: Record<string, WorkspaceGitState> }, workspacePath: string) => {
  if (!state.workspaces[workspacePath]) {
    state.workspaces[workspacePath] = {
      subTab: 'changes',
      allBranches: false,
      expandedCommitSha: null,
      expandedDiffs: [],
      expandedCommitFiles: [],
    }
  }
}

export const useGitPanelStore = create<GitPanelStore>()(
  persist(
    immer((set, get) => ({
      workspaces: {},

      getWorkspaceState: (workspacePath) => {
        return get().workspaces[workspacePath] || DEFAULT_WORKSPACE_STATE
      },

      setSubTab: (workspacePath, subTab) => {
        set((state) => {
          ensureWorkspaceState(state, workspacePath)
          state.workspaces[workspacePath].subTab = subTab
        })
      },

      setAllBranches: (workspacePath, allBranches) => {
        set((state) => {
          ensureWorkspaceState(state, workspacePath)
          state.workspaces[workspacePath].allBranches = allBranches
        })
      },

      setExpandedCommitSha: (workspacePath, sha) => {
        set((state) => {
          ensureWorkspaceState(state, workspacePath)
          state.workspaces[workspacePath].expandedCommitSha = sha
        })
      },

      setExpandedDiffs: (workspacePath, paths) => {
        set((state) => {
          ensureWorkspaceState(state, workspacePath)
          state.workspaces[workspacePath].expandedDiffs = paths
        })
      },

      toggleDiffExpanded: (workspacePath, path) => {
        set((state) => {
          ensureWorkspaceState(state, workspacePath)
          const current = state.workspaces[workspacePath].expandedDiffs
          if (current.includes(path)) {
            state.workspaces[workspacePath].expandedDiffs = current.filter((p) => p !== path)
          } else {
            state.workspaces[workspacePath].expandedDiffs.push(path)
          }
        })
      },

      setExpandedCommitFiles: (workspacePath, paths) => {
        set((state) => {
          ensureWorkspaceState(state, workspacePath)
          state.workspaces[workspacePath].expandedCommitFiles = paths
        })
      },

      toggleCommitFileExpanded: (workspacePath, path) => {
        set((state) => {
          ensureWorkspaceState(state, workspacePath)
          const current = state.workspaces[workspacePath].expandedCommitFiles
          if (current.includes(path)) {
            state.workspaces[workspacePath].expandedCommitFiles = current.filter((p) => p !== path)
          } else {
            state.workspaces[workspacePath].expandedCommitFiles.push(path)
          }
        })
      },
    })),
    {
      name: 'oa.gitPanelStore',
    }
  )
)
