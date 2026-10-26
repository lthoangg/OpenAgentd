import type { InfiniteData, QueryClient } from '@tanstack/react-query'
import type { CacheInvalidation } from '@/stores/useAgentStore'
import type { LiveSubagent, SessionPageResponse, SessionResponse, SubagentsResponse } from '@/api/types'
import { queryKeys } from '@/queries'

type BridgeQueryClient = Pick<
  QueryClient,
  'invalidateQueries' | 'setQueryData' | 'setQueriesData'
>

export function applyCacheInvalidations(
  queryClient: BridgeQueryClient,
  events: readonly CacheInvalidation[],
): void {
  // One drain can carry a burst of tool ends from a single stream flush.
  // Invalidate each key once (a repeat cancels the refetch and sends it
  // again).
  //
  // Diffs: the changed-paths list is small and always refetched; a body is
  // cached per file (``coding.fileDiff``), so a write to known paths only
  // refreshes those files' bodies, and only the ones on screen (invalidation
  // refetches active queries alone). ``coding.diff`` is the prefix of every
  // body in the workspace.
  const keys = new Map<string, readonly unknown[]>()
  const invalidate = (queryKey: readonly unknown[]) => keys.set(JSON.stringify(queryKey), queryKey)
  for (const event of events) {
    switch (event.kind) {
      case 'workspace_files':
        invalidate(queryKeys.session.files(event.sessionId))
        break
      case 'coding_workspace':
        invalidate(queryKeys.coding.files(event.workspace))
        invalidate(queryKeys.coding.changes(event.workspace))
        invalidate(queryKeys.coding.diff(event.workspace))
        invalidate(queryKeys.coding.status(event.workspace))
        break
      case 'coding_workspace_paths':
        invalidate(queryKeys.coding.files(event.workspace))
        invalidate(queryKeys.coding.changes(event.workspace))
        invalidate(queryKeys.coding.status(event.workspace))
        for (const path of event.paths) invalidate(queryKeys.coding.fileDiff(event.workspace, path))
        break
      case 'scheduler':
        invalidate(queryKeys.scheduler.list())
        break
      case 'todos':
        invalidate(queryKeys.todos(event.sessionId))
        break
      case 'plan':
        invalidate(queryKeys.plan(event.sessionId))
        break
      case 'subagents':
        invalidate(queryKeys.session.subagents(event.sessionId))
        break
      case 'session_running':
        // Patch in place; only fall back to a refetch when the session is not
        // in any cached page yet (nothing to patch).
        if (!patchSessionRunning(queryClient, event.sessionId, event.running)) {
          invalidate(queryKeys.session.sessions.all())
        }
        break
      case 'sessions':
        invalidate(queryKeys.session.sessions.all())
        break
    }
  }
  for (const queryKey of keys.values()) queryClient.invalidateQueries({ queryKey })
}

function isInfiniteSessionData(value: unknown): value is InfiniteData<SessionPageResponse> {
  return Boolean(
    value &&
    typeof value === 'object' &&
    'pages' in value &&
    Array.isArray(value.pages),
  )
}

/**
 * Flip the turn-state flags of one session row in place.
 *
 * ``running`` and ``needs_input`` are the only turn-dependent fields on a session
 * row (the backend derives them from ``stream_store.running_session_ids()`` and
 * the open ``pending_questions`` rows), so a turn starting or finishing does not
 * need a list refetch — and must not trigger one: the list is an infinite query,
 * and TanStack refetches every loaded page **sequentially**, so flipping one
 * boolean cost N serial round trips per turn.
 *
 * ``needsInput`` defaults to ``false``: every caller other than the
 * question-asked path is reporting a turn that is running or finished, and in
 * both cases nothing is waiting on the user.
 *
 * Returns ``true`` when the session was found in a cached page, so callers can
 * fall back to invalidation for a session that is not in the list yet (e.g. one
 * a scheduled task just created).
 */
export function patchSessionRunning(
  queryClient: Pick<QueryClient, 'setQueriesData' | 'setQueryData'>,
  sessionId: string,
  running: boolean,
  needsInput: boolean = false,
): boolean {
  let found = false

  queryClient.setQueriesData<InfiniteData<SessionPageResponse>>(
    { queryKey: queryKeys.session.sessions.all() },
    (old) => {
      if (!isInfiniteSessionData(old)) return old
      let changed = false
      const pages = old.pages.map((page) => {
        let pageChanged = false
        const data = page.data.map((session) => {
          if (session.id === sessionId) {
            found = true
            if (session.running === running && (session.needs_input ?? false) === needsInput) {
              return session
            }
            pageChanged = true
            return { ...session, running, needs_input: needsInput }
          }
          if (session.subagents && session.subagents.some((sub) => sub.id === sessionId)) {
            found = true
            let subChanged = false
            const newSubagents = session.subagents.map((sub) => {
              if (sub.id !== sessionId) return sub
              if (sub.running === running && (sub.needs_input ?? false) === needsInput) {
                return sub
              }
              subChanged = true
              return { ...sub, running, needs_input: needsInput }
            })
            if (subChanged) {
              pageChanged = true
              return { ...session, subagents: newSubagents }
            }
          }
          return session
        })
        if (!pageChanged) return page
        changed = true
        return { ...page, data }
      })
      // Return the original reference when nothing moved so subscribers of an
      // already-correct list are not re-rendered.
      return changed ? { ...old, pages } : old
    },
  )

  queryClient.setQueryData<SessionResponse>(
    queryKeys.session.sessions.detail(sessionId),
    (old) =>
      old && (old.running !== running || (old.needs_input ?? false) !== needsInput)
        ? { ...old, running, needs_input: needsInput }
        : old,
  )

  return found
}

/** Session lists the server orders by ``last_message_at`` (``sort=activity``). */
function isActivitySortedList(queryKey: readonly unknown[]): boolean {
  const kind = queryKey[2]
  return (kind === 'workspace' || kind === 'checkouts' || kind === 'everywhere')
    && queryKey[queryKey.length - 1] === 'activity'
}

/**
 * A turn started or finished in ``sessionId``: the server has moved its
 * ``last_message_at`` (every saved message does). Mirror that in the cached rows and
 * move the row to the top of every activity-sorted list, so the sidebar's
 * order and age follow use. Patching ``running`` alone left a just-used
 * session in its old place, with its old age, until something refetched the
 * whole list — and refetching is what ``patchSessionRunning`` exists to avoid.
 *
 * Top-level rows only: a subagent's messages do not touch its parent.
 */
export function bumpSessionActivity(
  queryClient: Pick<QueryClient, 'setQueriesData' | 'setQueryData'>,
  sessionId: string,
  at: string = new Date().toISOString(),
): void {
  const newer = (current: string | null | undefined) =>
    !current || Date.parse(current) < Date.parse(at)

  queryClient.setQueriesData<InfiniteData<SessionPageResponse>>(
    { queryKey: queryKeys.session.sessions.all() },
    (old) => {
      if (!isInfiniteSessionData(old)) return old
      let changed = false
      const pages = old.pages.map((page) => {
        if (!page.data.some((session) => session.id === sessionId && newer(session.last_message_at))) return page
        changed = true
        return { ...page, data: page.data.map((session) => (session.id === sessionId ? { ...session, last_message_at: at } : session)) }
      })
      return changed ? { ...old, pages } : old
    },
  )

  queryClient.setQueriesData<InfiniteData<SessionPageResponse>>(
    { queryKey: queryKeys.session.sessions.all(), predicate: (query) => isActivitySortedList(query.queryKey) },
    (old) => {
      if (!isInfiniteSessionData(old) || old.pages.length === 0) return old
      if (old.pages[0].data[0]?.id === sessionId) return old
      const pageIndex = old.pages.findIndex((page) => page.data.some((session) => session.id === sessionId))
      if (pageIndex < 0) return old
      const row = old.pages[pageIndex].data.find((session) => session.id === sessionId)!
      const pages = old.pages.map((page, index) => {
        const data = index === pageIndex ? page.data.filter((session) => session.id !== sessionId) : page.data
        return index === 0 ? { ...page, data: [row, ...data] } : index === pageIndex ? { ...page, data } : page
      })
      return { ...old, pages }
    },
  )

  queryClient.setQueryData<SessionResponse>(
    queryKeys.session.sessions.detail(sessionId),
    (old) => (old && newer(old.last_message_at) ? { ...old, last_message_at: at } : old),
  )
}

export function patchSessionTitle(
  queryClient: Pick<QueryClient, 'setQueriesData' | 'setQueryData'>,
  sessionId: string,
  title: string,
): void {
  queryClient.setQueryData<SessionResponse>(
    queryKeys.session.sessions.detail(sessionId),
    (old) => old ? { ...old, title } : old,
  )
  queryClient.setQueriesData<InfiniteData<SessionPageResponse>>(
    { queryKey: queryKeys.session.sessions.all() },
    (old) => {
      if (!isInfiniteSessionData(old)) return old
      return {
        ...old,
        pages: old.pages.map((page) => ({
          ...page,
          data: page.data.map((s) => s.id === sessionId ? { ...s, title } : s),
        })),
      }
    },
  )
}

/**
 * A session's live goal changed (``session_goal``): set ``goal_status`` on
 * its cached rows so the sidebar dot follows without a list refetch.
 * ``null`` means no live goal.
 */
export function patchSessionGoalStatus(
  queryClient: Pick<QueryClient, 'setQueriesData' | 'setQueryData'>,
  sessionId: string,
  status: 'active' | 'paused' | null,
): void {
  const same = (current: SessionResponse['goal_status']) => (current ?? null) === status
  queryClient.setQueryData<SessionResponse>(
    queryKeys.session.sessions.detail(sessionId),
    (old) => (old && !same(old.goal_status) ? { ...old, goal_status: status } : old),
  )
  queryClient.setQueriesData<InfiniteData<SessionPageResponse>>(
    { queryKey: queryKeys.session.sessions.all() },
    (old) => {
      if (!isInfiniteSessionData(old)) return old
      let changed = false
      const pages = old.pages.map((page) => {
        if (!page.data.some((s) => s.id === sessionId && !same(s.goal_status))) return page
        changed = true
        return { ...page, data: page.data.map((s) => (s.id === sessionId ? { ...s, goal_status: status } : s)) }
      })
      return changed ? { ...old, pages } : old
    },
  )
}

function prependSessionToInfiniteData(
  old: InfiniteData<SessionPageResponse> | undefined,
  session: SessionResponse,
): InfiniteData<SessionPageResponse> | undefined {
  if (!isInfiniteSessionData(old)) return old
  if (old.pages.some((page) => page.data.some((item) => item.id === session.id))) return old
  const [first, ...rest] = old.pages
  if (!first) return old
  return {
    ...old,
    pages: [
      {
        ...first,
        data: [session, ...first.data],
      },
      ...rest,
    ],
  }
}

export function prependSession(
  queryClient: Pick<QueryClient, 'setQueryData'>,
  session: SessionResponse,
): void {
  queryClient.setQueryData<InfiniteData<SessionPageResponse>>(
    queryKeys.session.sessions.infinite(),
    (old) => prependSessionToInfiniteData(old, session),
  )
}

export function prependWorkspaceSession(
  queryClient: Pick<QueryClient, 'setQueryData' | 'setQueriesData'>,
  workspace: string,
  session: SessionResponse,
): void {
  // Prefix match: one cache per sort order of the same workspace.
  queryClient.setQueriesData<InfiniteData<SessionPageResponse>>(
    { queryKey: queryKeys.session.sessions.workspace(workspace) },
    (old) => prependSessionToInfiniteData(old, session),
  )
  // A repository's sidebar list also spans its worktrees.
  queryClient.setQueriesData<InfiniteData<SessionPageResponse>>(
    {
      queryKey: queryKeys.session.sessions.checkoutsAll(),
      predicate: (query) => {
        const paths = query.queryKey[3]
        return Array.isArray(paths) && paths.includes(workspace)
      },
    },
    (old) => prependSessionToInfiniteData(old, session),
  )
}

export function appendSubagent(
  queryClient: Pick<QueryClient, 'setQueriesData' | 'setQueryData'>,
  leadSessionId: string,
  subagent: {
    id: string
    title: string
    agent_name?: string | null
    workspace?: string | null
    running?: boolean
    needs_input?: boolean
    created_at?: string | null
  },
): void {
  const childSession: SessionResponse = {
    id: subagent.id,
    parent_session_id: leadSessionId,
    title: subagent.title,
    workspace: subagent.workspace ?? '',
    interaction_mode: 'code',
    running: subagent.running ?? true,
    needs_input: subagent.needs_input ?? false,
    created_at: subagent.created_at ?? new Date().toISOString(),
    agent_name: subagent.agent_name ?? null,
    updated_at: null,
  }

  queryClient.setQueriesData<InfiniteData<SessionPageResponse>>(
    { queryKey: queryKeys.session.sessions.all() },
    (old) => {
      if (!isInfiniteSessionData(old)) return old
      let changed = false
      const pages = old.pages.map((page) => {
        let pageChanged = false
        const data = page.data.map((session) => {
          if (session.id !== leadSessionId) return session
          const existing = session.subagents ?? []
          if (existing.some((s) => s.id === childSession.id)) return session
          pageChanged = true
          return {
            ...session,
            subagents: [...existing, childSession],
          }
        })
        if (!pageChanged) return page
        changed = true
        return { ...page, data }
      })
      return changed ? { ...old, pages } : old
    },
  )

  queryClient.setQueryData<SubagentsResponse>(
    queryKeys.session.subagents(leadSessionId),
    (old) => {
      if (!old) return old
      const existing = old.live_members ?? old.subagents ?? []
      if (existing.some((m) => m.session_id === childSession.id)) return old
      const newMember: LiveSubagent = {
        member_id: childSession.agent_name || childSession.id,
        profile: childSession.agent_name?.split('#')[0] || 'member',
        title: childSession.title ?? undefined,
        status: childSession.running ? 'working' : 'completed',
        session_id: childSession.id,
        created_at: childSession.created_at ?? undefined,
        last_error: undefined,
        has_pending_question: childSession.needs_input === true,
      }
      return {
        ...old,
        live_members: [...existing, newMember],
      }
    },
  )
}

export function removeSubagent(
  queryClient: Pick<QueryClient, 'setQueriesData' | 'setQueryData'>,
  childSessionId: string,
  parentSessionId?: string | null,
): void {
  queryClient.setQueriesData<InfiniteData<SessionPageResponse>>(
    { queryKey: queryKeys.session.sessions.all() },
    (old) => {
      if (!isInfiniteSessionData(old)) return old
      let changed = false
      const pages = old.pages.map((page) => {
        let pageChanged = false
        const data = page.data.map((session) => {
          if (parentSessionId && session.id !== parentSessionId) return session
          const existing = session.subagents ?? []
          if (!existing.some((s) => s.id === childSessionId)) return session
          pageChanged = true
          return {
            ...session,
            subagents: existing.filter((s) => s.id !== childSessionId),
          }
        })
        if (!pageChanged) return page
        changed = true
        return { ...page, data }
      })
      return changed ? { ...old, pages } : old
    },
  )

  if (parentSessionId) {
    queryClient.setQueryData<SubagentsResponse>(
      queryKeys.session.subagents(parentSessionId),
      (old) => {
        if (!old) return old
        const existingLive = old.live_members ?? []
        const existingSub = old.subagents ?? []
        const newLive = existingLive.filter((m) => m.session_id !== childSessionId)
        const newSub = existingSub.filter((m) => m.session_id !== childSessionId)
        return {
          ...old,
          live_members: newLive,
          subagents: newSub,
        }
      },
    )
  }
}
