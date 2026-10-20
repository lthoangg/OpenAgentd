/**
 * Workspace groups: named tags on repositories that decide which workspaces
 * may message each other (`send_to_workspace`). Groups and each
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

export function useSetWorkspaceGroupsMutation() {
  const onSuccess = useRefreshTree()
  return useMutation({
    mutationFn: ({ workspace, groupIds }: { workspace: string; groupIds: string[] }) => setWorkspaceGroups(workspace, groupIds),
    onSuccess,
  })
}
