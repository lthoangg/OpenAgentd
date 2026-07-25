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
  extractToolPaths,
} from './helpers'
import type { CacheInvalidation, TeamStore } from './types'

type Setter = (fn: (draft: TeamStore) => void) => void
type Getter = () => TeamStore

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
  if (kind === 'thinking') {
    stream.currentBlocks = appendThinking(stream.currentBlocks, text)
  } else {
    stream.currentBlocks = appendText(stream.currentBlocks, text)
    const last = stream.currentBlocks[stream.currentBlocks.length - 1]
    if (last?.type === 'text') {
      if (!last.startedAt) last.startedAt = Date.now()
      if (model) last.extra = { ...(last.extra ?? {}), model }
    }
  }
  if (text) {
    stream._completionEstimated = (stream._completionEstimated ?? 0) + (text.length / 4)
    const newEstimatedVal = Math.round(stream._completionEstimated)
    const currentTurnTokens = Math.max(stream.usage.completionTokens - stream._completionBase, newEstimatedVal)
    stream.usage.completionTokens = stream._completionBase + currentTurnTokens
    stream.usage.totalTokens = stream.usage.promptTokens + stream.usage.completionTokens
  }
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

  if (TODO_MUTATING_TOOLS.has(d.name as string)) return
  const agent = d.agent as string
  ensureAgent(draft, agent)
  draft.agentStreams[agent].currentBlocks = appendToolOutput(
    draft.agentStreams[agent].currentBlocks,
    d.name as string,
    d.tool_call_id as string | undefined,
    d.text as string,
  )
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
        set((draft) => { draft.sessionId = d.session_id as string })
        break
      }

      case 'thinking':
      case 'message': {
        applySSEDeltaBatch(set, [{ type, data: d }])
        break
      }

      case 'tool_call': {
        if (TODO_MUTATING_TOOLS.has(d.name as string)) break
        const agent = d.agent as string
        set((draft) => {
          markTurnStarted(draft, agent)
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
        if (TODO_MUTATING_TOOLS.has(d.name as string)) break
        const agent = d.agent as string
        set((draft) => {
          markTurnStarted(draft, agent)
          draft.agentStreams[agent].currentBlocks = addTool(
            draft.agentStreams[agent].currentBlocks,
            d.name as string,
            d.arguments as string | undefined,
            d.tool_call_id as string | undefined,
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
        if (!TODO_MUTATING_TOOLS.has(toolName)) {
          set((draft) => {
            ensureAgent(draft, agent)
            draft.agentStreams[agent].currentBlocks = completeTool(
              draft.agentStreams[agent].currentBlocks,
              toolName,
              toolCallId,
              result,
              serverDurationMs,
              mcpApp ? { mcp_app: mcpApp } : undefined,
            )
          })
        }
        const events: CacheInvalidation[] = []
        if (FS_MUTATING_TOOLS.has(toolName)) {
          const workspace = get()._workspace
          if (workspace) {
            const stream = get().agentStreams[agent]
            const block = stream?.currentBlocks.find(
              (b) =>
                b.type === 'tool' &&
                (toolCallId ? b.toolCallId === toolCallId : b.toolName === toolName),
            )
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
          u.completionTokens = stream._completionBase + completionTokens
          u.cachedTokens     = cachedTokens ?? u.cachedTokens
          u.totalTokens      = u.promptTokens + u.completionTokens
          u.estimatedCostUsd = Math.round(((u.estimatedCostUsd ?? 0) + ((d.estimated_cost_usd as number) || 0)) * 1e8) / 1e8
          stream._completionEstimated = completionTokens
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
          draft.isContinuing = false
          draft.error = null
          draft.agentStreams[agent].status = 'working'
          const queued = draft._pendingMessages.filter((msg) => {
            if (msg.sessionId !== draft.sessionId) return false
            return messageIds === null || messageIds.has(msg.id)
          })
          const queuedIds = new Set(queued.map((msg) => msg.id))
          const messages = [
            ...queued.map((msg) => ({
              id: msg.id,
              content: msg.content,
              submittedAt: msg.submittedAt,
              attachments: msg.attachments,
            })),
            ...eventMessages
              .filter((msg) => !queuedIds.has(msg.id))
              .map((msg) => ({
                ...msg,
                submittedAt: Date.now(),
                attachments: undefined,
              })),
          ]
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
            draft.agentStreams[agent]._completionEstimated = 0
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
          if (status !== 'working') {
            draft.isTeamWorking = Object.values(draft.agentStreams).some(
              (s) => s.status === 'working',
            )
          }
        })
        break
      }

      case 'done': {
        set((draft) => {
          draft.isTeamWorking = false
          draft.isContinuing = false
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
              stream.blocks = [...stream.blocks, ...toCommit]
              stream.currentBlocks = []
            }
            stream._completionBase = stream.usage.completionTokens
            stream._completionEstimated = 0
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
          draft.isContinuing = false
        })
        break
      }

      case 'summarization_start': {
        const agent = d.agent as string
        if (!agent) break
        set((draft) => {
          ensureAgent(draft, agent)
          const stream = draft.agentStreams[agent]
          // Auto-compaction can start between model iterations, after this
          // turn has already streamed text/tools into currentBlocks. Seal
          // those blocks first so the divider lands at the actual trigger
          // point; subsequent deltas then remain after it.
          stream.blocks = startCompaction([...stream.blocks, ...stream.currentBlocks])
          stream.currentBlocks = []
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
          stream.blocks = endCompaction(stream.blocks, summary, error)
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
