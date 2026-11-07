import type { SessionPageResponse } from '@/api/types'

/** Rows per page of the every-workspace session lists. */
export const SESSION_PAGE_SIZE = 20
/** Rows per page of one workspace's sidebar list. */
export const WORKSPACE_SESSION_PAGE_SIZE = 5

/**
 * How many sessions the next page adds: a page, or fewer when the server
 * counted less past the last one. Null when it sent no count (older server).
 */
export function nextPageCount(data: { pages: SessionPageResponse[] } | undefined, pageSize: number): number | null {
  const remaining = data?.pages.at(-1)?.remaining
  return typeof remaining === 'number' && remaining > 0 ? Math.min(remaining, pageSize) : null
}
