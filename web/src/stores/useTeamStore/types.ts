import type {
  ContentBlock,
  AgentUsage,
  MessageAttachment,
  PendingQuestion,
  QuestionItem,
  TeamCommandResponse,
} from '@/api/types'

export interface PendingMessage {
  id: string
  sessionId?: string | null
  content: string
  submittedAt?: number
  /** Display metadata for files queued with this message (no blob URLs). */
  attachments?: MessageAttachment[]
  /** Original File objects, kept so cancelling restores them into the composer. */
  files?: File[]
}

export type CacheInvalidation =
  | { kind: 'workspace_files'; sessionId: string }
  | { kind: 'coding_workspace'; workspace: string }
  | { kind: 'coding_workspace_paths'; workspace: string; paths: string[] }
  | { kind: 'scheduler' }
  | { kind: 'todos'; sessionId: string }
  | { kind: 'team_agents' }
  | { kind: 'team_sessions' }
  /**
   * A turn started or finished for ``sessionId``. Patches that row's
   * ``running`` flag in place instead of refetching the whole (infinite,
   * sequentially-refetched) session list. See ``patchSessionRunning``.
   */
  | { kind: 'session_running'; sessionId: string; running: boolean }

/** How a question ended, with enough context to render it without the wire text. */
export interface ResolvedQuestion {
  questions: QuestionItem[]
  /** Index-matched selections, or ``null`` when it closed without an answer. */
  answers: string[][] | null
  /**
   * Why it closed without an answer — ``dismissed``, ``superseded`` or
   * ``expired``; ``null`` when answered. A null answer list alone cannot tell
   * "I decided not to say" from "I typed something else instead".
   */
  reason: string | null
}

export interface SetupRequiredNotice {
  agent: string
  message: string
  action: { type?: string; tab?: string }
}

export interface AgentStream {
  blocks: ContentBlock[]
  currentBlocks: ContentBlock[]
  currentText: string
  currentThinking: string
  /**
   * ``waiting_input`` mirrors the backend's ``waiting_input`` member state: the
   * agent is suspended on an ``ask_user`` call. It is *live* (the turn
   * has not ended) but not *working* (no tokens are coming), so spinners should
   * treat it as busy while progress indicators should not.
   */
  status: 'idle' | 'working' | 'waiting_input' | 'offline' | 'error'
  usage: AgentUsage
  _turnStartedAt?: number | null
  /**
   * `currentBlocks.length` at the moment the turn was restarted with no new
   * user message — an answered `ask_user`, or `/continue` — or `null` when no
   * restart is outstanding.
   *
   * A normal send shows "about to respond" dots because its optimistic user
   * block is the only thing in `currentBlocks`. A restart adds no block and
   * `currentBlocks` still holds the turn it is resuming, so neither dots
   * condition fires and the UI looks frozen until the first token.
   *
   * Stored as a mark rather than a boolean so that "still waiting" is
   * *derived* — see {@link isAwaitingRestartOutput}. Any content arriving moves
   * `currentBlocks.length` off the mark and the condition goes false on its
   * own, so there is no clear-the-flag path to forget on the half-dozen ways a
   * restarted turn can end (first token, buffered delta, status change, `done`,
   * or a reconcile that is the only surviving signal after a daemon restart).
   */
  _restartedAtBlockCount?: number | null
  model: string | null
  lastError: string | null
  revertedCount?: number
  revertedMessages?: Array<{ role: string; content: string; attachments?: MessageAttachment[] }>
  _revertedSuffix?: ContentBlock[]
  /**
   * Ids of blocks committed from the live stream that the server has not yet
   * confirmed. ``reconcileTurnTail`` drops exactly these and re-appends the
   * canonical rows from the delta, so the splice needs no index or timestamp
   * arithmetic (both of which break under ``loadOlderMessages`` prepends and
   * client/server clock skew respectively).
   */
  _unsyncedBlockIds?: string[]
  /**
   * Per-kind "the next streamed chunk may be a full replay snapshot" flag.
   *
   * ``memory_stream_store.attach`` replays the whole accumulated turn text as
   * a single ``thinking`` / ``message`` event (at most one of each per agent)
   * before forwarding live events. Only for that first chunk may the reducer
   * treat a prefix match as a replay to be *replaced*; for every later chunk a
   * prefix match is just a genuine delta that happens to repeat what came
   * before (``"-"`` then ``"-"``), and replacing it would drop real tokens.
   *
   * Set on every ``connectStream`` (each attach means a fresh replay), then
   * cleared per kind as soon as that kind's first chunk lands.
   */
  _replayPending?: { message: boolean; thinking: boolean }
}

export interface TeamStoreState {
  agentStreams: Record<string, AgentStream>
  activeAgent: string | null
  leadName: string | null
  agentNames: string[]
  liveAgentNames: string[] | null
  sidebarOpen: boolean
  sessionId: string | null
  sessionTitle: string | null
  sessionModel: string | null
  sessionThinkingLevel: string | null
  /** True while model/thinking settings are local overrides not yet confirmed by the server. */
  _sessionSettingsDirty: boolean
  _sessionSettingsVersion: number
  sessionFastMode: boolean
  isTeamWorking: boolean
  /**
   * The question the lead is currently suspended on, or ``null``.
   *
   * At most one is open per session (enforced by a partial unique index
   * server-side), so this is a single slot rather than a queue — a second
   * ``question_asked`` replaces the first instead of stacking cards.
   */
  pendingQuestion: PendingQuestion | null
  /**
   * Resolved questions, keyed by ``tool_call_id``.
   *
   * The persisted tool result is only rewritten server-side, so between
   * answering and the post-turn reconcile the transcript still holds the
   * "waiting for the user" placeholder — a whole turn of showing the wrong
   * thing. Keeping the resolution here lets the card render the real answer
   * immediately, from structured data rather than by re-parsing a sentence.
   */
  resolvedQuestions: Record<string, ResolvedQuestion>
  isConnected: boolean
  error: string | null
  setupRequired: SetupRequiredNotice | null
  _pendingMessages: PendingMessage[]
  _sessionGeneration: number
  hasMore: boolean
  nextCursor: string | null
  _leadRevertTime: number | null
  /**
   * ISO ``created_at`` of the newest message the server has confirmed across the
   * lead and every member session. Cursor for ``reconcileTurnTail``; ``null``
   * means "no confirmed baseline", which forces a full reload.
   */
  _syncedThrough: string | null
  _workspace: string | null
  _loadingOlder: boolean
  _resolvedSessionReadyId: string | null
  _unloading: boolean
  _reconnectTimer: ReturnType<typeof setTimeout> | null
  _reconnectAttempts: number
  cacheInvalidations: CacheInvalidation[]
}

export interface TeamStoreActions {
  /** Resolves ``true`` when the backend accepted the message, ``false`` otherwise. */
  sendMessage: (content: string, files?: File[], options?: { mode?: string; workspace?: string | null; model?: string | null; thinkingLevel?: string | null; fastMode?: boolean; mentions?: string[] }) => Promise<boolean>
  setSessionModelSettings: (model: string | null, thinkingLevel: string | null, fastMode?: boolean) => void
  compactTeam: () => Promise<void>
  undoTeam: () => Promise<TeamCommandResponse | undefined>
  redoTeam: () => Promise<void>
  stopTeam: () => Promise<void>
  connectStream: () => AbortController
  /**
   * Close the question card for ``questionId``, ignoring a stale id.
   *
   * Normally driven by the ``question_answered`` / ``question_dismissed`` SSE
   * events (which every connected client receives). The component that resolved
   * it also calls this directly, so the card closes even when this client's
   * stream is mid-reconnect and would never see its own resolution.
   */
  resolveQuestion: (
    questionId: string,
    answers: string[][] | null,
    reason: string | null,
  ) => void
  /**
   * Mark the lead's turn live again after an answered ``ask_user``.
   *
   * The resume carries no new user message, so without this the UI shows a
   * finished-looking turn until the first token of the restarted run.
   */
  markTurnResuming: () => void
  loadTeamStatus: (workspace?: string | null, expectedGeneration?: number) => Promise<void>
  loadSession: (sessionId: string, workspace?: string | null) => Promise<void>
  /**
   * Cheap post-turn reconciliation: adopt canonical rows for just the tail the
   * live stream produced, instead of re-downloading the whole visible page.
   * Falls back to ``loadSession`` whenever a delta cannot be applied safely.
   */
  reconcileTurnTail: (sessionId: string, workspace?: string | null) => Promise<void>
  beginResolvedSession: (sessionId: string | null, options?: { mode?: string; workspace?: string | null; model?: string | null; thinkingLevel?: string | null; fastMode?: boolean; skipInitialRestore?: boolean }) => void
  loadOlderMessages: () => Promise<void>
  setActiveAgent: (name: string) => void
  toggleSidebar: () => void
  dismissSetupRequired: () => void
  isEmptyIdleSession: () => boolean
  consumeResolvedSessionReady: (sessionId: string, workspace?: string | null) => boolean
  /** Reset local chat state. Retained for stale async-generation guards in tests. */
  newSession: () => void
  removePendingMessage: (id: string) => void
  _handleSSEEvent: (type: string, data: unknown) => void
  _drainCacheInvalidations: () => CacheInvalidation[]
  _abortController: AbortController | null
  _reconnectTimer: ReturnType<typeof setTimeout> | null
}

export type TeamStore = TeamStoreState & TeamStoreActions
