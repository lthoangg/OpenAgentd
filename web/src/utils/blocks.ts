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
  // Defensive net at the render boundary: ids are stable identifiers now
  // (server message id for user blocks, message/toolCall-derived ids for
  // assistant sub-blocks — see parseTeamBlocks), so an id already present in
  // `blocks` can only mean the live copy is a stale duplicate of a row that
  // has since been confirmed. Drop it instead of trusting every upstream
  // reconciliation path (loadSession, reconcileTurnTail, the SSE reducer) to
  // have already removed it — this is the one place that actually renders.
  const confirmedIds = new Set(blocks.map((b) => b.id))
  const liveTail = currentBlocks.filter((b) => !confirmedIds.has(b.id))
  if (liveTail.length === 0) return blocks
  return [...blocks, ...liveTail]
}

export function latestDirectUserBlockId(blocks: ContentBlock[]): string | undefined {
  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i]
    if (block.type === 'user' && !block.extra?.from_agent) return block.id
  }
  return undefined
}

/** Check the live suffix first, then the stable finalized history. This avoids
 * scanning a merged session-sized array for every streamed delta. */
export function latestDirectUserBlockIdFromParts(
  blocks: ContentBlock[],
  currentBlocks: ContentBlock[],
): string | undefined {
  return latestDirectUserBlockId(currentBlocks) ?? latestDirectUserBlockId(blocks)
}

/** True when `incoming` is a reconnect replay of everything already in
 *  `existing` rather than the next live delta fragment. The backend resends
 *  the *whole* accumulated turn text as one chunk whenever a client
 *  (re)attaches mid-stream (memory_stream_store.attach) — a genuine live
 *  delta is a short new fragment that does not itself start with everything
 *  rendered so far. Blindly concatenating the replay (as a delta would)
 *  doubles the visible text on every reconnect; this is the "duplicate
 *  messages during streaming, fixed only by reload" failure mode.
 *
 *  Uses `>=`, not `>`: a reconnect with no new tokens generated since the
 *  disconnect replays a snapshot that is *exactly* equal to what the client
 *  already has, not longer — a strict `>` still doubles that case. */
function isReplaySnapshot(existing: string, incoming: string): boolean {
  return incoming.length >= existing.length && incoming.startsWith(existing)
}

export function appendThinking(
  blocks: ContentBlock[],
  text: string
): ContentBlock[] {
  const lastBlock = blocks[blocks.length - 1]

  if (lastBlock && lastBlock.type === 'thinking') {
    // Reconnect replay dedup — see isReplaySnapshot.
    const content = isReplaySnapshot(lastBlock.content, text) ? text : lastBlock.content + text
    return [
      ...blocks.slice(0, -1),
      {
        ...lastBlock,
        content,
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
    // Reconnect replay dedup — see isReplaySnapshot.
    const content = isReplaySnapshot(lastBlock.content, text) ? text : lastBlock.content + text
    return [
      ...blocks.slice(0, -1),
      {
        ...lastBlock,
        content,
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
      // Use the server-issued toolCallId as the block id when known — it's
      // already the stable identifier every reconciliation path matches on,
      // and parseTeamBlocks gives the eventual persisted tool block the same
      // id, so a live/confirmed duplicate becomes a real id collision that
      // mergeBlocks' render-boundary dedup can actually catch.
      id: toolCallId ?? generateBlockId(),
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
      id: toolCallId ?? generateBlockId(),
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
  serverDurationMs?: number,
  extra?: Record<string, unknown>,
  completedAt = Date.now(),
): ContentBlock[] {
  const result = [...blocks]

  // 1. Prefer exact match by toolCallId (handles same tool called multiple times)
  if (toolCallId) {
    for (let i = result.length - 1; i >= 0; i--) {
      const block = result[i]
      if (block.type === 'tool' && block.toolCallId === toolCallId) {
        // Me skip if already done — reconnect replay dedup
        if (block.toolDone) return result
        // Use client elapsed since first chunk so the frozen display matches
        // what the live timer was counting up. Server execution time is kept
        // separately as serverDurationMs for metrics.
        const clientElapsedMs = block.startedAt !== undefined
          ? Math.max(0, completedAt - block.startedAt)
          : undefined
        result[i] = {
          ...block,
          toolDone: true,
          toolResult,
          durationMs: clientElapsedMs ?? block.durationMs,
          serverDurationMs: serverDurationMs ?? block.serverDurationMs,
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
      const clientElapsedMs = block.startedAt !== undefined
        ? Math.max(0, completedAt - block.startedAt)
        : undefined
      result[i] = {
        ...block,
        toolDone: true,
        toolResult,
        durationMs: clientElapsedMs ?? block.durationMs,
        serverDurationMs: serverDurationMs ?? block.serverDurationMs,
        extra: extra ? { ...(block.extra ?? {}), ...extra } : block.extra,
      }
      return result
    }
  }

  return result
}

/** Trailing lines of live tool output retained for display. The live-output
 *  `<pre>` is capped at `max-h-40` (~7 lines) on mobile and `sm:max-h-64`
 *  (~12 lines) on desktop, so keeping more only buys invisible scrollback at
 *  the cost of a larger string to diff and repaint on every streamed delta.
 *  The full output arrives in `toolResult` when the tool completes.
 *  Mirrors `_LIVE_OUTPUT_MAX_LINES` in `app/agent/tools/builtin/shell.py`. */
export const LIVE_OUTPUT_MAX_LINES = 10

/** Max chars of live output retained — guards a single pathologically long
 *  line, which the line cap alone cannot bound. */
const LIVE_OUTPUT_MAX_CHARS = 24_000

/** Count newlines in `s`, stopping as soon as `limit` is reached. Used to
 *  cheaply answer "does this have more than N lines?" without allocating a
 *  full `split('\n')` array of the (potentially many-KB) live-output
 *  buffer on every streamed chunk. */
function countNewlinesAtLeast(s: string, limit: number): number {
  let count = 0
  let idx = -1
  while (count < limit) {
    idx = s.indexOf('\n', idx + 1)
    if (idx === -1) break
    count++
  }
  return count
}

/** Return the last `n` lines of `s` without materializing a `split('\n')`
 *  array of the whole string — walks backward with `lastIndexOf` to find
 *  the cut point, so cost scales with the retained tail, not the full
 *  (already-truncated-to-24000-char) buffer. */
function lastNLines(s: string, n: number): string {
  let idx = s.length
  for (let i = 0; i < n; i++) {
    idx = s.lastIndexOf('\n', idx - 1)
    if (idx === -1) return s
  }
  return s.slice(idx + 1)
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
      // lines.length > N  <=>  newlines_count + 1 > N  <=>  >= N newlines
      if (countNewlinesAtLeast(newOutput, LIVE_OUTPUT_MAX_LINES) >= LIVE_OUTPUT_MAX_LINES) {
        newOutput =
          '... [truncated live output] ...\n' + lastNLines(newOutput, LIVE_OUTPUT_MAX_LINES)
      }
      if (newOutput.length > LIVE_OUTPUT_MAX_CHARS) {
        newOutput = `... [truncated live output] ...\n${newOutput.slice(-LIVE_OUTPUT_MAX_CHARS)}`
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

/** summarization_start — append a fresh "compacting" divider block, or
 *  re-use an existing in-flight one. Idempotent against reconnect replay
 *  (the backend re-emits ``start`` whenever a subscriber attaches during
 *  compaction). */
export function startCompaction(blocks: ContentBlock[]): ContentBlock[] {
  if (blocks.some((block) => getCompactionState(block) === 'compacting')) {
    // Reconnect replay — block already exists, leave it alone.
    return blocks
  }
  return [
    ...blocks,
    {
      id: generateBlockId(),
      type: 'compaction',
      content: '',
      extra: { state: 'compacting' },
    },
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
