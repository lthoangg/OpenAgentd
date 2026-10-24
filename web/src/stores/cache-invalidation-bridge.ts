import type { InfiniteData, QueryClient } from '@tanstack/react-query'
import type { CacheInvalidation } from '@/stores/useAgentStore'
import type { LiveSubagent, SessionPageResponse, SessionResponse, SubagentsResponse, WorkspaceGitDiffResponse } from '@/api/types'
import { getCodingWorkspaceGitDiff } from '@/api/client'
import { queryKeys } from '@/queries'

type BridgeQueryClient = Pick<
  QueryClient,
  'invalidateQueries' | 'getQueryData' | 'setQueryData' | 'setQueriesData'
>

export function applyCacheInvalidations(
  queryClient: BridgeQueryClient,
  events: readonly CacheInvalidation[],
): void {
  // One drain can carry a burst of tool ends from a single stream flush.
  // Invalidate each key once (a repeat cancels the refetch and sends it
  // again), and patch each workspace's diff once with every touched path:
  // two concurrent scoped patches would both merge into the same stale
  // cached diff, and the one that resolved last would drop the other's file.
  const keys = new Map<string, readonly unknown[]>()
  const invalidate = (queryKey: readonly unknown[]) => keys.set(JSON.stringify(queryKey), queryKey)
  const scopedPaths = new Map<string, string[]>()
  const wholeWorkspace = new Set<string>()
  for (const event of events) {
    switch (event.kind) {
      case 'workspace_files':
        invalidate(queryKeys.session.files(event.sessionId))
        break
      case 'coding_workspace':
        invalidate(queryKeys.coding.files(event.workspace))
        invalidate(queryKeys.coding.diff(event.workspace))
        invalidate(queryKeys.coding.status(event.workspace))
        wholeWorkspace.add(event.workspace)
        break
      case 'coding_workspace_paths': {
        invalidate(queryKeys.coding.files(event.workspace))
        invalidate(queryKeys.coding.status(event.workspace))
        const paths = scopedPaths.get(event.workspace) ?? []
        for (const path of event.paths) if (!paths.includes(path)) paths.push(path)
        scopedPaths.set(event.workspace, paths)
        break
      }
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
  for (const [workspace, paths] of scopedPaths) {
    // A whole-workspace refresh in the same batch already refetches the diff.
    if (!wholeWorkspace.has(workspace)) queuePatchDiffForPaths(queryClient, workspace, paths)
  }
}

// Scoped patches for one workspace run one at a time. Each patch reads the
// cached diff, awaits a scoped fetch, then writes a merge; two overlapping
// patches from separate drains (two agents ending tools back to back) both
// merged into the cache as it was before either wrote, and the later write
// dropped the earlier one's file.
const patchChains = new Map<string, Promise<void>>()

function queuePatchDiffForPaths(
  queryClient: BridgeQueryClient,
  workspace: string,
  paths: string[],
): void {
  const previous = patchChains.get(workspace) ?? Promise.resolve()
  const next = previous.then(() => patchDiffForPaths(queryClient, workspace, paths))
  patchChains.set(workspace, next)
  void next.finally(() => {
    if (patchChains.get(workspace) === next) patchChains.delete(workspace)
  })
}

async function patchDiffForPaths(
  queryClient: BridgeQueryClient,
  workspace: string,
  paths: string[],
): Promise<void> {
  if (paths.length === 0) return
  const key = queryKeys.coding.diff(workspace)
  const before = queryClient.getQueryData<WorkspaceGitDiffResponse>(key)

  if (!before || !before.is_git_repo) return

  let scoped: WorkspaceGitDiffResponse
  try {
    scoped = await getCodingWorkspaceGitDiff(workspace, paths)
  } catch {
    queryClient.invalidateQueries({ queryKey: key })
    return
  }

  // Merge into the cache as it is now, not as it was before the fetch: a
  // whole-diff refetch may have landed while the scoped request was out.
  queryClient.setQueryData<WorkspaceGitDiffResponse>(key, (current) => {
    if (!current || !current.is_git_repo) return current
    return {
      ...current,
      diff: mergeScopedDiff(current.diff, scoped.diff, paths),
      truncated: current.truncated || scoped.truncated,
      untracked: nextUntracked(current.untracked, scoped.untracked, paths),
    }
  })
}

const DIFF_HEADER_RE = /\ndiff --git a\/(.+?) b\/.+?(?=\ndiff --git |$)/gs
const FIRST_DIFF_HEADER_RE = /^diff --git a\/(.+?) b\/.+?(?=\ndiff --git |$)/s

export function mergeScopedDiff(
  existingDiff: string,
  scopedDiff: string,
  paths: string[],
): string {
  if (!existingDiff) return scopedDiff
  const pathSet = new Set(paths)

  const kept: string[] = []

  let cursor = 0
  const firstMatch = FIRST_DIFF_HEADER_RE.exec(existingDiff)
  if (firstMatch) {
    const path = firstMatch[1]
    if (!pathSet.has(path)) kept.push(firstMatch[0])
    cursor = firstMatch[0].length
  }

  const rest = existingDiff.slice(cursor)
  for (const match of rest.matchAll(DIFF_HEADER_RE)) {
    const path = match[1]
    if (!pathSet.has(path)) kept.push(match[0])
  }

  const keptText = kept.join('')
  const scoped = scopedDiff.startsWith('\n') ? scopedDiff : scopedDiff
  if (!keptText) return scoped
  if (!scoped) return keptText
  return scoped.startsWith('\n') || keptText.endsWith('\n')
    ? keptText + scoped
    : keptText + '\n' + scoped
}

function nextUntracked(
  cached: string[] | undefined,
  scoped: string[] | undefined,
  paths: string[],
): string[] | undefined {
  if (!cached && !scoped) return undefined
  const pathSet = new Set(paths)
  const carry = (cached ?? []).filter((p) => !pathSet.has(p))
  return [...carry, ...(scoped ?? [])]
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
