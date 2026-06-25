import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { listTeamSessions, deleteTeamSession, updateTeamSessionTitle } from '@/api/client'
import type { SessionPageResponse, SessionResponse } from '@/api/types'
import { queryKeys } from './keys'
import { patchSessionInPageData } from './session-cache'

const PAGE_SIZE = 20
const CODING_WORKSPACE_PAGE_SIZE = 5
const CODING_WORKSPACE_SMOOTHING_MS = 5000

export function useTeamSessionsQuery(mode?: 'normal' | 'coding') {
  return useInfiniteQuery({
    queryKey: mode === 'coding'
      ? queryKeys.team.sessions.workspace('__all_coding__')
      : queryKeys.team.sessions.infinite(),
    queryFn: ({ pageParam }: { pageParam: string | null }) =>
      listTeamSessions(pageParam, PAGE_SIZE, mode ? { mode } : undefined),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage: SessionPageResponse) =>
      lastPage.has_more ? lastPage.next_cursor : undefined,
  })
}

export function useCodingWorkspaceSessionsQuery(workspace: string, enabled = true) {
  return useInfiniteQuery({
    queryKey: queryKeys.team.sessions.workspace(workspace),
    queryFn: ({ pageParam }: { pageParam: string | null }) =>
      listTeamSessions(pageParam, CODING_WORKSPACE_PAGE_SIZE, { mode: 'coding', workspace }),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage: SessionPageResponse) =>
      lastPage.has_more ? lastPage.next_cursor : undefined,
    enabled,
    staleTime: CODING_WORKSPACE_SMOOTHING_MS,
  })
}

export function useUpdateTeamSessionTitleMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, title }: { id: string; title: string }) => updateTeamSessionTitle(id, title),
    onSuccess: (updated) => {
      queryClient.setQueriesData({ queryKey: queryKeys.team.sessions.all() }, (old) => patchSessionInPageData(old, updated))
      queryClient.setQueryData(queryKeys.team.sessions.detail(updated.id), (old: SessionResponse | undefined) => old ? { ...old, ...updated } : old)
    },
  })
}

export function useDeleteTeamSessionMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: deleteTeamSession,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.team.sessions.all() })
    },
  })
}
