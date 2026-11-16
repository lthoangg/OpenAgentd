/**
 * Lining the live blocks up with a history snapshot that may already hold
 * some of them: which live blocks the snapshot covers (by position for a
 * finished turn, by content for a running one), and which ids a just-finished
 * turn keeps so it is not remounted.
 */
import { readBlocks } from '@/utils/blocks'
import { adoptLiveBlockIds, revokeBlobUrlsFromBlocks } from './helpers'
import type { AgentStream } from './types'
import type { ContentBlock } from '@/api/types'

/**
 * Give a freshly loaded page the ids of the live blocks it now confirms
 * (``adoptLiveBlockIds``), so a just-finished turn is not remounted.
 * Assigns only when an id moved, keeping an untouched page's array.
 */
export function keepLiveIds(stream: AgentStream, shownBefore: readonly ContentBlock[] | undefined) {
  if (!shownBefore || shownBefore.length === 0) return
  const loaded = readBlocks(stream.blocks)
  const inUse = new Set(readBlocks(stream.currentBlocks).map((b) => b.id))
  const adopted = adoptLiveBlockIds(shownBefore, loaded, inUse)
  if (adopted !== loaded) stream.blocks = adopted as ContentBlock[]
}

// A `loadSession()` fetch reflects a DB snapshot taken when it started. If a
// new turn is optimistically appended (sendMessage) or streamed in (SSE
// deltas) to `currentBlocks` *while the fetch is in flight* — e.g. a
// background reconciliation from the global `session_turn_completed` event,
// a foreground-resume resync, or a stale workspace re-render — that
// content postdates the snapshot and will not appear in `history` yet.
// Unconditionally clearing `currentBlocks` on resolve would then discard it
// permanently (nothing replays it back unless the caller also reconnects
// the stream), producing a visible "reload" flash where the just-sent
// message and/or in-progress streamed text vanish even though the turn is
// still running. Detect that case so the caller can preserve the newer
// local state instead of clobbering it with the stale fetch.
export function hasLiveContent(stream: AgentStream | undefined, isWorking: boolean, sinceMs: number): boolean {
  if (!stream) return false
  if (stream.currentBlocks.length === 0) return false
  if (isWorking || stream.status === 'working' || stream._turnStartedAt !== null) return true
  return stream.currentBlocks.some((block) => {
    if (block.type === 'tool' && !block.toolDone) return true
    if (!block.timestamp) return true
    return block.timestamp.getTime() >= sinceMs
  })
}

/**
 * Drop live blocks the server's snapshot already covers, keeping only those
 * appended while the fetch was in flight.
 *
 * Only called once the server reports the turn finished: everything persisted
 * by then is in the canonical rows we just installed, so the sole live blocks
 * still worth keeping are the ones that arrived afterwards. Without this the
 * preserve branch is all-or-nothing — one genuinely new block would keep the
 * whole stale tail and let `done` commit it a second time.
 *
 * Positional rather than timestamp-based because streamed assistant blocks
 * carry no timestamp until `done` stamps them, so a time filter would discard
 * exactly the new content it is meant to protect. `currentBlocks` only ever
 * grows within a turn (text appends mutate the last entry in place), and if it
 * was drained mid-fetch the slice simply yields nothing.
 */
export function dropSnapshotCoveredBlocks(stream: AgentStream, countAtFetchStart: number) {
  const covered = stream.currentBlocks.slice(0, countAtFetchStart)
  // These are leaving the store for good; the canonical rows carry server URLs.
  revokeBlobUrlsFromBlocks(covered)
  stream.currentBlocks = stream.currentBlocks.slice(countAtFetchStart)
}

/** Same block from two sources: the live SSE copy and the server's parse. */
function isSameBlock(live: ContentBlock, persisted: ContentBlock): boolean {
  if (live.type !== persisted.type) return false
  if (live.id && persisted.id && live.id === persisted.id) return true

  // If both blocks have timestamps, prevent matching live blocks against
  // persisted blocks from an older turn (older than 5s clock skew window).
  const liveTime = live.timestamp?.getTime()
  const persistedTime = persisted.timestamp?.getTime()
  if (liveTime !== undefined && persistedTime !== undefined && persistedTime < liveTime - 5_000) {
    return false
  }

  // Tool calls carry a server-issued id, so match on it and ignore content
  // (live output is streamed incrementally and may lag the persisted result).
  if (live.toolCallId || persisted.toolCallId) return live.toolCallId === persisted.toolCallId
  if (live.extra?.from_agent || persisted.extra?.from_agent) {
    return live.content === persisted.content && (live.extra?.from_agent ?? '') === (persisted.extra?.from_agent ?? '')
  }
  return live.content === persisted.content
}

/** Live-only or lossy block types that may lack a persisted counterpart:
 *  provider notices never persist, and reasoning is often summarized,
 *  redacted, or dropped entirely by the provider. */
function isEphemeralLive(block: ContentBlock): boolean {
  return block.type === 'thinking' || block.type === 'provider_status'
}

/** How many of a stream's live blocks a history snapshot can already cover.
 *
 *  `liveCountAtFetch` was sampled when the fetch started. If the stream's
 *  current turn began *after* that sample, the snapshot cannot describe any of
 *  it, so the caller's `turnStartedAfterFetch` value applies instead — `0`
 *  when the turn is over (nothing to drop) or the full live length when it is
 *  still running (the whole prefix is newer than the snapshot). */
export function snapshotCoverableCount(
  stream: AgentStream,
  fetchStartedAt: number,
  liveCountAtFetch: number,
  turnStartedAfterFetch: number,
): number {
  const turnStartedAt = stream._turnStartedAt
  return turnStartedAt != null && turnStartedAt >= fetchStartedAt
    ? turnStartedAfterFetch
    : liveCountAtFetch
}

/**
 * Drop the leading live blocks a *still-running* turn's snapshot already
 * covers.
 *
 * While the turn runs, the snapshot holds only the model iterations the server
 * has already persisted — the in-flight tail is not there yet, so the
 * positional drop used for finished turns would erase live content and blank
 * out mid-stream text. Align on content within the active turn: in `stream.blocks`,
 * the active turn begins with the last user message. If the active turn's
 * persisted rows match a prefix of `currentBlocks`, that prefix is already
 * rendered in `blocks` and should be dropped from `currentBlocks`.
 *
 * `limit` bounds the scan to blocks that existed when the fetch started —
 * anything appended since postdates the snapshot and can never be covered.
 */
export function dropSnapshotAlignedPrefix(stream: AgentStream, limit: number) {
  if (stream.currentBlocks.length === 0 || stream.blocks.length === 0 || limit <= 0) return

  // The active turn starts at the last real user message. Member sessions
  // only ever receive agent-routed (`from_agent`) rows, so fall back to
  // those to anchor their turns too.
  let lastUserIdx = -1
  let lastRoutedUserIdx = -1
  for (let idx = stream.blocks.length - 1; idx >= 0; idx--) {
    const b = stream.blocks[idx]
    if (b.type !== 'user') continue
    if (!b.extra?.from_agent) {
      lastUserIdx = idx
      break
    }
    if (lastRoutedUserIdx === -1) lastRoutedUserIdx = idx
  }
  if (lastUserIdx === -1) lastUserIdx = lastRoutedUserIdx
  if (lastUserIdx === -1) return

  const currentTurnPersisted = stream.blocks.slice(lastUserIdx)

  // Anchor on the first live block that must have a persisted counterpart.
  let anchorIdx = 0
  while (anchorIdx < limit && anchorIdx < stream.currentBlocks.length && isEphemeralLive(stream.currentBlocks[anchorIdx])) {
    anchorIdx++
  }
  if (anchorIdx >= limit || anchorIdx >= stream.currentBlocks.length) return
  const anchorLive = stream.currentBlocks[anchorIdx]

  let startIdx = -1
  if (anchorLive.type === 'user' && !anchorLive.extra?.from_agent) {
    // An optimistic user bubble may only align with the turn *start* —
    // matching deeper would let an older identical send swallow a re-send.
    if (isSameBlock(anchorLive, currentTurnPersisted[0])) {
      startIdx = 0
    }
  } else {
    for (let j = 0; j < currentTurnPersisted.length; j++) {
      if (isSameBlock(anchorLive, currentTurnPersisted[j])) {
        startIdx = j
        break
      }
    }
  }

  if (startIdx === -1) return

  // Two-pointer walk: a mismatch on an ephemeral block skips it rather than
  // aborting the scan. `matchCount` only advances on real matches, so
  // trailing live reasoning that is still streaming survives the drop.
  let li = 0
  let pi = startIdx
  let matchCount = 0
  while (li < limit && li < stream.currentBlocks.length && pi < currentTurnPersisted.length) {
    if (isSameBlock(stream.currentBlocks[li], currentTurnPersisted[pi])) {
      li++
      pi++
      matchCount = li
      continue
    }
    if (isEphemeralLive(stream.currentBlocks[li])) {
      li++
      continue
    }
    if (currentTurnPersisted[pi].type === 'thinking') {
      pi++
      continue
    }
    break
  }

  if (matchCount > 0) {
    const covered = stream.currentBlocks.slice(0, matchCount)
    revokeBlobUrlsFromBlocks(covered)
    stream.currentBlocks = stream.currentBlocks.slice(matchCount)
  }
}

export function removePersistedOptimisticUserBlocks(stream: AgentStream) {
  const persistedUsers = stream.blocks.filter((block) => block.type === 'user')
  if (persistedUsers.length === 0) return

  // Fast path: sendMessage adopts the server's message_id for the optimistic
  // bubble as soon as the POST resolves (see pending-slice.ts), so on the
  // common path the id already matches the persisted row exactly — no need
  // to infer "same message?" from content + a clock-skew time window at all.
  // The heuristic below stays as a fallback for rows that predate that fix,
  // and any other id-less edge case.
  const persistedIds = new Set(persistedUsers.map((b) => b.id))

  stream.currentBlocks = stream.currentBlocks.filter((block) => {
    if (block.type !== 'user') return true
    if (persistedIds.has(block.id)) return false
    const optimisticTime = block.timestamp?.getTime()

    return !persistedUsers.some((persisted) => {
      if (persisted.content !== block.content) return false
      if ((block.extra?.from_agent ?? '') !== (persisted.extra?.from_agent ?? '')) return false
      if (optimisticTime === undefined) return true
      const persistedTime = persisted.timestamp?.getTime() ?? 0
      // Server row cannot predate optimistic bubble by more than 5s clock skew
      if (persistedTime < optimisticTime - 5_000) return false

      // Check if this persisted user block is followed in `blocks` by an assistant block
      // that pre-dates the optimistic bubble (meaning it belongs to a completed older turn).
      const persistedIdx = stream.blocks.indexOf(persisted)
      if (persistedIdx !== -1) {
        const nextBlock = stream.blocks[persistedIdx + 1]
        if (nextBlock && nextBlock.type !== 'user') {
          const nextTime = nextBlock.timestamp?.getTime() ?? 0
          if (nextTime < optimisticTime) return false
        }
      }

      return true
    })
  })
}
