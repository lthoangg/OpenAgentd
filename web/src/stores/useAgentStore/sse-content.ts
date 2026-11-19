/**
 * What a turn streams into its live blocks: text and thinking deltas, tool
 * cards from call to result, and the caches a finished tool makes stale.
 * Deltas are batched (``applySSEDeltaBatch``) so a burst costs one render.
 */
import {
  appendStreamedInto,
  initToolInto,
  addToolInto,
  appendToolOutputInto,
  completeToolInto,
  readBlocks,
} from '@/utils/blocks'
import type { ToolResultArrival } from '@/utils/blocks'
import { scriptRunOf } from '@/utils/script-run'
import {
  FS_MUTATING_TOOLS,
  PLAN_MUTATING_TOOLS,
  SCHEDULER_MUTATING_TOOLS,
  TODO_MUTATING_TOOLS,
  ensureAgent,
  extractToolPaths,
} from './helpers'
import { endAttachReplay } from './sse-turn'
import type { CacheInvalidation, AgentStore, StoreGet, StoreSet } from './types'
import { canonicalToolName } from '@/utils/tool-names'
import type { ContentBlock } from '@/api/types'

type BufferedTextKind = 'message' | 'thinking'

export type BufferedSSEDelta = {
  type: BufferedTextKind | 'tool_output_delta'
  data: Record<string, unknown>
}

export function isBufferedSSEDelta(type: string): type is BufferedSSEDelta['type'] {
  return type === 'message' || type === 'thinking' || type === 'tool_output_delta'
}

function markTurnStarted(draft: AgentStore, agent: string, startedAt = Date.now()) {
  ensureAgent(draft, agent)
  const stream = draft.agentStreams[agent]
  if (stream._turnStartedAt === undefined || stream._turnStartedAt === null) stream._turnStartedAt = startedAt
}

/** The ``model`` / ``thinking_level`` a live event names, as a block's ``extra``. */
function modelExtraFrom(model?: string | null, thinkingLevel?: string | null): Record<string, string> | null {
  return model ? { model, ...(thinkingLevel ? { thinking_level: thinkingLevel } : {}) } : null
}

function appendStreamingText(
  draft: AgentStore,
  agent: string,
  kind: BufferedTextKind,
  text: string,
  model?: string | null,
  thinkingLevel?: string | null,
) {
  const name = agent || draft.leadName || Object.keys(draft.agentStreams)[0] || 'openagentd'
  ensureAgent(draft, name)
  const stream = draft.agentStreams[name]
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
  const blockType = kind === 'thinking' ? 'thinking' : 'text'
  appendStreamedInto(stream.currentBlocks, blockType, text, replayPossible)
  const last = stream.currentBlocks[stream.currentBlocks.length - 1]
  if (last?.type !== blockType) return
  if (blockType === 'text' && !last.startedAt) last.startedAt = Date.now()
  // Thinking names the model too: a reply with no text still names it
  // under its prompt (see ``promptModels``).
  const modelExtra = modelExtraFrom(model, thinkingLevel)
  if (modelExtra) last.extra = { ...(last.extra ?? {}), ...modelExtra }
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
function findConfirmedTool(draft: AgentStore, agent: string, toolCallId: string | undefined): ContentBlock | undefined {
  if (!toolCallId) return undefined
  // Read-only: the session-sized rows are scanned without drafting each one.
  return readBlocks(draft.agentStreams[agent].blocks).find(
    (b) => b.type === 'tool' && b.toolCallId === toolCallId,
  )
}

function applyBufferedSSEDelta(draft: AgentStore, event: BufferedSSEDelta) {
  endAttachReplay(draft)
  const d = event.data
  const agentName = (d.agent as string) || draft.leadName || Object.keys(draft.agentStreams)[0] || 'openagentd'
  if (event.type === 'message' || event.type === 'thinking') {
    const metadata = d.metadata as Record<string, unknown> | undefined
    appendStreamingText(
      draft,
      agentName,
      event.type,
      d.text as string,
      typeof metadata?.model === 'string' ? metadata.model : null,
      typeof metadata?.thinking_level === 'string' ? metadata.thinking_level : null,
    )
    return
  }

  const agent = agentName
  const toolCallId = d.tool_call_id as string | undefined
  ensureAgent(draft, agent)
  const stream = draft.agentStreams[agent]
  if (appendToolOutputInto(stream.currentBlocks, d.name as string, toolCallId, d.text as string)) return
  // No live card — the tool may already sit in the confirmed rows (a mid-turn
  // loadSession reconciles the assistant row before its tools finish). Route
  // the delta there instead of dropping it; matched strictly by id so
  // orphaned history cards are never touched.
  const confirmed = findConfirmedTool(draft, agent, toolCallId)
  if (confirmed && !confirmed.toolDone) {
    appendToolOutputInto(stream.blocks, d.name as string, toolCallId, d.text as string)
  }
}

/** Apply a group of high-frequency text/tool-output deltas in one immer
 * transaction, producing a single Zustand subscriber notification. */
export function applySSEDeltaBatch(set: StoreSet, events: BufferedSSEDelta[]) {
  if (events.length === 0) return
  set((draft) => {
    for (const event of events) applyBufferedSSEDelta(draft, event)
  })
}

export function onToolCall(set: StoreSet, d: Record<string, unknown>) {
  set((draft) => {
    endAttachReplay(draft)
    const agent = (d.agent as string) || draft.leadName || Object.keys(draft.agentStreams)[0] || 'openagentd'
    markTurnStarted(draft, agent)
    // Replay after a mid-turn reconcile: the card already lives in the
    // confirmed rows — recreating it live would render a duplicate.
    if (findConfirmedTool(draft, agent, d.tool_call_id as string | undefined)) return
    const blocks = draft.agentStreams[agent].currentBlocks
    const added = initToolInto(
      blocks,
      d.name as string,
      d.tool_call_id as string | undefined,
      typeof d.duration_ms === 'number' ? d.duration_ms : undefined,
    )
    // A reply that only calls tools still names its model (see ``promptModels``).
    const meta = d.metadata as Record<string, unknown> | undefined
    const modelExtra = modelExtraFrom(
      typeof meta?.model === 'string' ? meta.model : null,
      typeof meta?.thinking_level === 'string' ? meta.thinking_level : null,
    )
    if (added && modelExtra) blocks[blocks.length - 1].extra = modelExtra
  })
}

export function onToolStart(set: StoreSet, d: Record<string, unknown>) {
  set((draft) => {
    endAttachReplay(draft)
    const agent = (d.agent as string) || draft.leadName || Object.keys(draft.agentStreams)[0] || 'openagentd'
    markTurnStarted(draft, agent)
    const toolCallId = d.tool_call_id as string | undefined
    // Mirrors addTool's own match condition.
    const hasLive = readBlocks(draft.agentStreams[agent].currentBlocks).some(
      (b) =>
        b.type === 'tool' &&
        (toolCallId
          ? b.toolCallId === toolCallId
          : b.toolName === (d.name as string) && b.toolArgs === undefined),
    )
    // Confirmed card already carries its args (persisted with the
    // assistant row) — don't let addTool's fallback spawn a duplicate.
    if (!hasLive && findConfirmedTool(draft, agent, toolCallId)) return
    addToolInto(
      draft.agentStreams[agent].currentBlocks,
      d.name as string,
      d.arguments as string | undefined,
      toolCallId,
      typeof d.duration_ms === 'number' ? d.duration_ms : undefined,
    )
  })
}

export function onToolEnd(set: StoreSet, get: StoreGet, d: Record<string, unknown>) {
  const agent = (d.agent as string) || get().leadName || Object.keys(get().agentStreams)[0] || 'openagentd'
  const toolName = d.name as string
  const toolCallId = d.tool_call_id as string | undefined
  const metadata = d.metadata as Record<string, unknown> | undefined
  const result = typeof d.result === 'string' ? d.result : undefined
  // Most tools' output stays on the server; the card fetches it on open.
  const arrival: ToolResultArrival = metadata?.result_omitted === true
    ? { omittedBytes: typeof metadata.result_bytes === 'number' ? metadata.result_bytes : 0, scriptRun: scriptRunOf(metadata.script_run) }
    : result
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
    const hasLive = readBlocks(stream.currentBlocks).some(
      (b) =>
        b.type === 'tool' &&
        ((toolCallId && b.toolCallId === toolCallId) ||
          (b.toolName === toolName && !b.toolDone)),
    )
    const confirmed = hasLive ? undefined : findConfirmedTool(draft, agent, toolCallId)
    if (confirmed && !confirmed.toolDone) {
      // Card was reconciled into the confirmed rows mid-turn — finish
      // it there or it stays "running" until a full reload.
      completeToolInto(
        stream.blocks,
        toolName,
        toolCallId,
        arrival,
        serverDurationMs,
        mcpApp ? { mcp_app: mcpApp } : undefined,
      )
      return
    }
    completeToolInto(
      stream.currentBlocks,
      toolName,
      toolCallId,
      arrival,
      serverDurationMs,
      mcpApp ? { mcp_app: mcpApp } : undefined,
    )
  })
  const stream = get().agentStreams[agent]
  const matchesEndedTool = (b: ContentBlock) =>
    b.type === 'tool' &&
    (toolCallId ? b.toolCallId === toolCallId : b.toolName === toolName)
  const block = FS_MUTATING_TOOLS.has(toolName)
    ? stream?.currentBlocks.find(matchesEndedTool) ?? stream?.blocks.find(matchesEndedTool)
    : undefined
  queueToolEndInvalidations(set, get, toolName, block?.toolArgs, result)
}

/**
 * A call a ``script`` made has ended. It has no card (the script's card
 * stands for it); only the caches a direct call would make stale refresh.
 */
export function onNestedToolEnd(set: StoreSet, get: StoreGet, d: Record<string, unknown>) {
  const toolName = d.name as string
  if (!toolName) return
  queueToolEndInvalidations(set, get, toolName, typeof d.arguments === 'string' ? d.arguments : undefined, undefined)
}

/** The caches a finished ``toolName`` call with ``toolArgs`` made stale. */
function queueToolEndInvalidations(
  set: StoreSet,
  get: StoreGet,
  toolName: string,
  toolArgs: string | undefined,
  result: string | undefined,
) {
  const events: CacheInvalidation[] = []
  if (FS_MUTATING_TOOLS.has(toolName)) {
    const workspace = get()._workspace
    if (workspace) {
      const paths = extractToolPaths(toolName, toolArgs)
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
  const tool = canonicalToolName(toolName)
  if (SCHEDULER_MUTATING_TOOLS.has(tool)) {
    events.push({ kind: 'scheduler' })
  }
  if (TODO_MUTATING_TOOLS.has(tool)) {
    const sid = get().sessionId
    if (sid) events.push({ kind: 'todos', sessionId: sid })
  }
  if (PLAN_MUTATING_TOOLS.has(toolName)) {
    const sid = get().sessionId
    if (sid) events.push({ kind: 'plan', sessionId: sid })
    // Starting a new plan drops the finished tasks from the board.
    if (sid && typeof result === 'string' && result.startsWith('Started a new plan')) events.push({ kind: 'todos', sessionId: sid })
  }
  if (tool === 'team' || tool.startsWith('team_')) {
    const sid = get().sessionId
    if (sid) events.push({ kind: 'subagents', sessionId: sid })
  }
  if (events.length > 0) {
    set((draft) => { draft.cacheInvalidations.push(...events) })
  }
}
