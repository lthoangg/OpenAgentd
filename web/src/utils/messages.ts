import type { AgentUsage, ContentBlock, MessageResponse } from '@/api/types'

/**
 * A ``role='tool'`` result row whose matching assistant ``tool_calls`` row was
 * not in the same parsed batch.
 *
 * History fetches cut at arbitrary row boundaries — the pagination cursor can
 * split a call/result pair across pages, and a turn-tail delta can carry only
 * the result when a mid-turn reconcile already adopted the assistant row (it
 * is persisted before its tools finish). ``parseTeamBlocks`` used to drop such
 * rows silently, losing the result and leaving the card stuck "running".
 * Callers collect them here and attach via {@link applyOrphanToolResults}
 * once the owning card is in reach.
 */
export interface OrphanToolResult {
  content: string
  serverDurationMs?: number
  mcpApp?: Record<string, unknown>
}

// Me sort messages by timestamp asc, assistant before tool on ties

/** Legacy-row guard: pre-2026-05 summary rows had a hardcoded
 *  ``[Summary of earlier conversation]\n`` prefix on the body. The hook
 *  no longer emits it (see ``app/agent/hooks/summarization.py``) but
 *  old sessions still carry it — strip on read so the UI divider stays
 *  clean across legacy + new rows. */
function stripCompactionPrefix(content: string): string {
  const prefix = '[Summary of earlier conversation]\n'
  return content.startsWith(prefix) ? content.slice(prefix.length) : content
}

function sortMessages(msgs: MessageResponse[]): MessageResponse[] {
  const indexed = msgs.map((m, i) => ({ m, i }))
  indexed.sort((a, b) => {
    // seq is the canonical position (anchored rows — compaction summaries,
    // healed tool stubs — sit at their logical spot, not insertion time).
    // Fall back to created_at for locally-built messages that lack it.
    const sa = a.m.seq ?? 0
    const sb = b.m.seq ?? 0
    if (sa > 0 && sb > 0) {
      if (sa !== sb) return sa - sb
      if (a.m.id !== b.m.id) return a.m.id < b.m.id ? -1 : 1
      return a.i - b.i
    }
    const ta = a.m.created_at ? new Date(a.m.created_at).getTime() : 0
    const tb = b.m.created_at ? new Date(b.m.created_at).getTime() : 0
    if (ta !== tb) return ta - tb
    return a.i - b.i
  })
  return indexed.map((x) => x.m)
}

// Me extract ContentBlock[] from one assistant MessageResponse
function assistantBlocks(
  msg: MessageResponse,
  pendingToolBlocks: Map<string, ContentBlock>,
  timestamp?: Date,
): ContentBlock[] {
  const blocks: ContentBlock[] = []

  if (msg.reasoning_content) {
    blocks.push({ id: `${msg.id}:thinking`, type: 'thinking', content: msg.reasoning_content, timestamp })
  }

  const extra = msg.extra as { duration_ms?: number; model?: unknown } | null
  const responseDurationMs = typeof extra?.duration_ms === 'number' ? extra.duration_ms : undefined
  const model = typeof extra?.model === 'string' ? extra.model : undefined

  // Me text before tools — LLM emits content first, then tool_calls
  if (msg.content) {
    blocks.push({
      id: `${msg.id}:text`,
      type: 'text',
      content: msg.content,
      timestamp,
      responseDurationMs,
      extra: model ? { model } : undefined,
    })
  }

  for (const tool of msg.tool_calls ?? []) {
    const name = tool.function?.name ?? tool.id
    let args: string | undefined
    try {
      const parsed = JSON.parse(tool.function?.arguments ?? '{}')
      args = JSON.stringify(parsed, null, 2)
    } catch {
      args = tool.function?.arguments ?? undefined
    }
    const block: ContentBlock = {
      // The tool call's own id is already the stable toolCallId every other
      // reconciliation path (initTool/addTool/completeTool, findConfirmedTool,
      // isSameBlock) matches on — reuse it as the block id too instead of a
      // random one, and fall back to a message-derived id for the rare case
      // a tool call has none.
      id: tool.id || `${msg.id}:tool:${name}`,
      type: 'tool',
      content: '',
      toolName: name,
      toolArgs: args,
      toolCallId: tool.id,
      toolDone: false,
      timestamp,
    }
    blocks.push(block)
    if (tool.id) pendingToolBlocks.set(tool.id, block)
  }

  return blocks
}

/**
 * Aggregate token usage across all assistant messages in a list.
 * Rules: input = last turn, output = sum all turns, cache = last turn.
 * Reads from message.extra.usage persisted by DatabaseHook.
 *
 * Summary rows (``is_summary``, role user) carry the summariser call's usage —
 * a real, billed model call — so their output and cost accumulate too. When
 * a summary row is the newest message, its output defines the current input
 * context (the compacted size) so the user immediately sees the reduced usage.
 */
export function sumUsageFromMessages(msgs: MessageResponse[]): AgentUsage {
  const acc: AgentUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedTokens: 0, estimatedCostUsd: 0 }
  let lastInput = 0
  let lastCache = 0
  let lastCachePercent: number | undefined = undefined
  for (const msg of sortMessages(msgs)) {
    if (msg.role !== 'assistant' && !msg.is_summary) continue
    const extra = msg.extra as { usage?: { input?: number; output?: number; cache?: number; cache_percent?: number; cost?: { estimated_usd?: number }; estimated_cost_usd?: number }; estimated_cost_usd?: number } | null
    if (!extra?.usage) continue
    const o = extra.usage.output ?? 0
    const costUsd = extra.usage.cost?.estimated_usd ?? extra.usage.estimated_cost_usd ?? extra.estimated_cost_usd ?? 0
    acc.completionTokens += o
    acc.estimatedCostUsd = Math.round(((acc.estimatedCostUsd ?? 0) + costUsd) * 1e8) / 1e8
    const inputForCache = typeof extra.usage.input === 'number' && extra.usage.input > 0 ? extra.usage.input : 0
    const cacheTokens = typeof extra.usage.cache === 'number' ? extra.usage.cache : 0
    const calcPercent = typeof extra.usage.cache_percent === 'number'
      ? extra.usage.cache_percent
      : typeof extra.usage.cache === 'number'
      ? (inputForCache > 0 ? Math.round((cacheTokens / inputForCache) * 10000) / 100 : 0)
      : undefined
    if (msg.is_summary) {
      lastInput = extra.usage.output ?? 0
      lastCache = extra.usage.cache ?? 0
      lastCachePercent = calcPercent
    } else if (msg.role === 'assistant') {
      lastInput = extra.usage.input ?? 0
      lastCache = extra.usage.cache ?? 0
      lastCachePercent = calcPercent
    }
  }
  acc.promptTokens = lastInput
  acc.cachedTokens = lastCache
  acc.cachedPercent = lastCachePercent
  acc.totalTokens  = lastInput + acc.completionTokens
  return acc
}

/**
 * Parse DB messages into a flat ContentBlock[] — used by team agent/split view.
 * User messages → type:'user' block (rendered as user bubble inline)
 * Assistant messages → thinking/tool/text blocks
 * Tool result messages → mutate matching tool block
 *
 * ``orphanToolResults`` (optional): collector for tool result rows whose
 * assistant row is outside this batch — see {@link OrphanToolResult}. Without
 * it those rows are dropped, matching the old behavior.
 */
export function parseTeamBlocks(
  msgs: MessageResponse[],
  orphanToolResults?: Record<string, OrphanToolResult>,
): ContentBlock[] {
  const result: ContentBlock[] = []
  const pendingToolBlocks: Map<string, ContentBlock> = new Map()

  for (const msg of sortMessages(msgs)) {
    if (msg.extra?.queue_status === 'queued') continue

    // Summaries surface as inline "Session compacted" dividers rather than
    // being hidden — preserves the visual marker across page reloads.
    if (msg.is_summary) {
      const timestamp = msg.created_at ? new Date(msg.created_at) : new Date()
      result.push({
        id: msg.id,
        type: 'compaction',
        content: stripCompactionPrefix(msg.content || ''),
        extra: { state: 'compacted' },
        timestamp,
      })
      continue
    }

    if (msg.role === 'user') {
      // Me normalise DB extra: support both old (from_agents: string[]) and new (from_agent: string) formats
      const rawExtra = msg.extra as { routing?: { from_agent?: string; from_agents?: string[] }; from_agent?: string; from_agents?: string[] } | null
      const fromAgent = rawExtra?.from_agent ?? rawExtra?.routing?.from_agent ?? rawExtra?.from_agents?.[0] ?? rawExtra?.routing?.from_agents?.[0]
      const extra = { ...(msg.extra ?? {}) }
      if (fromAgent) extra.from_agent = fromAgent
      const timestamp = msg.created_at ? new Date(msg.created_at) : new Date()
      result.push({
        id: msg.id,
        type: 'user',
        content: msg.content || '',
        extra: Object.keys(extra).length > 0 ? extra : undefined,
        timestamp,
        attachments: msg.attachments ?? undefined,
      })
      continue
    }

    if (msg.role === 'tool' && msg.tool_call_id) {
      const block = pendingToolBlocks.get(msg.tool_call_id)
      const extra = msg.extra as { duration_ms?: number; mcp_app?: Record<string, unknown> } | null
      if (block) {
        block.toolResult = msg.content || ''
        block.toolDone = true
        if (typeof extra?.duration_ms === 'number') {
          // Persisted messages have no client startedAt, so server duration doubles
          // as the display value. Live sessions freeze durationMs from client elapsed.
          block.serverDurationMs = extra.duration_ms
          block.durationMs = extra.duration_ms
        }
        if (extra?.mcp_app) {
          block.extra = {
            ...(block.extra ?? {}),
            mcp_app: extra.mcp_app,
          }
        }
      } else if (orphanToolResults) {
        const orphan: OrphanToolResult = { content: msg.content || '' }
        if (typeof extra?.duration_ms === 'number') orphan.serverDurationMs = extra.duration_ms
        if (extra?.mcp_app) orphan.mcpApp = extra.mcp_app
        orphanToolResults[msg.tool_call_id] = orphan
      }
      continue
    }

    if (msg.role === 'assistant') {
      const timestamp = msg.created_at ? new Date(msg.created_at) : new Date()
      for (const block of assistantBlocks(msg, pendingToolBlocks, timestamp)) {
        result.push(block)
      }
    }
  }

  return result
}

/**
 * Complete incomplete tool cards in ``blocks`` from ``orphans``, consuming
 * every entry it applies (leftovers stay for a later batch to claim).
 *
 * Matched strictly by ``toolCallId`` and only onto cards that are not done —
 * a finished card keeps its own result, so a stale orphan can never overwrite
 * live state. Returns the original array untouched when nothing applies.
 */
export function applyOrphanToolResults(
  blocks: ContentBlock[],
  orphans: Record<string, OrphanToolResult>,
): ContentBlock[] {
  if (Object.keys(orphans).length === 0) return blocks
  let result: ContentBlock[] | null = null
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i]
    if (block.type !== 'tool' || block.toolDone || !block.toolCallId) continue
    const orphan = orphans[block.toolCallId]
    if (!orphan) continue
    if (result === null) result = [...blocks]
    result[i] = {
      ...block,
      toolDone: true,
      toolResult: orphan.content,
      ...(orphan.serverDurationMs !== undefined
        ? { serverDurationMs: orphan.serverDurationMs, durationMs: orphan.serverDurationMs }
        : {}),
      ...(orphan.mcpApp ? { extra: { ...(block.extra ?? {}), mcp_app: orphan.mcpApp } } : {}),
    }
    delete orphans[block.toolCallId]
  }
  return result ?? blocks
}
