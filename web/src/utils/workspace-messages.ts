/**
 * Cross-workspace messages (`send_to_workspace`). A request lands in the
 * target session as a user row with ``extra.sent_from``; the answer comes
 * back to the sender as an agent report with ``extra.reply_from``.
 */

export interface SentFrom {
  sessionId: string
  workspace: string
  workspaceName: string
  sessionTitle: string | null
  reply: boolean
}

export interface ReplyFrom {
  sessionId: string
  workspace: string
  workspaceName: string
  status: 'completed' | 'error' | 'stopped'
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** Who sent a user row from another workspace, if anyone. */
export function sentFrom(extra: unknown): SentFrom | null {
  const raw = record(record(extra)?.sent_from)
  const sessionId = text(raw?.session_id)
  if (!raw || !sessionId) return null
  const workspace = text(raw.workspace)
  return {
    sessionId,
    workspace,
    workspaceName: text(raw.workspace_name) || workspace.split(/[\\/]/).filter(Boolean).pop() || 'another workspace',
    sessionTitle: text(raw.session_title) || null,
    reply: raw.reply === true,
  }
}

/** The session a report answers from another workspace, if it is one. */
export function replyFrom(extra: unknown): ReplyFrom | null {
  const raw = record(record(extra)?.reply_from)
  const sessionId = text(raw?.session_id)
  if (!raw || !sessionId) return null
  const status = raw.status === 'error' || raw.status === 'stopped' ? raw.status : 'completed'
  const workspace = text(raw.workspace)
  return {
    sessionId,
    workspace,
    workspaceName: text(raw.workspace_name) || workspace.split(/[\\/]/).filter(Boolean).pop() || 'another workspace',
    status,
  }
}

/** The label above a reply report. */
export function replyLabel(reply: ReplyFrom): string {
  if (reply.status === 'error') return 'Workspace update · failed'
  if (reply.status === 'stopped') return 'Workspace update · stopped'
  return 'Workspace reply'
}

export interface SentSession {
  workspaceName: string
  workspace: string
  sessionId: string
}

/**
 * Matches the ``send_to_workspace`` success text (``tools/send_to_workspace.rs``):
 * ``Sent to '<name>' (<path>) — new session <id> started.`` and its
 * delivered / queued variants. Errors start with ``Error:`` and do not match.
 */
const SENT_RE = /^Sent to '(.+?)' \((.+)\) — (?:new session|delivered to session|queued in busy session) ([0-9a-fA-F-]{36})\b/

/** The session a successful ``send_to_workspace`` call reached, if any. */
export function parseSendResult(result: string | undefined | null): SentSession | null {
  const m = result ? SENT_RE.exec(result.trim()) : null
  return m ? { workspaceName: m[1], workspace: m[2], sessionId: m[3] } : null
}

/** Window event the chat view handles by switching to a session in any workspace. */
export const OPEN_SESSION_EVENT = 'oa:open-session'

export interface OpenSessionRequest {
  sessionId: string
  workspace: string
}

export function requestOpenSession(request: OpenSessionRequest): void {
  window.dispatchEvent(new CustomEvent<OpenSessionRequest>(OPEN_SESSION_EVENT, { detail: request }))
}

export function isOpenSessionRequest(value: unknown): value is OpenSessionRequest {
  const v = record(value)
  return Boolean(v && typeof v.sessionId === 'string' && v.sessionId && typeof v.workspace === 'string')
}
