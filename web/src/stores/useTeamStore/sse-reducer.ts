import {
  appendThinking,
  appendText,
  initTool,
  addTool,
  appendToolOutput,
  completeTool,
  generateBlockId,
  startCompaction,
  appendCompactionContent,
  endCompaction,
} from '@/utils/blocks'
import { createDefaultAgentStream } from './defaults'
import {
  FS_MUTATING_TOOLS,
  SCHEDULER_MUTATING_TOOLS,
  TODO_MUTATING_TOOLS,
  anyAgentLive,
  appendLocalBlocks,
  applyLocalBlockTransform,
  applyQuestionResolution,
  extractToolPaths,
} from './helpers'
import type { CacheInvalidation, TeamStore } from './types'
import type { ContentBlock, PendingQuestion, QuestionItem } from '@/api/types'

type Setter = (fn: (draft: TeamStore) => void) => void
type Getter = () => TeamStore

/**
 * Coerce the ``question_asked`` payload into ``QuestionItem[]``.
 *
 * The event carries the tool's already-validated args, but they cross the wire
 * as untyped ``dict[str, Any]``. Normalising here means the dock can render
 * without defensive checks at every field, and a malformed entry degrades to an
 * open-text question instead of throwing inside a render.
 */
export function normalizeQuestions(raw: unknown): QuestionItem[] {
  if (!Array.isArray(raw)) return []
  return raw.map((entry) => {
    const q = (entry ?? {}) as Record<string, unknown>
    const options = Array.isArray(q.options) ? q.options : []
    return {
      question: typeof q.question === 'string' ? q.question : '',
      header: typeof q.header === 'string' ? q.header : '',
      multiple: q.multiple === true,
      custom: q.custom === true,
      options: options.map((opt) => {
        const o = (opt ?? {}) as Record<string, unknown>
        return {
          label: typeof o.label === 'string' ? o.label : '',
          description: typeof o.description === 'string' ? o.description : null,
          recommended: o.recommended === true,
        }
      }),
    }
  })
}

/**
 * Map a wire question (SSE event or history row) to store shape.
 *
 * Returns ``null`` for a payload with nothing to render, so callers never put a
 * card on screen that the user cannot act on. Single source of truth for the
 * mapping — the SSE path and the cold-load path must agree exactly, or a reload
 * would silently change the card.
 */
export function toPendingQuestion(raw: {
  id?: unknown
  session_id?: unknown
  tool_call_id?: unknown
  questions?: unknown
}): PendingQuestion | null {
  const id = typeof raw.id === 'string' ? raw.id : ''
  const questions = normalizeQuestions(raw.questions)
  if (!id || questions.length === 0) return null
  return {
    id,
    sessionId: typeof raw.session_id === 'string' ? raw.session_id : '',
    toolCallId: typeof raw.tool_call_id === 'string' ? raw.tool_call_id : '',
    questions,
  }
}

function ensureAgent(draft: TeamStore, agent: string) {
  if (!draft.agentStreams[agent]) draft.agentStreams[agent] = createDefaultAgentStream()
  if (!draft.agentNames.includes(agent)) draft.agentNames.push(agent)
}

interface CreateSSEHandlerArgs {
  set: Setter
  get: Getter
}

type BufferedTextKind = 'message' | 'thinking'

export type BufferedSSEDelta = {
  type: BufferedTextKind | 'tool_output_delta'
  data: Record<string, unknown>
}

export function isBufferedSSEDelta(type: string): type is BufferedSSEDelta['type'] {
  return type === 'message' || type === 'thinking' || type === 'tool_output_delta'
}

function stampOpenTextBlocks(
  blocks: TeamStore['agentStreams'][string]['currentBlocks'],
  completedAt: number,
  turnStartedAt?: number | null,
) {
  return blocks.map((block) => {
    if (block.type !== 'text' || block.responseDurationMs !== undefined) return block
    const startedAt = turnStartedAt ?? block.startedAt
    if (startedAt === undefined || startedAt === null) return block
    return {
      ...block,
      responseDurationMs: Math.max(0, completedAt - startedAt),
    }
  })
}

function markTurnStarted(draft: TeamStore, agent: string, startedAt = Date.now()) {
  ensureAgent(draft, agent)
  const stream = draft.agentStreams[agent]
  if (stream._turnStartedAt === undefined || stream._turnStartedAt === null) stream._turnStartedAt = startedAt
}

function appendStreamingText(
  draft: TeamStore,
  agent: string,
  kind: BufferedTextKind,
  text: string,
  model?: string | null,
) {
  ensureAgent(draft, agent)
  const stream = draft.agentStreams[agent]
  if (stream._turnStartedAt === undefined || stream._turnStartedAt === null) stream._turnStartedAt = Date.now()
  // Only the first chunk of each kind after an attach can be a replay
  // snapshot; consume the flag so later deltas concatenate unconditionally
  // (see `_replayPending` in types.ts and `isReplaySnapshot` in blocks.ts).
  //
  // Absent flag (a stream built outside `createDefaultAgentStream`, e.g. by a
  // test fixture) defaults to *not* deduping: the worst case is then visibly
  // doubled text that a reload clears, rather than silently swallowed tokens.
  if (!stream._replayPending) stream._replayPending = { message: false, thinking: false }
  const replayPossible = stream._replayPending[kind]
  if (replayPossible) stream._replayPending[kind] = false
  if (kind === 'thinking') {
    stream.currentBlocks = appendThinking(stream.currentBlocks, text, replayPossible)
  } else {
    stream.currentBlocks = appendText(stream.currentBlocks, text, replayPossible)
    const last = stream.currentBlocks[stream.currentBlocks.length - 1]
    if (last?.type === 'text') {
      if (!last.startedAt) last.startedAt = Date.now()
      if (model) last.extra = { ...(last.extra ?? {}), model }
    }
  }
}

/**
 * True when the agent's confirmed ``blocks`` hold a still-running card for
 * this tool call. Happens when a mid-turn ``loadSession`` reconciles the
 * persisted assistant row (saved *before* its tools finish executing) while
 * the tool is still live — later tool events must reach that card instead of
 * targeting ``currentBlocks`` and silently vanishing, which left the card
 * stuck "running" until a full reload. Matched strictly by ``toolCallId``;
 * the name-based fallback stays live-only so orphaned incomplete cards in
 * history are never completed by an unrelated event.
 */
function findConfirmedTool(draft: TeamStore, agent: string, toolCallId: string | undefined): ContentBlock | undefined {
  if (!toolCallId) return undefined
  return draft.agentStreams[agent].blocks.find(
    (b) => b.type === 'tool' && b.toolCallId === toolCallId,
  )
}

function applyBufferedSSEDelta(draft: TeamStore, event: BufferedSSEDelta) {
  const d = event.data
  if (event.type === 'message' || event.type === 'thinking') {
    appendStreamingText(
      draft,
      d.agent as string,
      event.type,
      d.text as string,
      typeof (d.metadata as Record<string, unknown> | undefined)?.model === 'string'
        ? ((d.metadata as Record<string, unknown>).model as string)
        : null,
    )
    return
  }

  const agent = d.agent as string
  const toolCallId = d.tool_call_id as string | undefined
  ensureAgent(draft, agent)
  const stream = draft.agentStreams[agent]
  const next = appendToolOutput(stream.currentBlocks, d.name as string, toolCallId, d.text as string)
  if (next !== stream.currentBlocks) {
    stream.currentBlocks = next
    return
  }
  // No live card — the tool may already sit in the confirmed rows (a mid-turn
  // loadSession reconciles the assistant row before its tools finish). Route
  // the delta there instead of dropping it; matched strictly by id so
  // orphaned history cards are never touched.
  const confirmed = findConfirmedTool(draft, agent, toolCallId)
  if (confirmed && !confirmed.toolDone) {
    stream.blocks = appendToolOutput(stream.blocks, d.name as string, toolCallId, d.text as string)
  }
}

/** Apply a group of high-frequency text/tool-output deltas in one immer
 * transaction, producing a single Zustand subscriber notification. */
export function applySSEDeltaBatch(set: Setter, events: BufferedSSEDelta[]) {
  if (events.length === 0) return
  set((draft) => {
    for (const event of events) applyBufferedSSEDelta(draft, event)
  })
}

export function createSSEHandler({ set, get }: CreateSSEHandlerArgs) {
  return (type: string, data: unknown) => {
    const d = data as Record<string, unknown>

    switch (type) {
      case 'session': {
        set((draft) => {
          draft.sessionId = d.session_id as string
          // A fresh turn is starting: any card still on screen belongs to the
          // turn that just ended, and the backend has already superseded it.
          // Record that outcome rather than just clearing — a bare clear leaves
          // the card with nothing to show but its "waiting" fallback.
          applyQuestionResolution(draft, null, null, 'superseded')
        })
        break
      }

      case 'thinking':
      case 'message': {
        applySSEDeltaBatch(set, [{ type, data: d }])
        break
      }

      case 'tool_call': {
        const agent = d.agent as string
        set((draft) => {
          markTurnStarted(draft, agent)
          // Replay after a mid-turn reconcile: the card already lives in the
          // confirmed rows — recreating it live would render a duplicate.
          if (findConfirmedTool(draft, agent, d.tool_call_id as string | undefined)) return
          draft.agentStreams[agent].currentBlocks = initTool(
            draft.agentStreams[agent].currentBlocks,
            d.name as string,
            d.tool_call_id as string | undefined,
            typeof d.duration_ms === 'number' ? d.duration_ms : undefined,
          )
        })
        break
      }

      case 'tool_start': {
        const agent = d.agent as string
        set((draft) => {
          markTurnStarted(draft, agent)
          const toolCallId = d.tool_call_id as string | undefined
          // Mirrors addTool's own match condition.
          const hasLive = draft.agentStreams[agent].currentBlocks.some(
            (b) =>
              b.type === 'tool' &&
              (toolCallId
                ? b.toolCallId === toolCallId
                : b.toolName === (d.name as string) && b.toolArgs === undefined),
          )
          // Confirmed card already carries its args (persisted with the
          // assistant row) — don't let addTool's fallback spawn a duplicate.
          if (!hasLive && findConfirmedTool(draft, agent, toolCallId)) return
          draft.agentStreams[agent].currentBlocks = addTool(
            draft.agentStreams[agent].currentBlocks,
            d.name as string,
            d.arguments as string | undefined,
            toolCallId,
            typeof d.duration_ms === 'number' ? d.duration_ms : undefined,
          )
        })
        break
      }

      case 'tool_output_delta': {
        applySSEDeltaBatch(set, [{ type, data: d }])
        break
      }

      case 'tool_end': {
        const agent = d.agent as string
        const toolName = d.name as string
        const toolCallId = d.tool_call_id as string | undefined
        const result = d.result as string | undefined
        const metadata = d.metadata as Record<string, unknown> | undefined
        const serverDurationMs = typeof d.duration_ms === 'number'
          ? d.duration_ms
          : typeof metadata?.duration_ms === 'number'
            ? metadata.duration_ms
            : undefined
        const mcpApp = metadata?.mcp_app as Record<string, unknown> | undefined
        set((draft) => {
          ensureAgent(draft, agent)
          const stream = draft.agentStreams[agent]
          // Mirrors completeTool's own matching: exact id, else incomplete
          // card of the same name.
          const hasLive = stream.currentBlocks.some(
            (b) =>
              b.type === 'tool' &&
              ((toolCallId && b.toolCallId === toolCallId) ||
                (b.toolName === toolName && !b.toolDone)),
          )
          const confirmed = hasLive ? undefined : findConfirmedTool(draft, agent, toolCallId)
          if (confirmed && !confirmed.toolDone) {
            // Card was reconciled into the confirmed rows mid-turn — finish
            // it there or it stays "running" until a full reload.
            stream.blocks = completeTool(
              stream.blocks,
              toolName,
              toolCallId,
              result,
              serverDurationMs,
              mcpApp ? { mcp_app: mcpApp } : undefined,
            )
            return
          }
          stream.currentBlocks = completeTool(
            stream.currentBlocks,
            toolName,
            toolCallId,
            result,
            serverDurationMs,
            mcpApp ? { mcp_app: mcpApp } : undefined,
          )
        })
        const events: CacheInvalidation[] = []
        if (FS_MUTATING_TOOLS.has(toolName)) {
          const workspace = get()._workspace
          if (workspace) {
            const stream = get().agentStreams[agent]
            const matchesEndedTool = (b: (typeof stream.currentBlocks)[number]) =>
              b.type === 'tool' &&
              (toolCallId ? b.toolCallId === toolCallId : b.toolName === toolName)
            const block =
              stream?.currentBlocks.find(matchesEndedTool) ?? stream?.blocks.find(matchesEndedTool)
            const paths = extractToolPaths(toolName, block?.toolArgs)
            if (paths && paths.length > 0) {
              events.push({
                kind: 'coding_workspace_paths',
                workspace,
                paths,
              })
            } else {
              events.push({ kind: 'coding_workspace', workspace })
            }
          } else {
            const sid = get().sessionId
            if (sid) events.push({ kind: 'workspace_files', sessionId: sid })
          }
        }
        if (SCHEDULER_MUTATING_TOOLS.has(toolName)) {
          events.push({ kind: 'scheduler' })
        }
        if (TODO_MUTATING_TOOLS.has(toolName)) {
          const sid = get().sessionId
          if (sid) events.push({ kind: 'todos', sessionId: sid })
        }
        if (toolName === 'team_manage') {
          events.push({ kind: 'team_agents' })
        }
        if (events.length > 0) {
          set((draft) => { draft.cacheInvalidations.push(...events) })
        }
        break
      }

      case 'provider_status': {
        const agent = d.agent as string
        const status = d.status as string
        if (!agent || !status) break
        set((draft) => {
          ensureAgent(draft, agent)
          draft.agentStreams[agent].currentBlocks.push({
            id: generateBlockId(),
            type: 'provider_status',
            content: '',
            extra: d,
            timestamp: new Date(),
          })
        })
        break
      }

      case 'usage': {
        const meta = d.metadata as Record<string, unknown> | undefined
        const agent = (meta?.agent as string) ?? (d.agent as string)
        if (!agent) break
        set((draft) => {
          ensureAgent(draft, agent)
          const stream = draft.agentStreams[agent]
          const u = stream.usage
          const promptTokens = (d.prompt_tokens as number) || 0
          const completionTokens = (d.completion_tokens as number) || 0
          const cachedTokens = d.cached_tokens as number | undefined
          if (meta?.turn_total) {
            u.turnPromptTokens = promptTokens
            u.turnCompletionTokens = completionTokens
            u.turnTotalTokens = (d.total_tokens as number) || (promptTokens + completionTokens)
            u.turnCachedTokens = cachedTokens ?? 0
            return
          }
          u.promptTokens     = promptTokens
          u.completionTokens = u.completionTokens + completionTokens
          // Absent means "this call read nothing from cache" — providers coerce
          // 0 to None, so `usage_to_dict` drops the key. Carrying the previous
          // value forward diverged from `sumUsageFromMessages`, which reads the
          // last message's cache as 0 on reload.
          u.cachedTokens     = cachedTokens ?? 0
          u.totalTokens      = u.promptTokens + u.completionTokens
          u.estimatedCostUsd = Math.round(((u.estimatedCostUsd ?? 0) + ((d.estimated_cost_usd as number) || 0)) * 1e8) / 1e8
        })
        break
      }

      case 'inbox': {
        const agent = d.agent as string
        set((draft) => {
          ensureAgent(draft, agent)
          draft.agentStreams[agent].currentBlocks.push({
            id: generateBlockId(),
            type: 'user',
            content: d.content as string,
            extra: { from_agent: d.from_agent as string },
            timestamp: new Date(),
          })
        })
        break
      }

      case 'queued_turn_start': {
        const agent = d.agent as string
        const messageIds = Array.isArray(d.message_ids) ? new Set(d.message_ids as string[]) : null
        const eventMessages = Array.isArray(d.messages)
          ? (d.messages as Array<{ id?: unknown; content?: unknown }>).flatMap((msg) => {
              if (typeof msg.id !== 'string' || typeof msg.content !== 'string') return []
              return [{ id: msg.id, content: msg.content }]
            })
          : []
        set((draft) => {
          ensureAgent(draft, agent)
          if (agent !== draft.leadName || !draft.sessionId) return
          draft.isTeamWorking = true
          draft.error = null
          draft.agentStreams[agent].status = 'working'
          const queued = draft._pendingMessages.filter((msg) => {
            if (msg.sessionId !== draft.sessionId) return false
            return messageIds === null || messageIds.has(msg.id)
          })
          const queuedById = new Map<string, (typeof queued)[number]>(
            queued.map((msg) => [msg.id, msg]),
          )
          const queuedIds = new Set(queuedById.keys())
          const eventById = new Map(eventMessages.map((msg) => [msg.id, msg]))
          // `message_ids` is the single authoritative order (it is built
          // server-side from the same query, in the same order, as
          // `messages`). Resolve each id against the locally-tracked pending
          // message first — it carries the real `submittedAt`/attachments —
          // falling back to the event's own content only for ids this client
          // never optimistically tracked (e.g. injected by another client, or
          // a POST response that hadn't resolved yet). Concatenating the two
          // groups instead of merging on `message_ids` would silently
          // reorder a message whenever it fell into the fallback group while
          // an earlier id resolved locally.
          const messages = messageIds === null
            ? [
                ...queued.map((msg) => ({
                  id: msg.id,
                  content: msg.content,
                  submittedAt: msg.submittedAt,
                  attachments: msg.attachments,
                })),
                ...eventMessages
                  .filter((msg) => !queuedIds.has(msg.id))
                  .map((msg) => ({ ...msg, submittedAt: Date.now(), attachments: undefined })),
              ]
            : Array.from(messageIds).flatMap((id) => {
                const pending = queuedById.get(id)
                if (pending) {
                  return [{
                    id: pending.id,
                    content: pending.content,
                    submittedAt: pending.submittedAt,
                    attachments: pending.attachments,
                  }]
                }
                const ev = eventById.get(id)
                return ev ? [{ ...ev, submittedAt: Date.now(), attachments: undefined }] : []
              })
          if (messages.length === 0) return
          const now = Date.now()
          const stream = draft.agentStreams[agent]
          stream.currentBlocks = stampOpenTextBlocks(
            stream.currentBlocks,
            now,
            stream._turnStartedAt,
          )
          const nextTurnStartedAt = messages[0]?.submittedAt ?? now
          // Guard: if a /undo ran before this SSE event arrived, drop any user
          // blocks whose timestamp is at or after the revert boundary so they
          // do not re-appear as ghost messages in the chat area.
          const revertTime = draft._leadRevertTime
          const newUserBlocks = messages
            .filter((msg) => {
              if (revertTime === null) return true
              const t = msg.submittedAt ?? now
              return t < revertTime
            })
            .map((msg) => ({
              id: msg.id,
              type: 'user' as const,
              content: msg.content,
              timestamp: new Date(msg.submittedAt ?? now),
              ...(msg.attachments && msg.attachments.length > 0
                ? { attachments: msg.attachments }
                : {}),
            }))
          stream.currentBlocks.push(...newUserBlocks)
          stream._turnStartedAt = nextTurnStartedAt
          draft._pendingMessages = draft._pendingMessages.filter((msg) => !queuedIds.has(msg.id))
        })
        break
      }

      case 'agent_status': {
        const agent = d.agent as string
        const status = d.status as string
        set((draft) => {
          ensureAgent(draft, agent)
          if (status === 'working') {
            draft.agentStreams[agent].status = 'working'
            draft.isTeamWorking = true
            if (draft.liveAgentNames && !draft.liveAgentNames.includes(agent)) draft.liveAgentNames.push(agent)
            // Only the sidebar's ``running`` badge depends on this. Patch that
            // one field rather than invalidating the whole list — a team turn
            // emits one agent_status per member, so invalidating here used to
            // cost (members × loaded pages) sequential refetches per turn.
            if (draft.sessionId) {
              draft.cacheInvalidations.push({
                kind: 'session_running',
                sessionId: draft.sessionId,
                running: true,
              })
            }
          } else if (status === 'waiting_input') {
            // Suspended on ask_user: still live, but no tokens are coming.
            draft.agentStreams[agent].status = 'waiting_input'
            draft.isTeamWorking = true
            if (draft.liveAgentNames && !draft.liveAgentNames.includes(agent)) draft.liveAgentNames.push(agent)
          } else if (status === 'idle') {
            draft.agentStreams[agent].status = 'idle'
            if (draft.liveAgentNames && !draft.liveAgentNames.includes(agent)) draft.liveAgentNames.push(agent)
          } else if (status === 'offline') {
            draft.agentStreams[agent].status = 'offline'
            if (draft.liveAgentNames) draft.liveAgentNames = draft.liveAgentNames.filter((name) => name !== agent)
          } else if (status === 'error') {
            draft.agentStreams[agent].status = 'error'
            draft.agentStreams[agent].lastError =
              (d.metadata as Record<string, unknown>)?.message as string ?? null
            if (draft.liveAgentNames && !draft.liveAgentNames.includes(agent)) draft.liveAgentNames.push(agent)
          }
          if (status !== 'working' && status !== 'waiting_input') {
            draft.isTeamWorking = anyAgentLive(draft.agentStreams)
          }
        })
        break
      }

      case 'question_asked': {
        // The event names the row ``question_id``; every other carrier calls it
        // ``id``. Normalise before the shared mapper sees it.
        const question = toPendingQuestion({ ...d, id: d.question_id })
        if (!question) break
        set((draft) => { draft.pendingQuestion = question })
        break
      }

      // Both resolutions are also delivered to the client that triggered them,
      // so this is the single place the card is closed. That keeps a second
      // device (or a second tab) in sync with no extra round-trip, and makes
      // the local optimistic path unnecessary.
      case 'question_answered':
      case 'question_dismissed': {
        const questionId = d.question_id as string
        const answers = type === 'question_answered'
          ? (Array.isArray(d.answers) ? (d.answers as string[][]) : [])
          : null
        set((draft) => {
          // Guarded inside the helper: a late event for a question we are no
          // longer showing must not close the current card, and the local path
          // may already have recorded this same resolution.
          applyQuestionResolution(
            draft,
            questionId,
            answers,
            answers === null ? ((d.reason as string) ?? 'dismissed') : null,
          )
        })
        break
      }

      case 'done': {
        set((draft) => {
          draft.isTeamWorking = false
          // An open question deliberately survives `done`. The suspension is
          // durable: the row stays `pending`, and a reload brings the card back
          // fully answerable, so closing it here would show a resolution the
          // server never made. Real endings (answer, dismiss, supersede, stop)
          // all broadcast their own resolution.
          const completedAtMs = Date.now()
          const completedAt = new Date(completedAtMs)
          const revertTime = draft._leadRevertTime
          Object.keys(draft.agentStreams).forEach((name) => {
            const stream = draft.agentStreams[name]
            if (stream.currentBlocks.length > 0) {
              const stamped = stampOpenTextBlocks(stream.currentBlocks, completedAtMs, stream._turnStartedAt).map((b) => ({
                ...b,
                timestamp: b.timestamp ?? completedAt,
              }))
              // Guard: if a /undo ran while the turn was still in flight, drop
              // any blocks at or after the revert boundary so they don't
              // re-surface as ghost messages when currentBlocks are finalised.
              const toCommit = revertTime === null
                ? stamped
                : stamped.filter((b) => (b.timestamp?.getTime() ?? 0) < revertTime)
              appendLocalBlocks(stream, toCommit)
              stream.currentBlocks = []
            }
            stream._turnStartedAt = null
            if (stream.status !== 'error' && stream.status !== 'offline') {
              stream.status = 'idle'
            }
          })
          if (draft.sessionId) {
            draft.cacheInvalidations.push({
              kind: 'session_running',
              sessionId: draft.sessionId,
              running: false,
            })
          }
        })
        break
      }

      case 'error': {
        set((draft) => {
          draft.error = d.message as string
          draft.isTeamWorking = false
        })
        break
      }

      case 'summarization_start': {
        const agent = d.agent as string
        if (!agent) break
        set((draft) => {
          ensureAgent(draft, agent)
          const stream = draft.agentStreams[agent]
          // Auto-compaction can start between model iterations, after this turn
          // has already streamed text/tools into currentBlocks. Seal those
          // blocks first so the divider lands at the actual trigger point;
          // subsequent deltas then remain after it. Everything sealed (plus a
          // newly created "compacting" divider) is local-only, exactly like a
          // `done` flush, so `applyLocalBlockTransform` tags it unsynced the
          // same way.
          const sealed = stream.currentBlocks
          stream.currentBlocks = []
          applyLocalBlockTransform(stream, (blocks) => startCompaction([...blocks, ...sealed]))
        })
        break
      }

      case 'summarization_content': {
        const agent = d.agent as string
        const text = d.text as string
        if (!agent || !text) break
        set((draft) => {
          ensureAgent(draft, agent)
          const stream = draft.agentStreams[agent]
          stream.blocks = appendCompactionContent(stream.blocks, text)
        })
        break
      }

      case 'summarization_end': {
        const agent = d.agent as string
        if (!agent) break
        const summary = (d.summary as string | undefined) ?? ''
        const meta = d.metadata as Record<string, unknown> | undefined
        const error = Boolean(meta?.error)
        set((draft) => {
          ensureAgent(draft, agent)
          const stream = draft.agentStreams[agent]
          // Usually edits the in-flight divider in place (nothing new to tag).
          // Defensive path: no in-flight "compacting" block existed (e.g.
          // events arrived out of order), so `endCompaction` synthesized a
          // fresh completed one — tag it as unsynced like every other
          // locally-created block.
          applyLocalBlockTransform(stream, (blocks) => endCompaction(blocks, summary, error))
        })
        break
      }

      case 'agent_not_configured': {
        const agent = d.agent as string
        set((draft) => {
          ensureAgent(draft, agent)
          draft.agentStreams[agent].status = 'error'
          draft.agentStreams[agent].lastError = d.message as string
          draft.setupRequired = {
            agent,
            message: d.message as string,
            action: (d.action as { type?: string; tab?: string } | undefined) ?? {},
          }
          draft.isTeamWorking = false
        })
        break
      }
    }
  }
}
