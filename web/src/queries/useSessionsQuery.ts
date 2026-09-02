import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { listSessions, deleteSession, updateSessionTitle } from '@/api/client'
import type { SessionPageResponse, SessionResponse } from '@/api/types'
import { queryKeys } from './keys'
import { patchSessionInPageData } from './session-cache'

const PAGE_SIZE = 20
const CODING_WORKSPACE_PAGE_SIZE = 5
const CODING_WORKSPACE_SMOOTHING_MS = 5000

export function useSessionsQuery() {
  return useInfiniteQuery({
    queryKey: queryKeys.session.sessions.workspace('__all_coding__'),
    queryFn: ({ pageParam }: { pageParam: string | null }) =>
      listSessions(pageParam, PAGE_SIZE),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage: SessionPageResponse) =>
      lastPage.has_more ? lastPage.next_cursor : undefined,
  })
}

export function useCodingWorkspaceSessionsQuery(workspace: string, enabled = true) {
  return useInfiniteQuery({
    queryKey: queryKeys.session.sessions.workspace(workspace),
    queryFn: ({ pageParam }: { pageParam: string | null }) =>
      listSessions(pageParam, CODING_WORKSPACE_PAGE_SIZE, { workspace }),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage: SessionPageResponse) =>
      lastPage.has_more ? lastPage.next_cursor : undefined,
    enabled,
    staleTime: CODING_WORKSPACE_SMOOTHING_MS,
  })
}

export function useUpdateSessionTitleMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, title }: { id: string; title: string }) => updateSessionTitle(id, title),
    onSuccess: (updated) => {
      queryClient.setQueriesData({ queryKey: queryKeys.session.sessions.all() }, (old) => patchSessionInPageData(old, updated))
      queryClient.setQueryData(queryKeys.session.sessions.detail(updated.id), (old: SessionResponse | undefined) => old ? { ...old, ...updated } : old)
    },
  })
}

export function useDeleteSessionMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: deleteSession,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.session.sessions.all() })
    },
  })
}
