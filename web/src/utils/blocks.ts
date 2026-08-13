import type { ContentBlock } from '@/api/types'

export function generateBlockId(): string {
  return `block-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
}

/** Cache of confirmed-block-id sets, keyed on the `blocks` array identity.
 *
 * `mergeBlocks` runs on every render, and during streaming that means once per
 * ~16ms delta batch — with `blocks` (the finalized history) unchanged and only
 * `currentBlocks` growing. Rebuilding the id set each time made every streamed
 * frame cost O(session length). The store replaces `blocks` by reference
 * whenever it actually changes (immer copy-on-write), so array identity is a
 * sound cache key, and a WeakMap lets superseded arrays be collected. */
const confirmedIdCache = new WeakMap<ContentBlock[], Set<string>>()

function confirmedIdSet(blocks: ContentBlock[]): Set<string> {
  const cached = confirmedIdCache.get(blocks)
  if (cached) return cached
  const ids = new Set(blocks.map((b) => b.id))
  confirmedIdCache.set(blocks, ids)
  return ids
}

/**
 * The live suffix of `currentBlocks` not yet folded into `blocks` — the
 * part `mergeBlocks` appends. Exposed separately so callers that only need
 * counts or the last block (scroll bookkeeping, turn partitioning) can
 * derive them without allocating a copy of the full — potentially
 * session-length — `blocks` array on every streamed delta.
 *
 * Defensive dedup: ids are stable identifiers now (server message id for
 * user blocks, message/toolCall-derived ids for assistant sub-blocks — see
 * parseTeamBlocks), so an id already present in `blocks` can only mean the
 * live copy is a stale duplicate of a row that has since been confirmed.
 * Drop it instead of trusting every upstream reconciliation path
 * (loadSession, reconcileTurnTail, the SSE reducer) to have already removed
 * it.
 */
export function liveBlockTail(
  blocks: ContentBlock[],
  currentBlocks: ContentBlock[],
): ContentBlock[] {
  if (currentBlocks.length === 0 || blocks.length === 0) return currentBlocks
  const confirmedIds = confirmedIdSet(blocks)
  return currentBlocks.filter((b) => !confirmedIds.has(b.id))
}

export function mergeBlocks(
  blocks: ContentBlock[],
  currentBlocks: ContentBlock[],
): ContentBlock[] {
  if (currentBlocks.length === 0) return blocks
  if (blocks.length === 0) return currentBlocks
  const liveTail = liveBlockTail(blocks, currentBlocks)
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

/**
 * True when `incoming` is a reconnect replay of everything already in
 * `existing` rather than the next live delta fragment.
 *
 * The backend resends the *whole* accumulated turn text as one chunk when a
 * client (re)attaches mid-stream (`memory_stream_store.attach` emits at most
 * one `ThinkingEvent` and one `MessageEvent` per agent, each a full snapshot,
 * before any live events). Blindly concatenating that replay doubles the
 * visible text — the "duplicate messages during streaming, fixed only by
 * reload" failure mode.
 *
 * Uses `>=`, not `>`: a reconnect with no new tokens generated since the
 * disconnect replays a snapshot *exactly* equal to what the client already
 * has, not longer — a strict `>` still doubles that case.
 *
 * IMPORTANT: this test is only sound when a replay is actually possible.
 * A prefix match is ambiguous — a genuine delta can also start with the
 * accumulated content (`"-"` + `"-"`, `"*"` + `"*"`, `"\n"` + `"\n"` …), and
 * treating those as replays silently *drops* real tokens, corrupting the
 * rendered markdown. Callers must therefore pass `replayPossible` and only
 * set it for the first chunk of each kind after an attach. See
 * `appendStreamingText` in `sse-reducer.ts`.
 */
function isReplaySnapshot(existing: string, incoming: string): boolean {
  return incoming.length >= existing.length && incoming.startsWith(existing)
}

/**
 * Merge a streamed `text`/`thinking` chunk into `blocks`.
 *
 * Shared by `appendText` and `appendThinking` — the two differ only in the
 * block type they accumulate into.
 */
function appendStreamed(
  blocks: ContentBlock[],
  type: 'text' | 'thinking',
  text: string,
  replayPossible: boolean,
): ContentBlock[] {
  const lastIdx = blocks.length - 1
  const last = blocks[lastIdx]

  // Common case: keep filling the open block of this kind.
  if (last && last.type === type) {
    const next = [...blocks]
    next[lastIdx] = {
      ...last,
      content: replayPossible && isReplaySnapshot(last.content, text) ? text : last.content + text,
    }
    return next
  }

  // Attach replay whose snapshot belongs to an *earlier* block of this kind in
  // the same turn. The backend replays the full accumulated thinking and the
  // full accumulated content as one chunk each, but a turn that emitted
  // thinking and then text ends with a `text` block — so the thinking snapshot
  // finds the wrong block type at the tail. Appending it there duplicated the
  // whole turn on every mid-turn reconnect (the dedup above could never fire).
  // Rewriting the matching block in place is only safe because `replayPossible`
  // marks a real attach: during live streaming a thinking chunk arriving after
  // text is a legitimately *new* reasoning block and must not be merged back.
  if (replayPossible) {
    for (let i = lastIdx; i >= 0; i--) {
      const block = blocks[i]
      // A user block ends the turn the snapshot describes — never reach past it.
      if (block.type === 'user') break
      if (block.type !== type) continue
      if (!isReplaySnapshot(block.content, text)) break
      const next = [...blocks]
      next[i] = { ...block, content: text }
      return next
    }
  }

  return [...blocks, { id: generateBlockId(), type, content: text }]
}

export function appendThinking(
  blocks: ContentBlock[],
  text: string,
  replayPossible = false,
): ContentBlock[] {
  return appendStreamed(blocks, 'thinking', text, replayPossible)
}

export function appendText(
  blocks: ContentBlock[],
  text: string,
  replayPossible = false,
): ContentBlock[] {
  return appendStreamed(blocks, 'text', text, replayPossible)
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
      // liveBlockTail's render-boundary dedup can actually catch.
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
  // Find existing block by toolCallId first, then by name (no-args-yet pending).
  // Copy-on-write: these helpers run against an immer draft, where spreading the
  // array materialises a proxy per element. Copying up front charged that O(n)
  // cost even on the replay-dedup and no-match paths, which change nothing.
  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i]
    if (
      block.type === 'tool' &&
      ((toolCallId && block.toolCallId === toolCallId) ||
        (!toolCallId && block.toolName === name && block.toolArgs === undefined))
    ) {
      // Me skip if args already set — reconnect replay dedup
      if (block.toolArgs !== undefined && block.toolArgs !== null) return blocks
      const result = [...blocks]
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
  // Copy-on-write — see addTool.
  // 1. Prefer exact match by toolCallId (handles same tool called multiple times)
  if (toolCallId) {
    for (let i = blocks.length - 1; i >= 0; i--) {
      const block = blocks[i]
      if (block.type === 'tool' && block.toolCallId === toolCallId) {
        // Me skip if already done — reconnect replay dedup
        if (block.toolDone) return blocks
        // Use client elapsed since first chunk so the frozen display matches
        // what the live timer was counting up. Server execution time is kept
        // separately as serverDurationMs for metrics.
        const clientElapsedMs = block.startedAt !== undefined
          ? Math.max(0, completedAt - block.startedAt)
          : undefined
        const result = [...blocks]
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
  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i]
    if (block.type === 'tool' && block.toolName === name && !block.toolDone) {
      const clientElapsedMs = block.startedAt !== undefined
        ? Math.max(0, completedAt - block.startedAt)
        : undefined
      const result = [...blocks]
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

  return blocks
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
  // Copy-on-write matters most here: this runs per streamed output delta, and
  // the reducer calls it a second time against the (session-sized) confirmed
  // `blocks` whenever the live lookup misses. Returning the original reference
  // on a miss is also load-bearing — `applyBufferedSSEDelta` uses identity to
  // detect "no live card matched".
  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i]
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
      const result = [...blocks]
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
