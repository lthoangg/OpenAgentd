/**
 * A session's first history page, fetched ahead of a switch (a sidebar row's
 * hover intent, see `session-prefetch-row.ts`), so the switch lands without
 * waiting on the network. The store imports this; keep it free of queries.
 *
 * Only the next fresh open of that session takes the response, and only
 * while it is recent: older, it is dropped and the open fetches as usual.
 * A turn starting or finishing in the session drops it too, since the page
 * no longer matches the server.
 */
import { sessionHistory } from '@/api/client'
import type { SessionHistoryResponse } from '@/api/types'

/** How long a prefetched page stays usable. */
export const PREFETCH_TTL_MS = 3000

export interface PrefetchedHistory {
  startedAt: number
  promise: Promise<SessionHistoryResponse>
}

const prefetched = new Map<string, PrefetchedHistory>()

export function prefetchSessionHistory(sessionId: string): void {
  const existing = prefetched.get(sessionId)
  if (!existing || Date.now() - existing.startedAt > PREFETCH_TTL_MS) {
    const entry: PrefetchedHistory = { startedAt: Date.now(), promise: sessionHistory(sessionId) }
    prefetched.set(sessionId, entry)
    // A failed prefetch is forgotten; the open then fetches on its own.
    entry.promise.catch(() => {
      if (prefetched.get(sessionId) === entry) prefetched.delete(sessionId)
    })
  }
}

/** The prefetched first page for a fresh open, if one is recent enough. Taken once. */
export function takePrefetchedHistory(sessionId: string): PrefetchedHistory | null {
  const entry = prefetched.get(sessionId)
  prefetched.delete(sessionId)
  if (!entry || Date.now() - entry.startedAt > PREFETCH_TTL_MS) return null
  return entry
}

export function forgetPrefetchedHistory(sessionId: string): void {
  prefetched.delete(sessionId)
}

export function _resetSessionPrefetchForTests(): void {
  prefetched.clear()
}
