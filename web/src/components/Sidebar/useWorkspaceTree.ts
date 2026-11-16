// Not compiled, as when this code was part of Sidebar, which the React
// Compiler skipped; compiling it is a change of its own to verify.
'use no memo'
/**
 * The workspace tree the sidebar lists: repositories with their worktrees
 * and workspace groups, from the shared query (so a refresh made anywhere,
 * the command palette's workspace switch or another window, shows here
 * too), with Chat prepended as a pinned row.
 */
import { useCallback, useEffect, useMemo } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { getCodingWorkspaceTree } from '@/api/client'
import type { CodingWorkspaceTreeRepository, WorkspaceGroup } from '@/api/types'
import { queryKeys } from '@/queries/keys'
import { isChatWorkspacePath, useChatWorkspace } from '@/queries/useChatWorkspace'
import { useSidebarViewStore } from '@/stores/useSidebarViewStore'
import { WORKSPACES_KEY } from '@/utils/workspace'
import { buildWorktreeSourceByDirectory } from './helpers'

const WORKSPACE_TREE_STALE_MS = 30_000
const NO_REPOSITORIES: CodingWorkspaceTreeRepository[] = []
export const NO_GROUPS: WorkspaceGroup[] = []

export type WorkspaceTreeState = ReturnType<typeof useWorkspaceTree>

export function useWorkspaceTree() {
  const queryClient = useQueryClient()
  const groupFilter = useSidebarViewStore((s) => s.groupFilter)
  const {
    data: workspaceTreeData,
    isPending: workspaceTreePending,
    isError: workspaceTreeFailed,
    refetch: refetchWorkspaceTree,
    isRefetching: workspaceTreeRetrying,
  } = useQuery({
    queryKey: queryKeys.coding.tree(),
    queryFn: getCodingWorkspaceTree,
    staleTime: WORKSPACE_TREE_STALE_MS,
  })
  const workspaceTree = workspaceTreeData?.repositories ?? NO_REPOSITORIES
  const workspaceByPath = useMemo(
    () => new Map(workspaceTree.map((repo) => [repo.path, repo])),
    [workspaceTree],
  )
  // Workspace groups: tags on repositories that set who may message whom.
  const workspaceGroups = workspaceTreeData?.groups ?? NO_GROUPS
  const groupsOf = (path: string) => {
    const ids = workspaceByPath.get(path)?.group_ids ?? []
    return workspaceGroups.filter((g) => ids.includes(g.id))
  }
  // A filter for a group that no longer exists shows everything.
  const activeGroupFilter = workspaceGroups.find((g) => g.id === groupFilter) ?? null
  // The chat workspace is a pinned, non-repository row: the backend never
  // stores it in ``coding_workspaces``, so it is prepended here.
  const chatWorkspace = useChatWorkspace()
  const isChatPath = (path: string | null | undefined) =>
    isChatWorkspacePath(path, chatWorkspace)
  const visibleWorkspaces = [
    ...(chatWorkspace ? [chatWorkspace.path] : []),
    ...workspaceTree.map((repo) => repo.path).filter((path) => !isChatPath(path)),
  ]
  const worktreeSourceByDirectory = buildWorktreeSourceByDirectory(workspaceTree)

  // Every caller has just changed the tree on the server, so a cached copy
  // is never good enough. Invalidating also restarts a fetch already in
  // flight, which may have left before the change landed.
  const refreshWorkspaceTree = useCallback(
    () => queryClient.invalidateQueries({ queryKey: queryKeys.coding.tree() }),
    [queryClient],
  )

  useEffect(() => {
    const handler = () => { void refreshWorkspaceTree() }
    // Other windows also write storage for unrelated state (unread marks on
    // every finished turn, theme…); only the saved workspace list moves the tree.
    const onStorage = (event: StorageEvent) => {
      if (event.key === null || event.key === WORKSPACES_KEY) handler()
    }
    window.addEventListener('workspaces-changed', handler)
    window.addEventListener('storage', onStorage)
    return () => {
      window.removeEventListener('workspaces-changed', handler)
      window.removeEventListener('storage', onStorage)
    }
  }, [refreshWorkspaceTree])

  return {
    workspaceTreePending,
    workspaceTreeFailed,
    refetchWorkspaceTree,
    workspaceTreeRetrying,
    workspaceTree,
    workspaceByPath,
    workspaceGroups,
    groupsOf,
    activeGroupFilter,
    chatWorkspace,
    isChatPath,
    visibleWorkspaces,
    worktreeSourceByDirectory,
    refreshWorkspaceTree,
  }
}
