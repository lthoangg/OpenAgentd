// Sessions, messages, history pages, transcript blocks, todos, plans and goals.
import type { PendingQuestionResponse } from '../question-types'

/** ``DELETE /sessions/{id}?remove_worktree=true``: what became of its worktree. */
export interface SessionDeleteResponse {
  deleted: boolean
  /** ``null`` when the session was not alone in an OpenAgentd worktree. */
  worktree: { name: string; removed: boolean; reason?: string } | null
}

export interface MessageAttachment {
  filename?: string
  media_type?: string
  original_name?: string
  category?: 'text' | 'image' | 'document'
  url?: string        // /api/chat/files/{session_id}/{filename} or blob URL for optimistic
  source?: 'upload' | 'mention' | string
}

export interface MessageResponse {
  id: string
  role: string
  content: string | null
  reasoning_content: string | null
  // Backend returns raw dicts; cast to ToolCall shape for UI convenience.
  /**
   * ``arguments_bytes`` is set when history sent the call's arguments short
   * (``appv3_db::tool_args``): the full arguments' size.
   */
  tool_calls: Array<Partial<ToolCall> & { id: string; function?: Partial<ToolCall['function']>; arguments_bytes?: number }> | null
  tool_call_id: string | null
  name: string | null
  /** Canonical ordering key within a session — sort by (seq, id), not created_at. */
  seq?: number
  /** Row kind: chat | note | queued | summary | reverted. */
  kind?: string
  extra: Record<string, unknown> | null
  created_at: string | null
  attachments: MessageAttachment[] | null
  /** A tool row whose output stays on the server (fetched on open). */
  result_omitted?: boolean
  /** Its size in bytes, when ``result_omitted``. */
  result_bytes?: number
}

export interface ToolCall {
  id: string
  type: string
  function: {
    name: string
    arguments: string  // raw JSON string from API
    thought?: string | null
    thought_signature?: string | null
  }
}

export type SessionInteractionMode = 'code' | 'plan'

export interface SessionResponse {
  id: string
  parent_session_id?: string | null
  title: string | null
  agent_name: string | null
  revert?: { message_id?: string; keep_files?: boolean } | null
  created_at: string | null
  updated_at: string | null
  /**
   * Newest message (v3; creation for an empty session). What activity sort
   * and the sidebar's age follow: ``updated_at`` also moves on renames and
   * model or mode switches. Read it through ``sessionActivityTime``.
   */
  last_message_at?: string | null
  scheduled_task_name?: string | null
  mode?: string
  workspace?: string | null
  workspace_hidden?: boolean
  interaction_mode?: SessionInteractionMode
  /** Mode switch queued behind an active turn; applies when that turn closes. */
  pending_interaction_mode?: SessionInteractionMode | null
  model?: string | null
  thinking_level?: string | null
  /** The stored credential (key or account) the session is pinned to; absent on Auto (v3). */
  credential_id?: string | null
  running?: boolean
  subagents?: SessionResponse[]
  /**
   * Full-session usage totals — every user-visible message, compaction
   * summaries included (the summariser is a billed model call). Populated on
   * history responses so the client can show the authoritative session
   * cost/output without re-summing the truncated history page. Absent/null on
   * list and status payloads that never compute them.
   */
  estimated_cost_usd?: number | null
  completion_tokens?: number | null
  /**
   * The lead of this session is suspended on `ask_user`.
   *
   * Implies `running` — the turn never closed — so a session list must check
   * this first, or a session waiting for the user is indistinguishable from one
   * that is busy working.
   */
  needs_input?: boolean
  /**
   * The session's own turn ended, but subagents (or another workspace) still
   * work for it, and their reports will run it again (v3). Set on session
   * list rows, which `active=true` then includes; absent when false.
   */
  background_work?: boolean
  /** When the session was pinned in the sidebar (v3); absent when unpinned. */
  pinned_at?: string | null
  /** The session's live goal (v3); absent without one. */
  goal_status?: 'active' | 'paused' | null
  /**
   * The session in another workspace whose ``workspace`` send started this
   * one (v3); absent for every other session.
   */
  sent_from?: SessionSentFrom | null
  /**
   * Sessions in other workspaces this one's sends started, directly or down
   * a chain, oldest first (v3, list rows); absent when none.
   */
  linked_sessions?: SessionResponse[]
}

/** Who started a session from another workspace (``SessionResponse.sent_from``). */
export interface SessionSentFrom {
  session_id: string
  workspace: string
  title?: string | null
}

export interface SessionDetailResponse extends SessionResponse {
  messages: MessageResponse[]
}

/** Session list order: newest created (v2) or most recently touched (v3). */
export type SessionSort = 'created' | 'activity'

export interface SessionResolveResponse extends SessionResponse {
  created: boolean
}

export interface SessionPageResponse {
  data: SessionResponse[]
  /** ISO 8601 created_at of the last item; pass as `before` to fetch next page. */
  next_cursor: string | null
  has_more: boolean
  /** Sessions past this page (v3; only on a page with more to show). */
  remaining?: number
}

export interface SessionHistoryResponse {
  lead: SessionDetailResponse
  members: Array<{
    name: string
    session_id: string
    /**
     * Empty from servers since v3.46.0: the lead's view never renders a
     * member's rows, and opening a member loads its own session. Older
     * servers send its newest rows.
     */
    messages: MessageResponse[]
    running?: boolean
    estimated_cost_usd?: number | null
    completion_tokens?: number | null
  }>
  has_more: boolean
  next_cursor: string | null
  /**
   * Delta responses (`?since=`) only: the delta hit the server row cap, so the
   * caller must fall back to a full page rather than stitching an incomplete
   * tail onto local state. Always `false`/absent for full pages.
   */
  truncated?: boolean
  /**
   * Set when the lead is suspended on `ask_user`. Present on full
   * pages only — a delta (`?since=`) always omits it, so absence there must not
   * be read as "the question was resolved".
   */
  pending_question?: PendingQuestionResponse | null
  /**
   * First page only: the latest prompt the user wrote, set when the run since
   * it is longer than the page, so the page starts after it.
   */
  latest_prompt?: MessageResponse | null
}

// Content Block Types
export interface ContentBlock {
  id: string
  type: 'thinking' | 'tool' | 'text' | 'user' | 'compaction' | 'provider_status'
  content: string
  toolName?: string
  toolArgs?: string
  /**
   * ``toolArgs`` is the short form history sends (a shell call without its
   * command, a patch's files, a plan without its Markdown), and the full
   * arguments are this many bytes; the card fetches them when opened.
   */
  toolArgsBytes?: number
  toolDone?: boolean
  toolCallId?: string   // for matching tool results
  toolOutput?: string   // live output streamed before tool_end
  toolResult?: string   // the role:"tool" response content
  /**
   * The call finished with this many bytes of output that stay on the
   * server: ``toolResult`` is absent and the card fetches it when opened
   * (``useToolResult``). Absent when the result rode with the call.
   */
  toolResultBytes?: number
  durationMs?: number         // client-side elapsed since first chunk (what the live timer shows, frozen on completion)
  serverDurationMs?: number   // server-measured execution time from tool_end duration_ms
  startedAt?: number          // client timestamp when block was first created (for live elapsed display)
  responseDurationMs?: number // assistant response duration shown in turn footer
  thinkingDurationMs?: number // how long the model reasoned (``extra.thinking_duration_ms``), thinking blocks only
  /**
   * The persisted message's own usage, carried on exactly one of the blocks
   * that message produced so a turn can sum it without double counting.
   * Absent on live blocks until the post-turn reconcile adopts the rows.
   */
  usage?: { outputTokens: number; costUsd: number; inputTokens?: number; cachedTokens?: number }
  /** Variant-specific metadata. ``user`` inbox blocks carry ``from_agent``;
   *  ``compaction`` blocks carry ``state: 'compacting' | 'compacted'`` and
   *  optional ``error: true``. Keeping this generic avoids one typed field
   *  per block variant. */
  extra?: Record<string, unknown> | null
  /** Timestamp when block was created (for agent mode display) */
  timestamp?: Date
  /** File attachments (images, documents, etc.) — for user blocks */
  attachments?: MessageAttachment[]
}

export interface TodoItem {
  task_id: string
  content: string
  status: 'pending' | 'in_progress' | 'completed' | 'cancelled'
}

export interface TodosResponse {
  todos: TodoItem[]
}

/** The session plan the lead writes with the ``plan`` tool; v3 only. */
export interface SessionPlan {
  content: string
  updated_at: string
  /** Bumped by every change, including edits made outside the app. */
  revision?: number
  /** The revision the user approved in a plan review, if any. */
  approved_revision?: number | null
  /** Absolute path of the plan file. */
  path?: string
  /** Workspace-relative path, for a plan kept in the project workspace. */
  workspace_path?: string | null
  /** The plan's Done when: what a goal started from it must prove (``null`` without one). */
  done_when?: string | null
}

export interface SessionPlanResponse {
  plan: SessionPlan | null
}

export type SessionGoalStatus = 'active' | 'paused' | 'achieved' | 'cleared'

/** Why a goal is paused (`session_goals.pause_reason`). */
export type GoalPauseReason =
  | 'stopped'
  | 'user'
  | 'blocked'
  | 'turn_limit'
  /** Only goals paused before goals lost their token budget. */
  | 'token_limit'
  | 'no_progress'
  | 'unverified'
  | 'check_failed'
  | 'error'
  | 'restart'

/** A goal: an objective the session keeps taking turns toward (v3). */
export interface SessionGoal {
  id: string
  session_id: string
  objective: string
  status: SessionGoalStatus
  pause_reason: GoalPauseReason | null
  /** The blocker, the last check's reason, or the error that paused it. */
  detail: string | null
  max_turns: number
  turns_used: number
  /** Uncached input plus output tokens of its turns and checks. */
  tokens_used: number
  active_seconds: number
  /** Completion claims the check rejected in a row. */
  rejected_claims: number
  created_at: string
  updated_at: string
  ended_at: string | null
}

export interface SessionGoalResponse {
  /** The newest goal, ended ones included; clients hide a cleared one. */
  goal: SessionGoal | null
}

export interface AgentChatResponse {
  status: string
  session_id: string
  message_id?: string | null
}
