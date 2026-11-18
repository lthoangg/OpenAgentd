// Per-session stream and /btw side-question events.

/**
 * Events on the per-session stream (`/agent/{sid}/stream`). Must match
 * `session_stream` in `appv3/crates/agent/data/sse_events.json` (enforced by
 * `sse-contract.test.ts`); global-feed events live in `global-events.ts`.
 */
export const SSE_EVENT_TYPES = [
  'session',
  'thinking',
  'message',
  'tool_call',
  'tool_start',
  'tool_output_delta',
  'tool_end',
  'nested_tool_end',
  'usage',
  'done',
  'error',
  'rate_limit',
  'provider_status',
  'agent_status',
  'agent_not_configured',
  'interaction_mode',
  'queued_turn_start',
  'question_asked',
  'question_answered',
  'question_dismissed',
  'summarization_start',
  'summarization_content',
  'summarization_end',
  'subagent_spawned',
  'subagent_status',
] as const

export type SSEEventType = (typeof SSE_EVENT_TYPES)[number]

export interface SSEEvent {
  type: SSEEventType
  [key: string]: unknown
}

/**
 * Events of a `POST /agent/sessions/{sid}/btw` response. Must match
 * `side_question_stream` in `appv3/crates/agent/data/sse_events.json` (enforced by
 * `sse-contract.test.ts`).
 */
export const SIDE_QUESTION_EVENT_TYPES = ['btw_start', 'btw_delta', 'btw_done', 'btw_error'] as const

export type SideQuestionEventType = (typeof SIDE_QUESTION_EVENT_TYPES)[number]

export type SideQuestionStatus = 'streaming' | 'done' | 'error' | 'stopped'

/** A stored side question: kept beside its session, never in its history. */
export interface SideQuestion {
  id: string
  session_id: string
  question: string
  answer: string
  status: SideQuestionStatus
  error: string | null
  model: string | null
  usage: Record<string, unknown> | null
  created_at: string
  updated_at: string
}

export interface SideQuestionListResponse {
  /** Newest side questions of the session, oldest first. */
  items: SideQuestion[]
  total: number
}

/** `btw_start` (also sent again when a retry restarts the answer). */
export interface SideQuestionStartEvent { type: 'btw_start'; id: string; question: string }
export interface SideQuestionDeltaEvent { type: 'btw_delta'; id: string; text: string }
export interface SideQuestionDoneEvent {
  type: 'btw_done'
  id: string
  answer: string
  model: string | null
  usage: Record<string, unknown> | null
}
/** Error or stop; `answer` holds what was written before it ended. */
export interface SideQuestionErrorEvent {
  type: 'btw_error'
  id: string
  status: 'error' | 'stopped'
  message: string
  answer: string
}

export type SideQuestionEvent =
  | SideQuestionStartEvent
  | SideQuestionDeltaEvent
  | SideQuestionDoneEvent
  | SideQuestionErrorEvent
