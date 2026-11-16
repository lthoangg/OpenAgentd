/**
 * Tell the server the person sees a session (`POST /agent/{id}/seen`), so
 * its notification does not also ring the phone a minute later
 * (`appv3/crates/api/src/cloud/letters.rs`). Best effort: a server before
 * v3.58.0 answers 404, and a failure only means the phone rings as before.
 */
import { apiBaseUrl } from '../base-url'

/** At most one report per session in this window; the server's wait is 60 s. */
export const SEEN_REPORT_GAP_MS = 10_000
const lastReport = new Map<string, number>()

export function reportSessionSeen(sessionId: string): void {
  const key = `${apiBaseUrl()}|${sessionId}`
  const now = Date.now()
  const last = lastReport.get(key)
  if (last !== undefined && now - last < SEEN_REPORT_GAP_MS) return
  lastReport.set(key, now)
  if (lastReport.size > 200) lastReport.delete(lastReport.keys().next().value as string)
  void fetch(`${apiBaseUrl()}/agent/${encodeURIComponent(sessionId)}/seen`, { method: 'POST' }).catch(() => undefined)
}

/** Whether the page is where the person looks: on screen and in the focused window. */
export function pageHasAttention(): boolean {
  return document.visibilityState === 'visible' && document.hasFocus()
}

/** Test seam. */
export function resetSessionSeenReports(): void {
  lastReport.clear()
}
