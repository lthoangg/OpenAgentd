import { useInfiniteQuery, useMutation, useQueryClient, useQuery } from '@tanstack/react-query'
import { listSessions, deleteSession, updateSessionTitle, listSubagents } from '@/api/client'
import type { SessionPageResponse, SessionResponse } from '@/api/types'
import { queryKeys } from './keys'
import { patchSessionInPageData } from './session-cache'

const PAGE_SIZE = 20
const CODING_WORKSPACE_PAGE_SIZE = 5
const CODING_WORKSPACE_SMOOTHING_MS = 5000

export function useSessionsQuery() {
  return useInfiniteQuery({
    queryKey: queryKeys.session.sessions.workspace('__all_coding__'),
    queryFn: ({ pageParam, signal }) =>
      listSessions(pageParam, PAGE_SIZE, undefined, signal),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage: SessionPageResponse) =>
      lastPage.has_more ? lastPage.next_cursor : undefined,
  })
}

export function useCodingWorkspaceSessionsQuery(workspace: string, enabled = true) {
  return useInfiniteQuery({
    queryKey: queryKeys.session.sessions.workspace(workspace),
    queryFn: ({ pageParam, signal }) =>
      listSessions(pageParam, CODING_WORKSPACE_PAGE_SIZE, { workspace }, signal),
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
      queryClient.invalidateQueries({ queryKey: ['session', 'subagents'] })
    },
  })
}

export function useSessionSubagentsQuery(sessionId: string | null | undefined, enabled = true) {
  return useQuery({
    queryKey: queryKeys.session.subagents(sessionId ?? ''),
    queryFn: () => listSubagents(sessionId!),
    enabled: Boolean(sessionId) && enabled,
    staleTime: 5000,
  })
}
