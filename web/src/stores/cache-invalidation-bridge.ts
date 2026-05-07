/**
 * Cache-invalidation bridge.
 *
 * The team store's SSE reducer enqueues domain events on its
 * ``cacheInvalidations`` queue rather than calling
 * ``queryClient.invalidateQueries`` directly — that keeps the store
 * free of TanStack imports and decouples streaming logic from the
 * cache layer.
 *
 * This module owns the small mapping from those domain events to
 * concrete TanStack invalidation calls.  ``routes/team.tsx`` wires a
 * Zustand subscriber that drains the queue on change and hands the
 * events to ``applyCacheInvalidations``.
 *
 * Kept as a pure function (no React, no hooks) so it can be unit
 * tested with a mock ``QueryClient`` and so the React component
 * stays a thin glue layer.
 */
import type { InfiniteData, QueryClient } from '@tanstack/react-query'
import type { CacheInvalidation } from '@/stores/useTeamStore'
import type { SessionPageResponse } from '@/api/types'
import { queryKeys } from '@/queries'

/**
 * Translate domain cache-invalidation events into TanStack
 * ``invalidateQueries`` calls.  One ``invalidateQueries`` call per
 * event — TanStack's invalidation is idempotent, so duplicate events
 * (e.g. two ``schedule_task`` calls in the same turn) are cheap.
 *
 * Unknown ``event.kind`` values are a TypeScript error at compile
 * time; the exhaustive switch ensures every variant of
 * ``CacheInvalidation`` has an explicit branch.
 */
export function applyCacheInvalidations(
  queryClient: Pick<QueryClient, 'invalidateQueries'>,
  events: readonly CacheInvalidation[],
): void {
  for (const event of events) {
    switch (event.kind) {
      case 'wiki':
        queryClient.invalidateQueries({ queryKey: queryKeys.wiki.all() })
        break
      case 'workspace_files':
        queryClient.invalidateQueries({ queryKey: queryKeys.team.files(event.sessionId) })
        break
      case 'scheduler':
        queryClient.invalidateQueries({ queryKey: queryKeys.scheduler.list() })
        break
      case 'todos':
        queryClient.invalidateQueries({ queryKey: queryKeys.todos(event.sessionId) })
        break
    }
  }
}

/**
 * Patch the cached team session list when a ``title_update`` SSE event
 * arrives.  The list is an infinite query, so cached data is shaped as
 * ``InfiniteData<SessionPageResponse>`` (``{ pages, pageParams }``) — we
 * map each page's ``data`` array, not the wrapper.  An earlier version
 * typed the cache as ``SessionResponse[]`` and silently no-op'd; the
 * sidebar only refreshed on reload.
 *
 * No-ops when the matching session id is absent from every page (e.g.
 * cache was cleared between the SSE event and this patch) — TanStack
 * skips updates whose updater returns the same reference.
 */
export function patchSessionTitle(
  queryClient: Pick<QueryClient, 'setQueriesData'>,
  sessionId: string,
  title: string,
): void {
  queryClient.setQueriesData<InfiniteData<SessionPageResponse>>(
    { queryKey: queryKeys.team.sessions.all() },
    (old) => old && {
      ...old,
      pages: old.pages.map((page) => ({
        ...page,
        data: page.data.map((s) => s.id === sessionId ? { ...s, title } : s),
      })),
    },
  )
}
