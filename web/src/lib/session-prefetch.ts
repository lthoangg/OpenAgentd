/**
 * A session's first history page, fetched ahead of its open (a sidebar row's
 * hover intent, see `session-prefetch-row.ts`; the route entering a session,
 * see `session-prefetch-route.ts`), so the open lands without waiting on the
 * network. The store imports this; keep it free of queries.
 *
 * Only the next fresh open of that session takes the response, and only
 * while it is recent: older, it is dropped and the open fetches as usual.
 * A response still on its way counts as recent: the open would only ask for
 * the same page again and wait longer, which matters most on a slow link.
 * A turn starting or finishing in the session drops it too, since the page
 * no longer matches the server.
 */
import { sessionHistory } from '@/api/client'
import type { SessionHistoryResponse } from '@/api/types'

/** How long a prefetched page stays usable after it arrived. */
export const PREFETCH_TTL_MS = 3000
/**
 * How long a prefetch may stay out before an open stops waiting for it. A
 * request the webview froze (a phone in the background) never answers; past
 * this the open asks again on a connection that works.
 */
export const PREFETCH_IN_FLIGHT_MAX_MS = 15_000

export interface PrefetchedHistory {
  startedAt: number
  /** When the page arrived; unset while it is on its way. */
  arrivedAt?: number
  promise: Promise<SessionHistoryResponse>
}

const prefetched = new Map<string, PrefetchedHistory>()

function usable(entry: PrefetchedHistory): boolean {
  const now = Date.now()
  return entry.arrivedAt === undefined ? now - entry.startedAt <= PREFETCH_IN_FLIGHT_MAX_MS : now - entry.arrivedAt <= PREFETCH_TTL_MS
}

export function prefetchSessionHistory(sessionId: string): void {
  const existing = prefetched.get(sessionId)
  if (existing && usable(existing)) return
  const entry: PrefetchedHistory = { startedAt: Date.now(), promise: sessionHistory(sessionId) }
  prefetched.set(sessionId, entry)
  entry.promise.then(
    () => { entry.arrivedAt = Date.now() },
    // A failed prefetch is forgotten; the open then fetches on its own.
    () => { if (prefetched.get(sessionId) === entry) prefetched.delete(sessionId) },
  )
}

/** The prefetched first page for a fresh open, if one is recent enough. Taken once. */
export function takePrefetchedHistory(sessionId: string): PrefetchedHistory | null {
  const entry = prefetched.get(sessionId)
  prefetched.delete(sessionId)
  return entry && usable(entry) ? entry : null
}

export function forgetPrefetchedHistory(sessionId: string): void {
  prefetched.delete(sessionId)
}

export function _resetSessionPrefetchForTests(): void {
  prefetched.clear()
}
