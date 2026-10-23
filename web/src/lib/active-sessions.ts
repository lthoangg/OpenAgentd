import type { InfiniteData } from '@tanstack/react-query'
import type { SessionPageResponse, SessionResponse } from '@/api/types'

/**
 * Sessions waiting on the user, from ``useActiveSessionsQuery`` data.
 * Filtered here rather than trusted: an older server ignores ``active`` and
 * answers with a normal page of sessions.
 */
export function needsYouSessions(data: InfiniteData<SessionPageResponse> | undefined): SessionResponse[] {
  return topLevelSessions(data).filter((session) => session.needs_input === true)
}

function topLevelSessions(data: InfiniteData<SessionPageResponse> | undefined): SessionResponse[] {
  return (data?.pages.flatMap((page) => page.data) ?? []).filter(
    (session) => !session.parent_session_id && Boolean(session.workspace),
  )
}

/**
 * Whether `session` is working: its own turn, or a subagent's. A lead's turn
 * ends right after it delegates, so the lead row alone reads idle while its
 * subagents work and their reports are still to run it again. A subagent
 * waiting on its lead (`needs_input`) is not working.
 */
export function sessionWorking(session: SessionResponse): boolean {
  return session.running === true || (session.subagents ?? []).some(spending)
}

/** A turn making model calls: running, and not stopped on a question. */
function spending(session: SessionResponse): boolean {
  return session.running === true && session.needs_input !== true
}

/**
 * Whether any session, subagents included, is making model calls. A session
 * waiting on the user reports `running` too, but spends nothing. Subagents
 * come nested in their lead's row.
 */
export function sessionsSpending(data: InfiniteData<SessionPageResponse> | undefined): boolean {
  return (data?.pages ?? []).some((page) => page.data.some((s) => spending(s) || (s.subagents ?? []).some(spending)))
}
