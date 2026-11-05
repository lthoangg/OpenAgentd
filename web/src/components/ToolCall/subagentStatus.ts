/**
 * How a subagent's state reads in a team tool result: a word first (Running,
 * Done, Failed, Needs you), a tone second. The raw states come from the
 * tool result (``spawned``, ``completed``…) and from the live roster
 * (``working``, ``waiting_lead``, ``error``…); both map here.
 */
import type { ChipTone } from '@/components/ui/chip'

export interface SubagentStatusView {
  label: string
  tone: ChipTone
  /** Still going: the chip carries a live dot and the row an elapsed timer. */
  running: boolean
  /** Waiting on an answer: the dot shows, but no clock runs. */
  waiting: boolean
}

const RUNNING: SubagentStatusView = { label: 'Running', tone: 'info', running: true, waiting: false }
const DONE: SubagentStatusView = { label: 'Done', tone: 'success', running: false, waiting: false }
const FAILED: SubagentStatusView = { label: 'Failed', tone: 'error', running: false, waiting: false }
const NEEDS_YOU: SubagentStatusView = { label: 'Needs you', tone: 'warning', running: false, waiting: true }
const STOPPED: SubagentStatusView = { label: 'Stopped', tone: 'neutral', running: false, waiting: false }

const BY_STATE: Record<string, SubagentStatusView> = {
  working: RUNNING,
  running: RUNNING,
  spawned: RUNNING,
  completed: DONE,
  done: DONE,
  error: FAILED,
  failed: FAILED,
  waiting_lead: NEEDS_YOU,
  waiting_input: NEEDS_YOU,
  stopped: STOPPED,
  idle: { label: 'Idle', tone: 'neutral', running: false, waiting: false },
  sent: { label: 'Sent', tone: 'neutral', running: false, waiting: false },
}

/**
 * The view for a raw state, or ``null`` when there is none to show. A member
 * with an open question needs an answer whatever its state says; an unknown
 * state keeps its own word.
 */
export function subagentStatusView(status: string | null | undefined, hasPendingQuestion = false): SubagentStatusView | null {
  if (hasPendingQuestion) return NEEDS_YOU
  const state = status?.trim()
  if (!state) return null
  return BY_STATE[state] ?? { label: state, tone: 'neutral', running: false, waiting: false }
}

/** ``mm:ss`` (``h:mm:ss`` past the hour) for a live elapsed timer. */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor((Number.isFinite(ms) ? ms : 0) / 1000))
  const seconds = total % 60
  const minutes = Math.floor(total / 60) % 60
  const hours = Math.floor(total / 3600)
  const ss = String(seconds).padStart(2, '0')
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, '0')}:${ss}`
  return `${String(minutes).padStart(2, '0')}:${ss}`
}

/** An ISO timestamp from the API as epoch ms, or ``null`` when it is not one. */
export function parseStartedAt(value: unknown): number | null {
  if (typeof value !== 'string' || !value) return null
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : null
}

/**
 * The subagent a ``team`` call reached, read from the plain text the backend
 * answers with (``Subagent 'explorer#1' dispatched…``, ``Message delivered to
 * subagent 'explorer#1'…``; ``appv3_agent::tools::team::delegate_result_text``).
 * ``null`` for an error, a list, or a JSON result, whose details carry their
 * own rows. Only answers this matches reach the client with the call
 * (``appv3_db::api::result_rides_inline``): change both together.
 */
export function teamMemberFromResult(result: string | null | undefined): string | null {
  const text = result?.trim()
  if (!text || text.startsWith('{') || text.startsWith('[') || /^error\b/i.test(text)) return null
  const match = /\bsubagent '([^'\n]+)'/i.exec(text.split('\n', 1)[0])
  return match ? match[1] : null
}
