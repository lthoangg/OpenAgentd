import type { InfiniteData, QueryClient } from '@tanstack/react-query'
import type { CacheInvalidation } from '@/stores/useTeamStore'
import type { SessionPageResponse, SessionResponse, WorkspaceGitDiffResponse } from '@/api/types'
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
  for (const event of events) {
    switch (event.kind) {
      case 'workspace_files':
        queryClient.invalidateQueries({ queryKey: queryKeys.team.files(event.sessionId) })
        break
      case 'coding_workspace':
        queryClient.invalidateQueries({ queryKey: queryKeys.coding.files(event.workspace) })
        queryClient.invalidateQueries({ queryKey: queryKeys.coding.diff(event.workspace) })
        queryClient.invalidateQueries({ queryKey: queryKeys.coding.status(event.workspace) })
        break
      case 'coding_workspace_paths':
        queryClient.invalidateQueries({
          queryKey: queryKeys.coding.files(event.workspace),
        })
        queryClient.invalidateQueries({
          queryKey: queryKeys.coding.status(event.workspace),
        })
        void patchCodingDiffForPaths(queryClient, event.workspace, event.paths)
        break
      case 'scheduler':
        queryClient.invalidateQueries({ queryKey: queryKeys.scheduler.list() })
        break
      case 'todos':
        queryClient.invalidateQueries({ queryKey: queryKeys.todos(event.sessionId) })
        break
      case 'team_agents':
        queryClient.invalidateQueries({ queryKey: queryKeys.teamAgents() })
        break
      case 'team_sessions':
        queryClient.invalidateQueries({ queryKey: queryKeys.team.sessions.all() })
        break
      case 'session_running':
        // Patch in place; only fall back to a refetch when the session is not
        // in any cached page yet (nothing to patch).
        if (!patchSessionRunning(queryClient, event.sessionId, event.running)) {
          queryClient.invalidateQueries({ queryKey: queryKeys.team.sessions.all() })
        }
        break
    }
  }
}

async function patchCodingDiffForPaths(
  queryClient: BridgeQueryClient,
  workspace: string,
  paths: string[],
): Promise<void> {
  if (paths.length === 0) return
  const key = queryKeys.coding.diff(workspace)
  const cached = queryClient.getQueryData<WorkspaceGitDiffResponse>(key)

  if (!cached || !cached.is_git_repo) return

  let scoped: WorkspaceGitDiffResponse
  try {
    scoped = await getCodingWorkspaceGitDiff(workspace, paths)
  } catch {
    queryClient.invalidateQueries({ queryKey: key })
    return
  }

  const merged = mergeScopedDiff(cached.diff, scoped.diff, paths)
  queryClient.setQueryData<WorkspaceGitDiffResponse>(key, {
    ...cached,
    diff: merged,
    truncated: cached.truncated || scoped.truncated,
    untracked: nextUntracked(cached.untracked, scoped.untracked, paths),
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
 * Flip the ``running`` flag of one session row in place.
 *
 * ``running`` is the *only* turn-dependent field on a session row (the backend
 * derives it from ``stream_store.running_session_ids()``), so a turn starting or
 * finishing does not need a list refetch — and must not trigger one: the list is
 * an infinite query, and TanStack refetches every loaded page **sequentially**,
 * so flipping one boolean cost N serial round trips per turn.
 *
 * Returns ``true`` when the session was found in a cached page, so callers can
 * fall back to invalidation for a session that is not in the list yet (e.g. one
 * a scheduled task just created).
 */
export function patchSessionRunning(
  queryClient: Pick<QueryClient, 'setQueriesData' | 'setQueryData'>,
  sessionId: string,
  running: boolean,
): boolean {
  let found = false

  queryClient.setQueriesData<InfiniteData<SessionPageResponse>>(
    { queryKey: queryKeys.team.sessions.all() },
    (old) => {
      if (!isInfiniteSessionData(old)) return old
      let changed = false
      const pages = old.pages.map((page) => {
        let pageChanged = false
        const data = page.data.map((session) => {
          if (session.id !== sessionId) return session
          found = true
          if (session.running === running) return session
          pageChanged = true
          return { ...session, running }
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
    queryKeys.team.sessions.detail(sessionId),
    (old) => (old && old.running !== running ? { ...old, running } : old),
  )

  return found
}

export function patchSessionTitle(
  queryClient: Pick<QueryClient, 'setQueriesData' | 'setQueryData'>,
  sessionId: string,
  title: string,
): void {
  queryClient.setQueryData<SessionResponse>(
    queryKeys.team.sessions.detail(sessionId),
    (old) => old ? { ...old, title } : old,
  )
  queryClient.setQueriesData<InfiniteData<SessionPageResponse>>(
    { queryKey: queryKeys.team.sessions.all() },
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
    queryKeys.team.sessions.infinite(),
    (old) => prependSessionToInfiniteData(old, session),
  )
}

export function prependWorkspaceSession(
  queryClient: Pick<QueryClient, 'setQueryData'>,
  workspace: string,
  session: SessionResponse,
): void {
  queryClient.setQueryData<InfiniteData<SessionPageResponse>>(
    queryKeys.team.sessions.workspace(workspace),
    (old) => prependSessionToInfiniteData(old, session),
  )
}
