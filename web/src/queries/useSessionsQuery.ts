import { useInfiniteQuery, useMutation, useQueryClient, useQuery, type InfiniteData } from '@tanstack/react-query'
import { listSessions, deleteSession, updateSessionTitle, listSubagents, setSessionPinned } from '@/api/client'
import type { SessionPageResponse, SessionResponse } from '@/api/types'
import { queryKeys } from './keys'
import { applySessionRename } from './session-rename'
import { removeSubagent } from '@/stores/cache-invalidation-bridge'
import { broadcastMessage } from '@/lib/broadcast-channel'

const PAGE_SIZE = 20
const CODING_WORKSPACE_PAGE_SIZE = 5
const CODING_WORKSPACE_SMOOTHING_MS = 5000

type SessionPages = InfiniteData<SessionPageResponse, string | null>

function keepRows(data: SessionPages, keep: (session: SessionResponse) => boolean): SessionPages {
  return { ...data, pages: data.pages.map((page) => ({ ...page, data: page.data.filter(keep) })) }
}

// Module-level so TanStack memoizes the projection per cache update. An older
// server ignores ``pinned``, so the client enforces the filter too.
const withoutPinned = (data: SessionPages) => keepRows(data, (session) => !session.pinned_at)
const onlyPinned = (data: SessionPages) => keepRows(data, (session) => Boolean(session.pinned_at))

/** Every session list here is in recent-activity order (newest message first). */
const SORT = 'activity' as const

export function useSessionsQuery() {
  return useInfiniteQuery({
    queryKey: queryKeys.session.sessions.workspace('__all_coding__', SORT),
    queryFn: ({ pageParam, signal }) =>
      listSessions(pageParam, PAGE_SIZE, { sort: SORT }, signal),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage: SessionPageResponse) =>
      lastPage.has_more ? lastPage.next_cursor : undefined,
  })
}

/**
 * Sessions in one workspace, or in several checkouts at once (a repository
 * and its worktrees). A single path keeps the per-workspace key and filter;
 * several use the v3 ``workspaces`` filter, which an older server ignores, so
 * callers filter the rows they show.
 *
 * Pinned sessions live in the sidebar's Pinned section, so they are left out
 * here (server-side on v3, and by ``select`` for an older server).
 */
export function useWorkspaceSessionsQuery(
  workspace: string | readonly string[],
  enabled = true,
) {
  const sort = SORT
  const paths = typeof workspace === 'string' ? [workspace] : workspace
  const single = paths.length === 1 ? paths[0] : null
  return useInfiniteQuery({
    queryKey: single !== null
      ? queryKeys.session.sessions.workspace(single, sort)
      : queryKeys.session.sessions.checkouts(paths, sort),
    queryFn: ({ pageParam, signal }) =>
      listSessions(
        pageParam,
        CODING_WORKSPACE_PAGE_SIZE,
        single !== null ? { workspace: single, sort, pinned: false } : { workspaces: paths, sort, pinned: false },
        signal,
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage: SessionPageResponse) =>
      lastPage.has_more ? lastPage.next_cursor : undefined,
    select: withoutPinned,
    enabled: enabled && paths.length > 0,
    staleTime: CODING_WORKSPACE_SMOOTHING_MS,
    // The global event stream patches these rows in place and resyncs after
    // any gap; a focus refetch re-read every loaded page of every workspace
    // in the sidebar, one request per page, on each alt-tab.
    refetchOnWindowFocus: false,
  })
}

/**
 * Every unpinned top-level session across workspaces, most recently active first: the
 * sidebar's Status / Date / None views. Only fetched while one is shown.
 */
export function useAllSessionsQuery(enabled = true) {
  const sort = SORT
  return useInfiniteQuery({
    queryKey: queryKeys.session.sessions.everywhere(sort),
    queryFn: ({ pageParam, signal }) => listSessions(pageParam, PAGE_SIZE, { sort, pinned: false }, signal),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage: SessionPageResponse) =>
      lastPage.has_more ? lastPage.next_cursor : undefined,
    select: withoutPinned,
    enabled,
    staleTime: CODING_WORKSPACE_SMOOTHING_MS,
    refetchOnWindowFocus: false,
  })
}

/**
 * Every pinned session, most recently pinned first (one page). Kept in the
 * infinite-list shape so in-place row patches (turn state, titles) reach it.
 */
export function usePinnedSessionsQuery() {
  return useInfiniteQuery({
    queryKey: queryKeys.session.sessions.pinned(),
    queryFn: ({ signal }) => listSessions(null, 100, { pinned: true }, signal),
    initialPageParam: null as string | null,
    getNextPageParam: () => undefined,
    select: onlyPinned,
  })
}

/**
 * Pin or unpin a session. Patches ``pinned_at`` in every cached list first so
 * the row moves at once, then refetches the lists (here and, via the
 * broadcast channel, in other windows) to settle order and membership.
 */
export function useSetSessionPinnedMutation() {
  const queryClient = useQueryClient()
  const patch = (id: string, pinnedAt: string | null) => {
    queryClient.setQueriesData<SessionPages>({ queryKey: queryKeys.session.sessions.all() }, (old) => {
      if (!old || !Array.isArray(old.pages)) return old
      return {
        ...old,
        pages: old.pages.map((page) => ({
          ...page,
          data: page.data.map((session) => (session.id === id ? { ...session, pinned_at: pinnedAt } : session)),
        })),
      }
    })
  }
  return useMutation({
    mutationFn: ({ id, pinned }: { id: string; pinned: boolean }) => setSessionPinned(id, pinned),
    onMutate: async ({ id, pinned }) => {
      await queryClient.cancelQueries({ queryKey: queryKeys.session.sessions.pinned() })
      const row = findCachedSession(queryClient, id)
      const previous = row?.pinned_at ?? null
      const pinnedAt = pinned ? new Date().toISOString() : null
      patch(id, pinnedAt)
      if (pinned && row) {
        // Show it in Pinned straight away, even when that list has not
        // loaded it yet.
        queryClient.setQueryData<SessionPages>(queryKeys.session.sessions.pinned(), (old) => {
          if (!old || old.pages.some((page) => page.data.some((session) => session.id === id))) return old
          const [first, ...rest] = old.pages
          const pinnedRow = { ...row, pinned_at: pinnedAt }
          return { ...old, pages: [{ ...(first ?? { data: [], next_cursor: null, has_more: false }), data: [pinnedRow, ...(first?.data ?? [])] }, ...rest] }
        })
      }
      return { previous }
    },
    onError: (_err, { id }, context) => {
      patch(id, context?.previous ?? null)
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.session.sessions.all() })
      broadcastMessage({ type: 'cache_invalidated', events: [{ kind: 'sessions' }] })
    },
  })
}

function findCachedSession(queryClient: ReturnType<typeof useQueryClient>, id: string): SessionResponse | null {
  for (const [, data] of queryClient.getQueriesData<SessionPages>({ queryKey: queryKeys.session.sessions.all() })) {
    if (!data || !Array.isArray(data.pages)) continue
    for (const page of data.pages) {
      const row = page.data.find((session) => session.id === id)
      if (row) return row
    }
  }
  return null
}

/**
 * Every session running or waiting on the user, whatever page it sits on.
 * Kept in the infinite-list shape so the in-place row patches (turn state,
 * titles) reach it like any other session list; the global event stream
 * refetches it when a session joins or leaves. A v2 server ignores ``active``
 * and returns a normal page, so callers filter the rows they show.
 */
export function useActiveSessionsQuery() {
  return useInfiniteQuery({
    queryKey: queryKeys.session.sessions.active(),
    queryFn: ({ signal }) => listSessions(null, PAGE_SIZE, { active: true }, signal),
    initialPageParam: null as string | null,
    getNextPageParam: () => undefined,
  })
}

const SEARCH_PAGE_SIZE = 30

/**
 * Sessions whose title contains ``query``, newest first (first page only).
 * An older server ignores ``q`` and sends a normal page, so callers filter
 * the rows they show.
 */
export function useSessionSearchQuery(query: string) {
  return useInfiniteQuery({
    queryKey: queryKeys.session.sessions.search(query),
    queryFn: ({ signal }) => listSessions(null, SEARCH_PAGE_SIZE, { query }, signal),
    initialPageParam: null as string | null,
    getNextPageParam: () => undefined,
    enabled: query.length > 0,
  })
}

export function useUpdateSessionTitleMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, title }: { id: string; title: string }) => updateSessionTitle(id, title),
    onSuccess: (updated) => applySessionRename(queryClient, updated),
  })
}

export function useDeleteSessionMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (target: string | { id: string; parent_session_id?: string | null }) => {
      const id = typeof target === 'string' ? target : target.id
      const parentId = typeof target === 'string' ? null : target.parent_session_id
      await deleteSession(id)
      removeSubagent(queryClient, id, parentId)
      return { id, parentId }
    },
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
