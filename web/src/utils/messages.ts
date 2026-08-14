import type { AgentUsage, ContentBlock, MessageResponse } from '@/api/types'

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
 */
export function sumUsageFromMessages(msgs: MessageResponse[]): AgentUsage {
  const acc = { promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedTokens: 0, estimatedCostUsd: 0 }
  let lastInput = 0
  let lastCache = 0
  for (const msg of sortMessages(msgs)) {
    if (msg.role !== 'assistant') continue
    const extra = msg.extra as { usage?: { input?: number; output?: number; cache?: number; cost?: { estimated_usd?: number } } } | null
    if (!extra?.usage) continue
    const i = extra.usage.input ?? 0
    const o = extra.usage.output ?? 0
    acc.completionTokens += o
    acc.estimatedCostUsd = Math.round((acc.estimatedCostUsd + (extra.usage.cost?.estimated_usd ?? 0)) * 1e8) / 1e8
    lastInput = i
    lastCache = extra.usage.cache ?? 0
  }
  acc.promptTokens = lastInput
  acc.cachedTokens = lastCache
  acc.totalTokens  = lastInput + acc.completionTokens
  return acc
}

/**
 * Parse DB messages into a flat ContentBlock[] — used by team agent/split view.
 * User messages → type:'user' block (rendered as user bubble inline)
 * Assistant messages → thinking/tool/text blocks
 * Tool result messages → mutate matching tool block
 */
export function parseTeamBlocks(msgs: MessageResponse[]): ContentBlock[] {
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
