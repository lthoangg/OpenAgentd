import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { immer } from 'zustand/middleware/immer'

export interface WorkspaceGitState {
  subTab: 'changes' | 'commits'
  expandedCommitSha: string | null
  expandedDiffs: string[]
  expandedCommitFiles: string[]
}

export const DEFAULT_WORKSPACE_STATE: WorkspaceGitState = {
  subTab: 'changes',
  expandedCommitSha: null,
  expandedDiffs: [],
  expandedCommitFiles: [],
}

interface GitPanelStore {
  workspaces: Record<string, WorkspaceGitState>
  getWorkspaceState: (workspacePath: string) => WorkspaceGitState
  setSubTab: (workspacePath: string, subTab: WorkspaceGitState['subTab']) => void
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
      expandedCommitSha: null,
      expandedDiffs: [],
      expandedCommitFiles: [],
    }
  }
}

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []

/**
 * One stored workspace, as any build wrote it. Builds before v3.40.0 had a
 * graph view (`tree`) with an All branches toggle; the graph is gone, so it
 * opens as the commit list and the toggle is dropped.
 */
function readWorkspaceState(value: unknown): WorkspaceGitState {
  const stored = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>
  return {
    subTab: stored.subTab === 'commits' || stored.subTab === 'tree' ? 'commits' : 'changes',
    expandedCommitSha: typeof stored.expandedCommitSha === 'string' ? stored.expandedCommitSha : null,
    expandedDiffs: strings(stored.expandedDiffs),
    expandedCommitFiles: strings(stored.expandedCommitFiles),
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
      merge: (persisted, current) => {
        const stored = (persisted as { workspaces?: unknown } | undefined)?.workspaces
        const workspaces = stored && typeof stored === 'object' ? stored as Record<string, unknown> : {}
        return {
          ...current,
          workspaces: Object.fromEntries(Object.entries(workspaces).map(([path, value]) => [path, readWorkspaceState(value)])),
        }
      },
    }
  )
)
