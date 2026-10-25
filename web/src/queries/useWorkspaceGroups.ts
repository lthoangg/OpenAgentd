/**
 * Workspace groups: named tags on repositories that decide which workspaces
 * may message each other (the `workspace` tool). Groups and each
 * repository's tags ride on the workspace tree (`GET /agent/workspace/tree`),
 * so reading them adds no request and every mutation refreshes that query.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import {
  createWorkspaceGroup,
  deleteWorkspaceGroup,
  getCodingWorkspaceTree,
  setWorkspaceGroups,
  updateWorkspaceGroup,
} from '@/api/client'
import type { CodingWorkspaceTreeResponse, WorkspaceGroup } from '@/api/types'
import { queryKeys } from './keys'

const TREE_STALE_MS = 5_000

export interface WorkspaceGroupsView {
  groups: WorkspaceGroup[]
  /** Repository path → ids of its groups. */
  groupIdsByRepo: ReadonlyMap<string, readonly string[]>
  /** Repositories that can be grouped (worktrees use their repository's groups). */
  repositories: ReadonlyArray<{ path: string; name: string }>
}

const EMPTY: WorkspaceGroupsView = { groups: [], groupIdsByRepo: new Map(), repositories: [] }

export function selectWorkspaceGroups(tree: CodingWorkspaceTreeResponse): WorkspaceGroupsView {
  return {
    groups: tree.groups ?? [],
    groupIdsByRepo: new Map(tree.repositories.map((repo) => [repo.path, repo.group_ids ?? []])),
    repositories: tree.repositories.map(({ path, name }) => ({ path, name })),
  }
}

export function useWorkspaceGroups(): WorkspaceGroupsView {
  const { data } = useQuery({
    queryKey: queryKeys.coding.tree(),
    queryFn: getCodingWorkspaceTree,
    staleTime: TREE_STALE_MS,
    select: selectWorkspaceGroups,
  })
  return data ?? EMPTY
}

function useRefreshTree() {
  const queryClient = useQueryClient()
  return () => queryClient.invalidateQueries({ queryKey: queryKeys.coding.tree() })
}

export function useCreateWorkspaceGroupMutation() {
  const onSuccess = useRefreshTree()
  return useMutation({
    mutationFn: (body: { name: string; brief?: string | null; color?: string | null }) => createWorkspaceGroup(body),
    onSuccess,
  })
}

export function useUpdateWorkspaceGroupMutation() {
  const onSuccess = useRefreshTree()
  return useMutation({
    mutationFn: ({ id, ...body }: { id: string; name?: string; brief?: string | null; color?: string | null }) => updateWorkspaceGroup(id, body),
    onSuccess,
  })
}

export function useDeleteWorkspaceGroupMutation() {
  const onSuccess = useRefreshTree()
  return useMutation({
    mutationFn: (id: string) => deleteWorkspaceGroup(id),
    onSuccess,
  })
}

const SET_GROUPS_KEY = ['set-workspace-groups'] as const

/**
 * Membership changes show at once and save one after another, so several
 * toggles in a row each build on the last. A refused save puts the tree back
 * as it was before that change.
 */
export function useSetWorkspaceGroupsMutation() {
  const queryClient = useQueryClient()
  const key = queryKeys.coding.tree()
  return useMutation({
    mutationKey: SET_GROUPS_KEY,
    scope: { id: SET_GROUPS_KEY[0] },
    mutationFn: ({ workspace, groupIds }: { workspace: string; groupIds: string[] }) => setWorkspaceGroups(workspace, groupIds),
    onMutate: async ({ workspace, groupIds }) => {
      await queryClient.cancelQueries({ queryKey: key })
      const previous = queryClient.getQueryData<CodingWorkspaceTreeResponse>(key)
      queryClient.setQueryData<CodingWorkspaceTreeResponse>(key, (tree) =>
        tree && {
          ...tree,
          repositories: tree.repositories.map((repo) => (repo.path === workspace ? { ...repo, group_ids: groupIds } : repo)),
        },
      )
      return { previous }
    },
    onError: (_error, _vars, context) => {
      if (context?.previous) queryClient.setQueryData(key, context.previous)
    },
    // Refetch once the last queued change lands; an earlier refetch would
    // briefly undo the changes still waiting to save.
    onSettled: () => {
      if (queryClient.isMutating({ mutationKey: SET_GROUPS_KEY }) === 1) {
        return queryClient.invalidateQueries({ queryKey: key })
      }
    },
  })
}
