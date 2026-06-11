import type { ContentBlock } from '@/api/types'

export function generateBlockId(): string {
  return `block-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
}

export function mergeBlocks(
  blocks: ContentBlock[],
  currentBlocks: ContentBlock[],
): ContentBlock[] {
  if (currentBlocks.length === 0) return blocks
  if (blocks.length === 0) return currentBlocks
  return [...blocks, ...currentBlocks]
}

export function latestDirectUserBlockId(blocks: ContentBlock[]): string | undefined {
  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i]
    if (block.type === 'user' && !block.extra?.from_agent) return block.id
  }
  return undefined
}

export function appendThinking(
  blocks: ContentBlock[],
  text: string
): ContentBlock[] {
  const lastBlock = blocks[blocks.length - 1]

  if (lastBlock && lastBlock.type === 'thinking') {
    // Append to existing thinking block
    return [
      ...blocks.slice(0, -1),
      {
        ...lastBlock,
        content: lastBlock.content + text,
      },
    ]
  }

  // Create new thinking block
  return [
    ...blocks,
    {
      id: generateBlockId(),
      type: 'thinking',
      content: text,
    },
  ]
}

export function appendText(
  blocks: ContentBlock[],
  text: string
): ContentBlock[] {
  const lastBlock = blocks[blocks.length - 1]

  if (lastBlock && lastBlock.type === 'text') {
    // Append to existing text block
    return [
      ...blocks.slice(0, -1),
      {
        ...lastBlock,
        content: lastBlock.content + text,
      },
    ]
  }

  // Create new text block
  return [
    ...blocks,
    {
      id: generateBlockId(),
      type: 'text',
      content: text,
    },
  ]
}

/** tool_call event — first delta appearance, no args yet. Creates a pending card.
 *  If a block with this toolCallId already exists (reconnect replay), skip — no duplicate. */
export function initTool(
  blocks: ContentBlock[],
  name: string,
  toolCallId?: string,
  durationMs?: number,
): ContentBlock[] {
  // Me skip if already have block with same id — reconnect replay dedup
  if (toolCallId && blocks.some((b) => b.type === 'tool' && b.toolCallId === toolCallId)) {
    return blocks
  }
  return [
    ...blocks,
    {
      id: generateBlockId(),
      type: 'tool',
      content: '',
      toolName: name,
      toolArgs: undefined,
      toolDone: false,
      toolCallId,
      durationMs,
      startedAt: Date.now(),
    },
  ]
}

/** tool_start event — args assembled, execution starting. Fills in args on existing block.
 *  If block already has args (reconnect replay), skip the update — idempotent. */
export function addTool(
  blocks: ContentBlock[],
  name: string,
  args?: string,
  toolCallId?: string,
  durationMs?: number,
): ContentBlock[] {
  const result = [...blocks]
  // Find existing block by toolCallId first, then by name (no-args-yet pending)
  for (let i = result.length - 1; i >= 0; i--) {
    const block = result[i]
    if (
      block.type === 'tool' &&
      ((toolCallId && block.toolCallId === toolCallId) ||
        (!toolCallId && block.toolName === name && block.toolArgs === undefined))
    ) {
      // Me skip if args already set — reconnect replay dedup
      if (block.toolArgs !== undefined && block.toolArgs !== null) return result
      result[i] = {
        ...block,
        toolArgs: args,
        durationMs: durationMs ?? block.durationMs,
        startedAt: block.startedAt ?? Date.now(),
      }
      return result
    }
  }
  // Fallback: no matching block found (e.g. missed tool_call event) — create new
  return [
    ...blocks,
    {
      id: generateBlockId(),
      type: 'tool',
      content: '',
      toolName: name,
      toolArgs: args,
      toolDone: false,
      toolCallId,
      durationMs,
      startedAt: Date.now(),
    },
  ]
}

export function completeTool(
  blocks: ContentBlock[],
  name: string,
  toolCallId?: string,
  toolResult?: string,
  durationMs?: number,
  extra?: Record<string, unknown>,
): ContentBlock[] {
  const result = [...blocks]

  // 1. Prefer exact match by toolCallId (handles same tool called multiple times)
  if (toolCallId) {
    for (let i = result.length - 1; i >= 0; i--) {
      const block = result[i]
      if (block.type === 'tool' && block.toolCallId === toolCallId) {
        // Me skip if already done — reconnect replay dedup
        if (block.toolDone) return result
        result[i] = {
          ...block,
          toolDone: true,
          toolResult,
          durationMs: durationMs ?? block.durationMs,
          extra: extra ? { ...(block.extra ?? {}), ...extra } : block.extra,
        }
        return result
      }
    }
  }

  // 2. Fall back to last incomplete block matching by name
  for (let i = result.length - 1; i >= 0; i--) {
    const block = result[i]
    if (block.type === 'tool' && block.toolName === name && !block.toolDone) {
      result[i] = {
        ...block,
        toolDone: true,
        toolResult,
        durationMs: durationMs ?? block.durationMs,
        extra: extra ? { ...(block.extra ?? {}), ...extra } : block.extra,
      }
      return result
    }
  }

  return result
}

export function appendToolOutput(
  blocks: ContentBlock[],
  name: string,
  toolCallId: string | undefined,
  text: string,
): ContentBlock[] {
  const result = [...blocks]

  for (let i = result.length - 1; i >= 0; i--) {
    const block = result[i]
    if (
      block.type === 'tool' &&
      ((toolCallId && block.toolCallId === toolCallId) ||
        (!toolCallId && block.toolName === name && !block.toolDone))
    ) {
      let newOutput = `${block.toolOutput ?? ''}${text}`
      if (name === 'shell' || name === 'bash') {
        const lines = newOutput.split('\n')
        if (lines.length > 10) {
          newOutput = '... [truncated live output] ...\n' + lines.slice(-10).join('\n')
        }
      }
      result[i] = { ...block, toolOutput: newOutput }
      return result
    }
  }

  return blocks
}

/** Read ``state`` off a ``compaction`` block's ``extra`` bag. */
function getCompactionState(block: ContentBlock): 'compacting' | 'compacted' | null {
  if (block.type !== 'compaction') return null
  const state = block.extra?.state
  return state === 'compacting' || state === 'compacted' ? state : null
}

function findLastCompactionIndex(blocks: ContentBlock[]): number {
  for (let i = blocks.length - 1; i >= 0; i--) {
    if (blocks[i].type === 'compaction') return i
  }
  return -1
}

/** summarization_start — append a fresh "compacting" divider block, or
 *  re-use the trailing one if it's still in the ``compacting`` state.
 *  Idempotent against reconnect replay (the backend re-emits ``start``
 *  whenever a subscriber attaches mid-compaction). */
export function startCompaction(blocks: ContentBlock[]): ContentBlock[] {
  const lastCompactionIndex = findLastCompactionIndex(blocks)
  const lastCompaction = lastCompactionIndex >= 0 ? blocks[lastCompactionIndex] : undefined
  if (lastCompaction && getCompactionState(lastCompaction) === 'compacting') {
    // Reconnect replay — block already exists, leave it alone.
    return blocks
  }
  const compactionBlock: ContentBlock = {
    id: generateBlockId(),
    type: 'compaction',
    content: '',
    extra: { state: 'compacting' },
  }
  if (lastCompactionIndex < 0 || lastCompactionIndex === blocks.length - 1) {
    return [...blocks, compactionBlock]
  }
  return [
    ...blocks.slice(0, lastCompactionIndex + 1),
    compactionBlock,
    ...blocks.slice(lastCompactionIndex + 1),
  ]
}

/** summarization_content — append streaming summary text onto the most
 *  recent ``compacting`` block. If no such block exists (events out of
 *  order), drop the chunk silently. */
export function appendCompactionContent(
  blocks: ContentBlock[],
  text: string,
): ContentBlock[] {
  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i]
    if (getCompactionState(block) === 'compacting') {
      const result = [...blocks]
      result[i] = { ...block, content: block.content + text }
      return result
    }
  }
  return blocks
}

/** summarization_end — flip the trailing ``compacting`` block to
 *  ``compacted`` and overwrite its content with the final summary text
 *  (which supersedes any accumulated deltas). Creates a fresh block if
 *  one doesn't exist (defensive — e.g. on cold reconnect after end). */
export function endCompaction(
  blocks: ContentBlock[],
  summary: string,
  error: boolean,
): ContentBlock[] {
  const extra: Record<string, unknown> = { state: 'compacted' }
  if (error) extra.error = true

  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i]
    if (getCompactionState(block) === 'compacting') {
      const result = [...blocks]
      result[i] = {
        ...block,
        content: summary || block.content,
        extra,
      }
      return result
    }
  }
  // No in-flight block — synthesize a completed one so the divider still renders.
  return [
    ...blocks,
    {
      id: generateBlockId(),
      type: 'compaction',
      content: summary,
      extra,
    },
  ]
}
