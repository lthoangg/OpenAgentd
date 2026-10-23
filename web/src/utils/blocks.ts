import { current, isDraft } from 'immer'
import type { ContentBlock } from '@/api/types'

export function generateBlockId(): string {
  return `block-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
}

/**
 * The plain array behind ``blocks``, for read-only scans inside an Immer
 * recipe. Reading a draft array element by element (``find``, ``some``, a
 * loop, a spread) creates a child draft per block, so a scan over a long
 * session cost ~1 ms each. An unmodified draft hands back its base array
 * as is; a modified one, an exact snapshot. The elements are frozen: write
 * through ``blocks`` (``blocks[i] = …``), never through the result.
 */
export function readBlocks(blocks: ContentBlock[]): readonly ContentBlock[] {
  return isDraft(blocks) ? current(blocks) : blocks
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

export function confirmedIdSet(blocks: ContentBlock[]): Set<string> {
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
 * parseAgentBlocks), so an id already present in `blocks` can only mean the
 * live copy is a stale duplicate of a row that has since been confirmed.
 * Drop it instead of trusting every upstream reconciliation path
 * (loadSession, reconcileTurnTail, the SSE reducer) to have already removed
 * it. A user bubble is also matched by text, but only while it still carries
 * its optimistic `user-<ts>` id (the POST has not answered): one with a
 * server id is matched by id alone, or a steer repeating an earlier message
 * ("continue", "yes") vanished from the transcript while its turn ran.
 */
export function liveBlockTail(
  blocks: ContentBlock[],
  currentBlocks: ContentBlock[],
): ContentBlock[] {
  if (currentBlocks.length === 0 || blocks.length === 0) return currentBlocks
  const confirmedIds = confirmedIdSet(blocks)
  return currentBlocks.filter((b) => {
    if (confirmedIds.has(b.id)) return false
    if (b.type === 'user' && b.id.startsWith('user-')) {
      const existsInConfirmed = blocks.some(
        (confirmed) =>
          confirmed.type === 'user' &&
          confirmed.content === b.content &&
          (confirmed.extra?.from_agent ?? '') === (b.extra?.from_agent ?? ''),
      )
      if (existsInConfirmed) return false
    }
    return true
  })
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

/**
 * Blocks after ``id`` that render something; ``null`` once ``id`` is gone.
 * Scans from the end, so the cost is the number of blocks counted. ``liveTail``
 * follows ``blocks``, so callers need not merge the two to count across them.
 */
export function countBlocksAfter(blocks: ContentBlock[], id: string, liveTail: ContentBlock[] = []): number | null {
  let count = 0
  for (const part of [liveTail, blocks]) {
    for (let i = part.length - 1; i >= 0; i -= 1) {
      const block = part[i]
      if (block.id === id) return count
      const blank = (block.type === 'text' || block.type === 'thinking') && block.content.trim().length === 0
      if (!blank) count += 1
    }
  }
  return null
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
 * Merge a streamed `text`/`thinking` chunk into `blocks`, in place.
 *
 * `blocks` may be an Immer draft: only the touched block is read through it
 * and replaced by index, so a delta never drafts the rest of the turn. The
 * blocks themselves are never mutated, which keeps this safe on a plain copy
 * of frozen state too (see `appendText`).
 */
export function appendStreamedInto(
  blocks: ContentBlock[],
  type: 'text' | 'thinking',
  text: string,
  replayPossible: boolean,
): void {
  const lastIdx = blocks.length - 1
  const last = blocks[lastIdx]

  // Common case: keep filling the open block of this kind.
  if (last && last.type === type) {
    blocks[lastIdx] = {
      ...last,
      content: replayPossible && isReplaySnapshot(last.content, text) ? text : last.content + text,
    }
    return
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
    const view = readBlocks(blocks)
    for (let i = lastIdx; i >= 0; i--) {
      const block = view[i]
      // A user block ends the turn the snapshot describes — never reach past it.
      if (block.type === 'user') break
      if (block.type !== type) continue
      if (!isReplaySnapshot(block.content, text)) break
      blocks[i] = { ...block, content: text }
      return
    }
  }

  blocks.push({ id: generateBlockId(), type, content: text })
}

export function appendThinking(
  blocks: ContentBlock[],
  text: string,
  replayPossible = false,
): ContentBlock[] {
  const next = [...blocks]
  appendStreamedInto(next, 'thinking', text, replayPossible)
  return next
}

export function appendText(
  blocks: ContentBlock[],
  text: string,
  replayPossible = false,
): ContentBlock[] {
  const next = [...blocks]
  appendStreamedInto(next, 'text', text, replayPossible)
  return next
}

/** tool_call event — first delta appearance, no args yet. Creates a pending card.
 *  If a block with this toolCallId already exists (reconnect replay), skip — no duplicate.
 *
 *  The ``…Into`` variants of the tool helpers change ``blocks`` in place and
 *  report whether anything changed. They run against Immer drafts: the scan
 *  reads the plain array (``readBlocks``) and only the touched card is
 *  replaced by index (or pushed), so a tool event never drafts the whole turn
 *  or session. The plain-named versions are copy-on-write wrappers that
 *  return the original array when nothing changed. */
export function initToolInto(
  blocks: ContentBlock[],
  name: string,
  toolCallId?: string,
  durationMs?: number,
): boolean {
  // Me skip if already have block with same id — reconnect replay dedup
  if (toolCallId && readBlocks(blocks).some((b) => b.type === 'tool' && b.toolCallId === toolCallId)) {
    return false
  }
  blocks.push({
    // Use the server-issued toolCallId as the block id when known — it's
    // already the stable identifier every reconciliation path matches on,
    // and parseAgentBlocks gives the eventual persisted tool block the same
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
  })
  return true
}

export function initTool(
  blocks: ContentBlock[],
  name: string,
  toolCallId?: string,
  durationMs?: number,
): ContentBlock[] {
  const next = [...blocks]
  return initToolInto(next, name, toolCallId, durationMs) ? next : blocks
}

/** tool_start event — args assembled, execution starting. Fills in args on existing block.
 *  If block already has args (reconnect replay), skip the update — idempotent.
 *  See ``initToolInto``. */
export function addToolInto(
  blocks: ContentBlock[],
  name: string,
  args?: string,
  toolCallId?: string,
  durationMs?: number,
): boolean {
  // Find existing block by toolCallId first, then by name (no-args-yet pending).
  const view = readBlocks(blocks)
  for (let i = view.length - 1; i >= 0; i--) {
    const block = view[i]
    if (
      block.type === 'tool' &&
      ((toolCallId && block.toolCallId === toolCallId) ||
        (!toolCallId && block.toolName === name && block.toolArgs === undefined))
    ) {
      // Me skip if args already set — reconnect replay dedup
      if (block.toolArgs !== undefined && block.toolArgs !== null) return false
      blocks[i] = {
        ...block,
        toolArgs: args,
        durationMs: durationMs ?? block.durationMs,
        startedAt: block.startedAt ?? Date.now(),
      }
      return true
    }
  }
  // Fallback: no matching block found (e.g. missed tool_call event) — create new
  blocks.push({
    id: toolCallId ?? generateBlockId(),
    type: 'tool',
    content: '',
    toolName: name,
    toolArgs: args,
    toolDone: false,
    toolCallId,
    durationMs,
    startedAt: Date.now(),
  })
  return true
}

export function addTool(
  blocks: ContentBlock[],
  name: string,
  args?: string,
  toolCallId?: string,
  durationMs?: number,
): ContentBlock[] {
  const next = [...blocks]
  return addToolInto(next, name, args, toolCallId, durationMs) ? next : blocks
}

function completedTool(
  block: ContentBlock,
  toolResult: string | undefined,
  serverDurationMs: number | undefined,
  extra: Record<string, unknown> | undefined,
  completedAt: number,
): ContentBlock {
  // Use client elapsed since first chunk so the frozen display matches
  // what the live timer was counting up. Server execution time is kept
  // separately as serverDurationMs for metrics.
  const clientElapsedMs = block.startedAt !== undefined
    ? Math.max(0, completedAt - block.startedAt)
    : undefined
  return {
    ...block,
    toolDone: true,
    toolResult,
    durationMs: clientElapsedMs ?? block.durationMs,
    serverDurationMs: serverDurationMs ?? block.serverDurationMs,
    extra: extra ? { ...(block.extra ?? {}), ...extra } : block.extra,
  }
}

/** tool_end event — the call finished. See ``initToolInto``. */
export function completeToolInto(
  blocks: ContentBlock[],
  name: string,
  toolCallId?: string,
  toolResult?: string,
  serverDurationMs?: number,
  extra?: Record<string, unknown>,
  completedAt = Date.now(),
): boolean {
  const view = readBlocks(blocks)
  // 1. Prefer exact match by toolCallId (handles same tool called multiple times)
  if (toolCallId) {
    for (let i = view.length - 1; i >= 0; i--) {
      const block = view[i]
      if (block.type === 'tool' && block.toolCallId === toolCallId) {
        // Me skip if already done — reconnect replay dedup
        if (block.toolDone) return false
        blocks[i] = completedTool(block, toolResult, serverDurationMs, extra, completedAt)
        return true
      }
    }
  }

  // 2. Fall back to last incomplete block matching by name
  for (let i = view.length - 1; i >= 0; i--) {
    const block = view[i]
    if (block.type === 'tool' && block.toolName === name && !block.toolDone) {
      blocks[i] = completedTool(block, toolResult, serverDurationMs, extra, completedAt)
      return true
    }
  }

  return false
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
  const next = [...blocks]
  return completeToolInto(next, name, toolCallId, toolResult, serverDurationMs, extra, completedAt) ? next : blocks
}

/** Trailing lines of live tool output retained for display.
 *  Mirrors `_LIVE_OUTPUT_MAX_LINES` in `app/agent/tools/builtin/shell.py`. */
export const LIVE_OUTPUT_MAX_LINES = 100

/** Max chars of live output retained — guards a single pathologically long
 *  line, which the line cap alone cannot bound. */
export const LIVE_OUTPUT_MAX_CHARS = 100_000

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

/** Index of the card a streamed output delta belongs to, newest first; -1 if none. */
function toolOutputTarget(
  blocks: readonly ContentBlock[],
  name: string,
  toolCallId: string | undefined,
): number {
  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i]
    if (
      block.type === 'tool' &&
      ((toolCallId && block.toolCallId === toolCallId) ||
        (!toolCallId && block.toolName === name && !block.toolDone))
    ) {
      return i
    }
  }
  return -1
}

function withToolOutput(block: ContentBlock, text: string): ContentBlock {
  let newOutput = `${block.toolOutput ?? ''}${text}`
  // lines.length > N  <=>  newlines_count + 1 > N  <=>  >= N newlines
  if (countNewlinesAtLeast(newOutput, LIVE_OUTPUT_MAX_LINES) >= LIVE_OUTPUT_MAX_LINES) {
    newOutput =
      '... [truncated live output] ...\n' + lastNLines(newOutput, LIVE_OUTPUT_MAX_LINES)
  }
  if (newOutput.length > LIVE_OUTPUT_MAX_CHARS) {
    newOutput = `... [truncated live output] ...\n${newOutput.slice(-LIVE_OUTPUT_MAX_CHARS)}`
  }
  return { ...block, toolOutput: newOutput }
}

/**
 * Append a streamed output delta to its tool card, in place; `false` when no
 * card matches. Runs per output delta, a second time against the
 * (session-sized) confirmed `blocks` when the live lookup misses, so the scan
 * reads the plain array (`readBlocks`) and only the matched card is replaced.
 */
export function appendToolOutputInto(
  blocks: ContentBlock[],
  name: string,
  toolCallId: string | undefined,
  text: string,
): boolean {
  const view = readBlocks(blocks)
  const i = toolOutputTarget(view, name, toolCallId)
  if (i < 0) return false
  blocks[i] = withToolOutput(view[i], text)
  return true
}

/** Copy-on-write `appendToolOutputInto`: the original array when nothing matched. */
export function appendToolOutput(
  blocks: ContentBlock[],
  name: string,
  toolCallId: string | undefined,
  text: string,
): ContentBlock[] {
  const i = toolOutputTarget(blocks, name, toolCallId)
  if (i < 0) return blocks
  const result = [...blocks]
  result[i] = withToolOutput(blocks[i], text)
  return result
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
 *  compaction). ``forced``: a ``/compact`` or idle compaction, which the
 *  transcript shows apart from the reply before it (see ``utils/turns.ts``). */
export function startCompaction(blocks: ContentBlock[], forced = false): ContentBlock[] {
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
      extra: forced ? { state: 'compacting', forced: true } : { state: 'compacting' },
    },
  ]
}

/** summarization_content — append streaming summary text onto the most
 *  recent ``compacting`` block. If no such block exists (events out of
 *  order), drop the chunk silently. */
/**
 * Append a streamed summary chunk to the in-flight compaction divider, in
 * place; ``false`` when there is none. It runs per summary token against the
 * confirmed ``blocks``, which compaction only ever meets at their longest, so
 * like ``appendToolOutputInto`` it scans the plain array and replaces one block.
 */
export function appendCompactionContentInto(blocks: ContentBlock[], text: string): boolean {
  const view = readBlocks(blocks)
  for (let i = view.length - 1; i >= 0; i--) {
    const block = view[i]
    if (getCompactionState(block) === 'compacting') {
      blocks[i] = { ...block, content: block.content + text }
      return true
    }
  }
  return false
}

export function appendCompactionContent(
  blocks: ContentBlock[],
  text: string,
): ContentBlock[] {
  const next = [...blocks]
  return appendCompactionContentInto(next, text) ? next : blocks
}

/** summarization_end — flip the trailing ``compacting`` block to
 *  ``compacted`` and overwrite its content with the final summary text
 *  (which supersedes any accumulated deltas). Creates a fresh block if
 *  one doesn't exist (defensive — e.g. on cold reconnect after end). */
export function endCompaction(
  blocks: ContentBlock[],
  summary: string,
  error: boolean,
  forced = false,
): ContentBlock[] {
  const extra: Record<string, unknown> = { state: 'compacted' }
  if (error) extra.error = true

  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i]
    if (getCompactionState(block) === 'compacting') {
      const result = [...blocks]
      if (forced || block.extra?.forced === true) extra.forced = true
      result[i] = {
        ...block,
        content: summary || block.content,
        extra,
      }
      return result
    }
  }
  // No in-flight block — synthesize a completed one so the divider still renders.
  if (forced) extra.forced = true
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
