/**
 * The lead agent's messages in a subagent's transcript. The lead writes them
 * as plain user rows prefixed ``[Task from Lead]: `` (the first task) or
 * ``[Lead]: `` (follow-ups). The backend tags newer rows with
 * ``extra.from_lead = { session_id }``; older rows carry only the prefix, and
 * only a subagent session (one with a parent) can tell them from a user's own
 * text.
 */

const LEAD_PREFIX_RE = /^\[(?:Task from Lead|Lead)\]: /

export interface FromLead {
  /** The lead's session: where the "From lead" chip goes. */
  sessionId: string
  /** The message without the ``[Lead]: `` prefix. */
  content: string
}

function tagSessionId(extra: unknown): string {
  if (!extra || typeof extra !== 'object' || Array.isArray(extra)) return ''
  const raw = (extra as Record<string, unknown>).from_lead
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return ''
  const id = (raw as Record<string, unknown>).session_id
  return typeof id === 'string' ? id : ''
}

/**
 * Whether a user row is the lead's message, and where the lead is.
 * ``parentSessionId`` is the open session's parent: it names the lead for an
 * untagged (older) row, which counts only while that is set.
 */
export function fromLead(extra: unknown, content: string, parentSessionId?: string | null): FromLead | null {
  const tagged = tagSessionId(extra)
  const prefixed = LEAD_PREFIX_RE.test(content)
  const sessionId = tagged || (prefixed && parentSessionId ? parentSessionId : '')
  if (!sessionId) return null
  return { sessionId, content: prefixed ? content.replace(LEAD_PREFIX_RE, '') : content }
}

/** Whether the block is a user row the lead sent (see {@link fromLead}). */
export function isLeadMessage(block: { type: string; content: string; extra?: unknown }, parentSessionId?: string | null): boolean {
  return block.type === 'user' && fromLead(block.extra, block.content, parentSessionId) !== null
}
