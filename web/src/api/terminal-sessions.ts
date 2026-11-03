/**
 * Terminal session endpoints (protocol v2 servers).
 *
 *   GET    /api/terminal/sessions?workspace=<abs path>  — shells the server still holds
 *   DELETE /api/terminal/sessions/{session_id}          — explicit kill
 *
 * With protocol v2 a closed socket only *detaches* from its shell, so the
 * client lists survivors after a reload (restore) and kills explicitly when
 * the user closes a tab. Kept apart from the socket client so callers that
 * only mock the socket do not need to know about these.
 */

import { apiUrl } from './base-url'

export interface TerminalSessionInfo {
  session_id: string
  workspace: string
  created_at: number | string
  /** Another client currently holds the shell. */
  attached: boolean
  busy: boolean
}

/**
 * The workspace's live shells, oldest first. An old server has no such route
 * (404/405) and yields an empty list; other failures throw so callers can retry.
 */
export async function listTerminalSessions(workspace: string): Promise<TerminalSessionInfo[]> {
  const res = await fetch(apiUrl(`/terminal/sessions?workspace=${encodeURIComponent(workspace)}`))
  if (res.status === 404 || res.status === 405) return []
  if (!res.ok) throw new Error(`Terminal session list failed (${res.status})`)
  const body = (await res.json()) as { sessions?: unknown }
  if (!Array.isArray(body.sessions)) return []
  const sessions = (body.sessions as Partial<TerminalSessionInfo>[]).filter(
    (s): s is TerminalSessionInfo => typeof s?.session_id === 'string',
  )
  return sessions.sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0))
}

/** Kill a shell. A shell that is already gone (404) counts as success. */
export async function deleteTerminalSession(sessionId: string): Promise<void> {
  const res = await fetch(apiUrl(`/terminal/sessions/${encodeURIComponent(sessionId)}`), {
    method: 'DELETE',
  })
  if (!res.ok && res.status !== 404) throw new Error(`Terminal session delete failed (${res.status})`)
}
