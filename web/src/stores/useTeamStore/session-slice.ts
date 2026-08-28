import type { StateCreator } from 'zustand'
import { teamStatus, teamHistory, teamHistorySince } from '@/api/client'
import { applyOrphanToolResults, parseTeamBlocks, sumUsageFromMessages } from '@/utils/messages'
import type { OrphanToolResult } from '@/utils/messages'
import { createDefaultAgentStream } from './defaults'
import { applyRevertBoundary, revokeBlobUrlsFromBlocks } from './helpers'
import { toPendingQuestion } from './sse-reducer'
import { clearReconnectTimer } from './stream-slice'
import type { AgentStream, TeamStore } from './types'
import type { ContentBlock, MessageResponse } from '@/api/types'

function revertBoundaryTime(session: { revert?: { message_id?: string; created_at?: string } | null; messages: MessageResponse[] }): number | null {
  if (!session.revert) return null
  if (session.revert.created_at) {
    return new Date(session.revert.created_at).getTime()
  }
  const boundaryId = session.revert?.message_id
  if (!boundaryId) return null
  const boundary = session.messages.find((msg) => msg.id === boundaryId)
  return boundary?.created_at ? new Date(boundary.created_at).getTime() : null
}

function messagesBeforeTime(messages: MessageResponse[], boundaryTime: number | null): MessageResponse[] {
  if (boundaryTime === null) return messages
  return messages.filter((msg) => {
    if (!msg.created_at) return true
    return new Date(msg.created_at).getTime() < boundaryTime
  })
}

function messagesBeforeRevert(session: { revert?: { message_id?: string } | null; messages: MessageResponse[] }): MessageResponse[] {
  const boundaryId = session.revert?.message_id
  if (boundaryId) {
    const idx = session.messages.findIndex((msg) => msg.id === boundaryId)
    if (idx >= 0) {
      return session.messages.slice(0, idx)
    }
  }
  return messagesBeforeTime(session.messages, revertBoundaryTime(session))
}

function queuedMessagesFromHistory(sessionId: string, messages: MessageResponse[]) {
  return messages
    .filter((msg) => msg.role === 'user' && msg.extra?.queue_status === 'queued')
    .map((msg) => ({
      id: msg.id,
      sessionId,
      content: msg.content ?? '',
      submittedAt: msg.created_at ? new Date(msg.created_at).getTime() : undefined,
      attachments: msg.attachments ?? undefined,
    }))
}

/**
 * Newest ``created_at`` across the lead and every member session.
 *
 * Valid "we hold everything before this" watermark because a full page returns
 * the *newest* rows of each session: if a member had a message after this
 * instant, that message would itself be the maximum.
 */
function newestMessageAt(history: {
  lead: { messages: MessageResponse[] }
  members: Array<{ messages: MessageResponse[] }>
}): string | null {
  let newest: string | null = null
  const consider = (msgs: MessageResponse[]) => {
    for (const msg of msgs) {
      // Message ids are uuid7: globally creation-ordered across lead/member
      // sessions. Unlike per-session seq or display-only created_at, this
      // watermark also discovers a newly anchored compaction summary.
      if (newest === null || msg.id > newest) newest = msg.id
    }
  }
  consider(history.lead.messages)
  for (const member of history.members) consider(member.messages)
  return newest
}

function fastModeFromMessages(messages: MessageResponse[]): boolean {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const msg = messages[index]
    if (msg.role === 'user') return msg.extra?.service_tier === 'fast'
  }
  return false
}

function hasVisibleBlocks(stream: AgentStream | undefined): boolean {
  if (!stream) return false
  return [...stream.blocks, ...stream.currentBlocks].some((block) => block.type !== 'compaction')
}

// A `loadSession()` fetch reflects a DB snapshot taken when it started. If a
// new turn is optimistically appended (sendMessage) or streamed in (SSE
// deltas) to `currentBlocks` *while the fetch is in flight* — e.g. a
// background reconciliation from the global `session_turn_completed` event,
// a foreground-resume resync, or a stale coding-workspace re-render — that
// content postdates the snapshot and will not appear in `history` yet.
// Unconditionally clearing `currentBlocks` on resolve would then discard it
// permanently (nothing replays it back unless the caller also reconnects
// the stream), producing a visible "reload" flash where the just-sent
// message and/or in-progress streamed text vanish even though the turn is
// still running. Detect that case so the caller can preserve the newer
// local state instead of clobbering it with the stale fetch.
function hasLiveContent(stream: AgentStream | undefined, isWorking: boolean, sinceMs: number): boolean {
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
function dropSnapshotCoveredBlocks(stream: AgentStream, countAtFetchStart: number) {
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
/** Live-only or lossy block types that may lack a persisted counterpart:
 *  provider notices never persist, and reasoning is often summarized,
 *  redacted, or dropped entirely by the provider. */
function isEphemeralLive(block: ContentBlock): boolean {
  return block.type === 'thinking' || block.type === 'provider_status'
}

function dropSnapshotAlignedPrefix(stream: AgentStream, limit: number) {
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

function removePersistedOptimisticUserBlocks(stream: AgentStream) {
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

/**
 * True when this turn compacted and the divider is still client-only.
 *
 * A summary row is created after the delta's uuid7 watermark, so the backend
 * does return it. Its logical ``seq`` is anchored several turns back, however,
 * and parsed UI blocks do not retain sequence positions. Tail-splicing would
 * append the divider instead of inserting it at the boundary it marks, so a
 * compacted turn still needs one canonical full-page reconciliation.
 *
 * Local blocks are only ever appended, so they form a suffix of ``blocks`` —
 * stop at the first confirmed row rather than scanning the whole session.
 */
function hasUnsyncedCompaction(stream: AgentStream): boolean {
  const unsynced = new Set(stream._unsyncedBlockIds ?? [])
  if (unsynced.size === 0) return false
  for (let i = stream.blocks.length - 1; i >= 0; i--) {
    const block = stream.blocks[i]
    if (!unsynced.has(block.id)) return false
    if (block.type === 'compaction') return true
  }
  return false
}

export function resetSessionState(
  state: TeamStore,
  options: {
    sessionId: string | null
    model?: string | null
    thinkingLevel?: string | null
    fastMode?: boolean
    workspace?: string | null
  },
) {
  const leadName = state.leadName ?? state.agentNames[0] ?? null
  state.sessionId = options.sessionId
  state.sessionTitle = null
  state.sessionModel = options.model ?? null
  state.sessionThinkingLevel = options.thinkingLevel ?? null
  state._sessionSettingsDirty = false
  state._sessionSettingsVersion = (state._sessionSettingsVersion ?? 0) + 1
  state.sessionFastMode = options.fastMode ?? false
  state.isTeamWorking = false
  state.pendingQuestion = null
  state.resolvedQuestions = {}
  state.isConnected = false
  state.error = null
  state.setupRequired = null
  state.pendingDraft = null
  state._abortController = null
  state._pendingMessages = []
  clearReconnectTimer(state)
  state._reconnectAttempts = 0
  state._sessionGeneration = (state._sessionGeneration ?? 0) + 1
  state.cacheInvalidations = []
  state.hasMore = false
  state.nextCursor = null
  state._leadRevertTime = null
  state._syncedThrough = null
  state._workspace = options.workspace ?? null
  state._loadingOlder = false
  state._resolvedSessionReadyId = null
  state.agentNames = leadName ? [leadName] : []
  state.liveAgentNames = leadName ? [leadName] : null
  state.activeAgent = leadName ?? null

  Object.keys(state.agentStreams).forEach((name) => {
    if (name !== leadName) {
      delete state.agentStreams[name]
      return
    }
    state.agentStreams[name].blocks = []
    state.agentStreams[name].currentBlocks = []
    state.agentStreams[name].currentText = ''
    state.agentStreams[name].currentThinking = ''
    state.agentStreams[name].status = 'idle'
    state.agentStreams[name].lastError = null
    state.agentStreams[name].usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedTokens: 0 }
    state.agentStreams[name]._turnStartedAt = null
    // The lead stream object is reused across sessions — a restart pending in
    // the session being left would otherwise show dots on the one being opened.
    state.agentStreams[name]._restartedAtBlockCount = null
      state.agentStreams[name].revertedCount = 0
      state.agentStreams[name].revertedMessages = []
      state.agentStreams[name]._revertedSuffix = []
      state.agentStreams[name]._unsyncedBlockIds = []
      state.agentStreams[name]._orphanToolResults = {}
  })
}

export type SessionSlice = Pick<
  TeamStore,
  | 'leadName'
  | 'agentNames'
  | 'liveAgentNames'
  | 'sessionId'
  | 'sessionTitle'
  | 'sessionModel'
  | 'sessionThinkingLevel'
  | '_sessionSettingsDirty'
  | '_sessionSettingsVersion'
  | 'sessionFastMode'
  | '_sessionGeneration'
  | 'hasMore'
  | 'nextCursor'
  | '_leadRevertTime'
  | '_syncedThrough'
  | '_workspace'
  | '_loadingOlder'
  | '_resolvedSessionReadyId'
  | 'activeAgent'
  | 'newSession'
  | 'beginResolvedSession'
  | 'isEmptyIdleSession'
  | 'consumeResolvedSessionReady'
  | 'setSessionModelSettings'
  | 'loadTeamStatus'
  | 'loadSession'
  | 'reconcileTurnTail'
  | 'loadOlderMessages'
  | 'setActiveAgent'
>

// Keyed by `${sessionId}\u0000${workspace}`. Coalesces concurrent
// `loadSession` calls for the same session — see the comment on the
// `loadSession` action below.
const inflightLoadSession = new Map<string, Promise<void>>()

async function loadSessionImpl(
  get: () => TeamStore,
  set: (fn: (draft: TeamStore) => void) => void,
  sessionId: string,
  workspace?: string | null,
): Promise<void> {
  const gen = get()._sessionGeneration
  const settingsVersion = get()._sessionSettingsVersion
  const fetchStartedAt = Date.now()
  // How much live content each stream held before the request went out, so
  // the resolve path can tell it apart from anything appended since.
  const liveCountsAtFetch = new Map(
    Object.entries(get().agentStreams).map(([name, s]) => [name, s.currentBlocks.length]),
  )
  set((draft) => {
    if (draft.sessionId !== sessionId) {
      draft.isTeamWorking = false
    }
  })
  try {
    const liveNames = get().liveAgentNames
    const history = await teamHistory(sessionId)

    if (get()._sessionGeneration !== gen) return

    set((draft) => {
      draft.sessionId = sessionId
      draft.sessionTitle = history.lead.title ?? null
      if (!draft._sessionSettingsDirty && draft._sessionSettingsVersion === settingsVersion) {
        draft.sessionModel = history.lead.model ?? null
        draft.sessionThinkingLevel = history.lead.thinking_level ?? null
      }
      draft.sessionFastMode = fastModeFromMessages(history.lead.messages)
      draft.error = null
      Object.values(draft.agentStreams).forEach((stream) => {
        stream.revertedCount = 0
        stream.revertedMessages = []
      })

      const memberNames = history.members.map((m) => m.name)
      const leadName = history.lead.agent_name ?? liveNames?.[0] ?? draft.leadName ?? 'lead'
      draft.leadName = leadName
      if (liveNames !== null) draft.liveAgentNames = liveNames

      const allNames = Array.from(new Set([leadName, ...(liveNames ?? []), ...memberNames]))
      draft.agentNames = allNames
      const leadRevertTime = revertBoundaryTime(history.lead)
      const boundaryId = history.lead.revert?.message_id
      const boundaryMsg = boundaryId ? history.lead.messages.find((msg) => msg.id === boundaryId) : undefined

      // The client's `isTeamWorking` lags the server: after a /stop the
      // backend keeps unwinding for seconds before its trailing `done` clears
      // the flag, and `session_turn_completed` can arrive over the global
      // stream ahead of that `done` too. When the server says the turn is
      // over it had already persisted it in full, so every live block from
      // before this fetch is now duplicated by the canonical rows below —
      // preserving them is what let the belated `done` append the turn twice.
      // Drop them up front; everything downstream then sees only genuinely
      // newer content and needs no special casing.
      const turnStillRunning = history.lead.running === true
      if (!turnStillRunning) {
        Object.entries(draft.agentStreams).forEach(([name, stream]) => {
          dropSnapshotCoveredBlocks(stream, liveCountsAtFetch.get(name) ?? 0)
        })
      }

      // Computed against the stream identified by the *resolved* leadName,
      // before anything below overwrites it — see hasLiveContent.
      // Durable, so it outranks whatever the client last saw: a card the user
      // has not resolved is still on the table after a reload, an app restart,
      // or a switch to another device.
      const restoredQuestion = history.pending_question
        ? toPendingQuestion(history.pending_question)
        : null
      const awaitingAnswer = restoredQuestion !== null
      draft.pendingQuestion = restoredQuestion

      const leadHadNewerActivity = leadName
        ? hasLiveContent(draft.agentStreams[leadName], draft.isTeamWorking, fetchStartedAt)
        : false
      if (!leadHadNewerActivity) {
        // After a daemon restart the stream store has forgotten the turn, so
        // ``running`` is false while the question row says otherwise. The row is
        // the durable half, so it wins.
        draft.isTeamWorking =
          history.lead.running === true ||
          history.members.some((m) => m.running === true) ||
          awaitingAnswer
      }

      if (leadName) {
        if (!draft.agentStreams[leadName]) {
          draft.agentStreams[leadName] = createDefaultAgentStream()
        }
        const leadStream = draft.agentStreams[leadName]
        const leadLocalErrors = [...leadStream.blocks, ...leadStream.currentBlocks].filter(
          (b) => b.type === 'provider_status' && (b.extra?.status === 'error' || b.extra?.status === 'exhausted' || b.extra?.category === 'provider'),
        )
        if (!leadHadNewerActivity) revokeBlobUrlsFromBlocks(leadStream.currentBlocks)
        const leadOrphans: Record<string, OrphanToolResult> = {}
        leadStream.blocks = parseTeamBlocks(history.lead.messages, leadOrphans)
        // Results whose calls sit in older, not-yet-loaded pages — parked for
        // loadOlderMessages to attach when the owning card scrolls in.
        leadStream._orphanToolResults = leadOrphans
        if (leadLocalErrors.length > 0) {
          const existingIds = new Set(leadStream.blocks.map((b) => b.id))
          const toKeep = leadLocalErrors.filter((b) => !existingIds.has(b.id))
          leadStream.blocks = [...leadStream.blocks, ...toKeep]
        }
        leadStream._revertedSuffix = []
        applyRevertBoundary(leadStream, leadRevertTime, {
          boundaryId,
          boundaryContent: boundaryMsg?.content,
        })
        if (leadHadNewerActivity) {
          // A running turn keeps its live tail (the in-flight part is not in
          // the snapshot yet), so strip whatever the snapshot already covers
          // instead of rendering both copies.
          if (turnStillRunning) {
            dropSnapshotAlignedPrefix(leadStream, liveCountsAtFetch.get(leadName) ?? 0)
          }
          removePersistedOptimisticUserBlocks(leadStream)
        }
        if (!leadHadNewerActivity) {
          leadStream.currentBlocks = []
          leadStream.currentText = ''
          leadStream.currentThinking = ''
          // A suspended lead is still "running" to the stream store (the turn
          // never closed), but it is waiting, not working — so the question is
          // what distinguishes the two here, not the ``running`` flag.
          leadStream.status = awaitingAnswer
            ? 'waiting_input'
            : history.lead.running === true ? 'working' : 'idle'
          leadStream._turnStartedAt =
            history.lead.running === true && !awaitingAnswer ? Date.now() : null
        }
        // No restart bookkeeping needed here: the status assigned above is the
        // snapshot's verdict, and `isAwaitingRestartOutput` only reports a
        // pending restart for a `working` stream. A turn the server says has
        // ended (`idle`) or parked on another question (`waiting_input`) stops
        // matching on its own — which is what keeps the dots from stranding
        // when a reconnecting client missed the whole resumed turn.
        const leadVisibleMsgs = messagesBeforeRevert(history.lead)
        const leadUsage = sumUsageFromMessages(leadVisibleMsgs)
        const prevEstimatedCost = leadStream.usage?.estimatedCostUsd ?? 0
        const prevCompletionTokens = leadStream.usage?.completionTokens ?? 0
        // The server sums the WHOLE session (every page, compaction summaries
        // included), while the visible page only carries the newest
        // `_HISTORY_PAGE_SIZE` rows — a client-side sum over it undercounts
        // longer sessions. Prefer the authoritative total, but never regress
        // below the live SSE value (an in-flight turn may hold events the
        // server has not persisted yet). promptTokens/cachedTokens stay
        // page-derived: they describe the *latest* call, which is always in
        // the newest page.
        const leadCostUsd = typeof history.lead.estimated_cost_usd === 'number'
          ? history.lead.estimated_cost_usd
          : (leadUsage.estimatedCostUsd ?? 0)
        const leadCompletionTotal = typeof history.lead.completion_tokens === 'number'
          ? history.lead.completion_tokens
          : leadUsage.completionTokens
        if (!leadHadNewerActivity) {
          leadStream.usage = leadUsage
          leadStream.usage.completionTokens = Math.max(prevCompletionTokens, leadCompletionTotal)
          leadStream.usage.estimatedCostUsd = Math.round(Math.max(prevEstimatedCost, leadCostUsd) * 1e8) / 1e8
          leadStream.usage.totalTokens = leadStream.usage.promptTokens + leadStream.usage.completionTokens
        } else {
          leadStream.usage.completionTokens = Math.max(prevCompletionTokens, leadCompletionTotal)
          leadStream.usage.estimatedCostUsd = Math.round(Math.max(prevEstimatedCost, leadCostUsd) * 1e8) / 1e8
          leadStream.usage.promptTokens = leadStream.usage.promptTokens || leadUsage.promptTokens
          leadStream.usage.totalTokens = leadStream.usage.promptTokens + leadStream.usage.completionTokens
        }
      }

      const queued = queuedMessagesFromHistory(sessionId, history.lead.messages)
      const queuedIds = new Set(queued.map((msg) => msg.id))
      draft._pendingMessages = [
        ...draft._pendingMessages.filter((msg) => msg.sessionId !== sessionId || queuedIds.has(msg.id)),
        ...queued.filter((msg) => !draft._pendingMessages.some((existing) => existing.id === msg.id)),
      ]

      history.members.forEach((member) => {
        const existingStatus = draft.agentStreams[member.name]?.status
        const isLiveMember = liveNames === null || liveNames.includes(member.name)
        if (!draft.agentStreams[member.name]) {
          draft.agentStreams[member.name] = createDefaultAgentStream()
        }
        const memberStream = draft.agentStreams[member.name]
        const memberHadNewerActivity = hasLiveContent(memberStream, draft.isTeamWorking, fetchStartedAt)
        const memberLocalErrors = [...memberStream.blocks, ...memberStream.currentBlocks].filter(
          (b) => b.type === 'provider_status' && (b.extra?.status === 'error' || b.extra?.status === 'exhausted' || b.extra?.category === 'provider'),
        )
        if (!memberHadNewerActivity) revokeBlobUrlsFromBlocks(memberStream.currentBlocks)
        const memberOrphans: Record<string, OrphanToolResult> = {}
        memberStream.blocks = parseTeamBlocks(member.messages, memberOrphans)
        memberStream._orphanToolResults = memberOrphans
        if (memberLocalErrors.length > 0) {
          const existingIds = new Set(memberStream.blocks.map((b) => b.id))
          const toKeep = memberLocalErrors.filter((b) => !existingIds.has(b.id))
          memberStream.blocks = [...memberStream.blocks, ...toKeep]
        }
        memberStream._revertedSuffix = []
        applyRevertBoundary(memberStream, leadRevertTime, {
          boundaryId,
          boundaryContent: boundaryMsg?.content,
        })
        if (memberHadNewerActivity && turnStillRunning) {
          dropSnapshotAlignedPrefix(memberStream, liveCountsAtFetch.get(member.name) ?? 0)
          removePersistedOptimisticUserBlocks(memberStream)
        }
        if (!memberHadNewerActivity) {
          memberStream.currentBlocks = []
          memberStream.currentText = ''
          memberStream.currentThinking = ''
          memberStream.status =
            !isLiveMember
              ? 'offline'
              : member.running === true
                ? 'working'
                : existingStatus === 'offline' || existingStatus === 'error' ? existingStatus : 'idle'
          memberStream._turnStartedAt = member.running === true ? Date.now() : null
        }
        const memberVisibleMsgs = messagesBeforeTime(member.messages, leadRevertTime)
        const memberUsage = sumUsageFromMessages(memberVisibleMsgs)
        const prevMemberEstimatedCost = memberStream.usage?.estimatedCostUsd ?? 0
        const prevMemberCompletionTokens = memberStream.usage?.completionTokens ?? 0
        const memberCostUsd = typeof member.estimated_cost_usd === 'number'
          ? member.estimated_cost_usd
          : (memberUsage.estimatedCostUsd ?? 0)
        const memberCompletionTotal = typeof member.completion_tokens === 'number'
          ? member.completion_tokens
          : memberUsage.completionTokens
        if (!memberHadNewerActivity) {
          memberStream.usage = memberUsage
          memberStream.usage.completionTokens = Math.max(prevMemberCompletionTokens, memberCompletionTotal)
          memberStream.usage.estimatedCostUsd = Math.round(Math.max(prevMemberEstimatedCost, memberCostUsd) * 1e8) / 1e8
          memberStream.usage.totalTokens = memberStream.usage.promptTokens + memberStream.usage.completionTokens
        } else {
          memberStream.usage.completionTokens = Math.max(prevMemberCompletionTokens, memberCompletionTotal)
          memberStream.usage.estimatedCostUsd = Math.round(Math.max(prevMemberEstimatedCost, memberCostUsd) * 1e8) / 1e8
          memberStream.usage.promptTokens = memberStream.usage.promptTokens || memberUsage.promptTokens
          memberStream.usage.totalTokens = memberStream.usage.promptTokens + memberStream.usage.completionTokens
        }
      })

      if (!draft.activeAgent || !allNames.includes(draft.activeAgent)) {
        draft.activeAgent = leadName ?? allNames[0] ?? null
      }

      draft.hasMore = history.has_more
      draft.nextCursor = history.next_cursor
      draft._leadRevertTime = revertBoundaryTime(history.lead)
      // Everything in this response is server-confirmed, so nothing is
      // pending reconciliation and the watermark advances to its newest row.
      draft._syncedThrough = newestMessageAt(history)
      Object.values(draft.agentStreams).forEach((stream) => {
        stream._unsyncedBlockIds = []
      })
      draft._workspace = workspace ?? null
      draft._loadingOlder = false
      draft._resolvedSessionReadyId = null
    })

    if (liveNames === null && get()._sessionGeneration === gen) {
      void get().loadTeamStatus(workspace, gen)
    }
  } catch (err) {
    if (get()._sessionGeneration !== gen) return
    set((draft) => {
      draft.error = err instanceof Error ? err.message : 'Failed to load session'
    })
  }
}

export const createSessionSlice: StateCreator<
  TeamStore,
  [['zustand/immer', never]],
  [],
  SessionSlice
> = (set, get) => ({
  leadName: null,
  agentNames: [],
  liveAgentNames: null,
  sessionId: null,
  sessionTitle: null,
  sessionModel: null,
  sessionThinkingLevel: null,
  _sessionSettingsDirty: false,
  _sessionSettingsVersion: 0,
  sessionFastMode: false,
  _sessionGeneration: 0,
  hasMore: false,
  nextCursor: null,
  _leadRevertTime: null,
  _syncedThrough: null,
  _workspace: null,
  _loadingOlder: false,
  _resolvedSessionReadyId: null,
  activeAgent: null,

  newSession: () => {
    get()._abortController?.abort()
    set((state) => {
      resetSessionState(state, { sessionId: null })
    })
  },

  beginResolvedSession: (sessionId, options) => {
    // Preserving the live turn is only correct while we stay on the *same*
    // logical session: a background resolve that hands us the id of the
    // session the optimistic message was just sent to (sessionId still null,
    // or already this id) must not wipe that in-flight turn. Adopting a
    // *different* persisted session is a switch — the previous session's
    // streaming blocks and working flag belong to a chat we are leaving, so
    // they must be dropped or they keep rendering (and `loadSession` then
    // treats them as newer local content) under the new session id.
    const staysOnSameSession =
      get().sessionId === null || get().sessionId === sessionId
    const preserveLocalSettings = staysOnSameSession && get()._sessionSettingsDirty
    const isWorkingOrHasBlocks =
      get().isTeamWorking ||
      Boolean(
        get().leadName &&
          get().agentStreams[get().leadName!]?.currentBlocks.length > 0,
      )
    if (staysOnSameSession && isWorkingOrHasBlocks) {
      set((state) => {
        if (sessionId) state.sessionId = sessionId
        if (!preserveLocalSettings) {
          state.sessionModel = options?.model ?? state.sessionModel
          state.sessionThinkingLevel = options?.thinkingLevel ?? state.sessionThinkingLevel
        }
        if (options?.fastMode !== undefined) state.sessionFastMode = options.fastMode
        if (options?.workspace) state._workspace = options.workspace
        if (options?.skipInitialRestore && sessionId) state._resolvedSessionReadyId = sessionId
      })
      return
    }
    get()._abortController?.abort()
    const localModel = get().sessionModel
    const localThinkingLevel = get().sessionThinkingLevel
    set((state) => {
      resetSessionState(state, {
        sessionId,
        model: preserveLocalSettings ? localModel : options?.model,
        thinkingLevel: preserveLocalSettings ? localThinkingLevel : options?.thinkingLevel,
        fastMode: options?.fastMode,
        workspace: options?.workspace,
      })
      if (options?.skipInitialRestore) state._resolvedSessionReadyId = sessionId
      if (preserveLocalSettings) state._sessionSettingsDirty = true
    })
  },

  isEmptyIdleSession: () => {
    const state = get()
    if (!state.sessionId || state.isTeamWorking) return false
    return state.agentNames.every((name) => !hasVisibleBlocks(state.agentStreams[name]))
  },

  consumeResolvedSessionReady: (sessionId, workspace) => {
    const state = get()
    const expectedWorkspace = workspace ?? null
    if (
      state.sessionId !== sessionId ||
      state._resolvedSessionReadyId !== sessionId ||
      state._workspace !== expectedWorkspace
    ) {
      return false
    }
    set((draft) => {
      draft._resolvedSessionReadyId = null
    })
    return true
  },

  setSessionModelSettings: (model: string | null, thinkingLevel: string | null, fastMode?: boolean) => {
    set((draft) => {
      draft.sessionModel = model
      draft.sessionThinkingLevel = thinkingLevel
      draft._sessionSettingsDirty = true
      draft._sessionSettingsVersion += 1
      if (fastMode !== undefined) draft.sessionFastMode = fastMode
    })
  },

  loadTeamStatus: async (workspace?: string | null, expectedGeneration?: number) => {
    try {
      const currentSessionId = get().sessionId
      const status = await teamStatus(workspace, currentSessionId)
      if (expectedGeneration !== undefined && get()._sessionGeneration !== expectedGeneration) return
      if (status) {
        const allAgents = [status.lead, ...status.members]
        const liveNames = allAgents.map((a) => a.name)
        set((draft) => {
          draft.leadName = status.lead.name
          draft.liveAgentNames = liveNames
          const historicalNames = draft.agentNames.filter((name) => !liveNames.includes(name))
          draft.agentNames = [...liveNames, ...historicalNames]
          allAgents.forEach((agent) => {
            if (!draft.agentStreams[agent.name]) {
              draft.agentStreams[agent.name] = createDefaultAgentStream()
            }
            // No run state is set from here: /team/agents (which this is a
            // projection of) carries no per-agent state, so every agent arrives
            // as 'idle'. Live working/idle transitions come from the SSE
            // ``agent_status`` events, which are the authoritative source.
            draft.agentStreams[agent.name].model = agent.model
          })
          historicalNames.forEach((name) => {
            const stream = draft.agentStreams[name]
            if (stream && name !== status.lead.name && stream.status !== 'error' && stream.status !== 'working') {
              stream.status = 'offline'
            }
          })
          if (!draft.activeAgent && draft.agentNames.length > 0) {
            draft.activeAgent = draft.agentNames[0]
          }
        })
      }
    } catch (err) {
      if (expectedGeneration !== undefined && get()._sessionGeneration !== expectedGeneration) return
      set((draft) => {
        draft.error = err instanceof Error ? err.message : 'Failed to load team status'
      })
    }
  },

  loadSession: async (sessionId: string, workspace?: string | null) => {
    // Coalesce concurrent calls for the same session into one in-flight
    // fetch. A foreground/visibility resume (useSessionBootstrap) and the
    // global event stream's reconcile (useGlobalEventStream) can both react
    // to the same visibilitychange and call loadSession() for the same
    // session back-to-back. Each independent call takes its own
    // `liveCountsAtFetch` snapshot of `currentBlocks` — if both run against a
    // live turn, the second snapshot can be taken *after* the first call
    // already mutated `currentBlocks` (e.g. via a `connectStream()` replay
    // it kicked off), producing an inconsistent drop-prefix calculation that
    // leaves stale live blocks in place for the next SSE replay to duplicate.
    // Sharing the in-flight promise removes the race outright — every extra
    // caller just awaits the one fetch already covering it.
    const inflightKey = `${sessionId}\u0000${workspace ?? ''}`
    const existing = inflightLoadSession.get(inflightKey)
    if (existing) return existing
    const promise = loadSessionImpl(get, set, sessionId, workspace).finally(() => {
      if (inflightLoadSession.get(inflightKey) === promise) inflightLoadSession.delete(inflightKey)
    })
    inflightLoadSession.set(inflightKey, promise)
    return promise
  },

  reconcileTurnTail: async (sessionId: string, workspace?: string | null) => {
    const state = get()
    const since = state._syncedThrough

    // No confirmed baseline, a turn is still producing content, or the turn
    // compacted: an anchored summary cannot be tail-spliced safely, so take
    // the full page.
    if (
      state.sessionId !== sessionId ||
      since === null ||
      state.isTeamWorking ||
      Object.values(state.agentStreams).some(hasUnsyncedCompaction)
    ) {
      await get().loadSession(sessionId, workspace)
      return
    }

    const gen = state._sessionGeneration
    const settingsVersion = state._sessionSettingsVersion
    let delta: Awaited<ReturnType<typeof teamHistorySince>>
    try {
      delta = await teamHistorySince(sessionId, since)
    } catch {
      // Never leave the tail unreconciled — fall back to the full page.
      await get().loadSession(sessionId, workspace)
      return
    }

    if (get()._sessionGeneration !== gen || get().sessionId !== sessionId) return

    // Too far behind to stitch, or a new turn started while the delta was in
    // flight (its blocks postdate this snapshot).
    if (delta.truncated || get().isTeamWorking) {
      await get().loadSession(sessionId, workspace)
      return
    }

    // A delta is only valid against the watermark it was fetched with. Pressing
    // Stop runs both reconciliation paths at once — the backend publishes
    // `session_turn_completed` (this path) *and* returns 202 to the interrupt
    // POST, whose `stopTeam` reload takes a full page — so the canonical rows
    // this delta carries can already be installed by the time it resolves, and
    // splicing it on top renders the just-sent user message twice.
    const syncedNow = get()._syncedThrough
    if (syncedNow !== since) {
      const newest = newestMessageAt(delta)
      // Already covered by whoever moved the watermark: nothing left to splice.
      if (newest === null || (syncedNow !== null && newest <= syncedNow)) return
      await get().loadSession(sessionId, workspace)
      return
    }

    set((draft) => {
      // Metadata the delta carries authoritatively.
      draft.sessionTitle = delta.lead.title ?? draft.sessionTitle
      if (!draft._sessionSettingsDirty && draft._sessionSettingsVersion === settingsVersion) {
        draft.sessionModel = delta.lead.model ?? draft.sessionModel
        draft.sessionThinkingLevel = delta.lead.thinking_level ?? draft.sessionThinkingLevel
      }
      draft.isTeamWorking = delta.lead.running === true
      draft.error = null

      const revertTime = draft._leadRevertTime
      // A concurrent /undo may have moved the boundary while the delta was in
      // flight; keep reverted rows from resurfacing.
      const visible = (blocks: ReturnType<typeof parseTeamBlocks>) =>
        revertTime === null
          ? blocks
          : blocks.filter((b) => (b.timestamp?.getTime() ?? 0) < revertTime)

      const swapTail = (name: string, messages: MessageResponse[]) => {
        const stream = draft.agentStreams[name]
        if (!stream) return
        const unsynced = new Set(stream._unsyncedBlockIds ?? [])
        const confirmedRaw = unsynced.size > 0
          ? stream.blocks.filter((block) => !unsynced.has(block.id) || block.type === 'provider_status')
          : stream.blocks
        // The delta can carry a tool result whose assistant row predates the
        // watermark (a mid-turn loadSession adopted it before the tool
        // finished). Attach such orphans to the already-confirmed card, or it
        // stays "running" forever when the live tool_end was missed.
        const orphans = { ...(stream._orphanToolResults ?? {}) }
        const tail = visible(parseTeamBlocks(messages, orphans))
        const confirmed = applyOrphanToolResults(confirmedRaw, orphans)
        stream.blocks = [...confirmed, ...tail]
        stream._orphanToolResults = orphans
        stream._unsyncedBlockIds = []
      }

      const leadName = delta.lead.agent_name ?? draft.leadName
      if (leadName) {
        if (!draft.agentStreams[leadName]) {
          draft.agentStreams[leadName] = createDefaultAgentStream()
        }
        swapTail(leadName, delta.lead.messages)
        // The delta carries the authoritative full-session total; adopt it
        // (never regressing below the live SSE value) so a client that dropped
        // usage events re-converges after every completed turn.
        const leadStream = draft.agentStreams[leadName]
        if (typeof delta.lead.estimated_cost_usd === 'number') {
          leadStream.usage.estimatedCostUsd = Math.round(Math.max(
            leadStream.usage.estimatedCostUsd ?? 0,
            delta.lead.estimated_cost_usd,
          ) * 1e8) / 1e8
        }
        if (typeof delta.lead.completion_tokens === 'number') {
          leadStream.usage.completionTokens = Math.max(
            leadStream.usage.completionTokens,
            delta.lead.completion_tokens,
          )
          leadStream.usage.totalTokens = leadStream.usage.promptTokens + leadStream.usage.completionTokens
        }
      }

      delta.members.forEach((member: {
        name: string
        messages: MessageResponse[]
        estimated_cost_usd?: number | null
        completion_tokens?: number | null
      }) => {
        if (!draft.agentStreams[member.name]) {
          draft.agentStreams[member.name] = createDefaultAgentStream()
          if (!draft.agentNames.includes(member.name)) draft.agentNames.push(member.name)
        }
        swapTail(member.name, member.messages)
        const memberStream = draft.agentStreams[member.name]
        if (typeof member.estimated_cost_usd === 'number') {
          memberStream.usage.estimatedCostUsd = Math.round(Math.max(
            memberStream.usage.estimatedCostUsd ?? 0,
            member.estimated_cost_usd,
          ) * 1e8) / 1e8
        }
        if (typeof member.completion_tokens === 'number') {
          memberStream.usage.completionTokens = Math.max(
            memberStream.usage.completionTokens,
            member.completion_tokens,
          )
          memberStream.usage.totalTokens = memberStream.usage.promptTokens + memberStream.usage.completionTokens
        }
      })

      // Adopt any queued rows the delta revealed, matching loadSession.
      const queued = queuedMessagesFromHistory(sessionId, delta.lead.messages)
      if (queued.length > 0) {
        draft._pendingMessages = [
          ...draft._pendingMessages,
          ...queued.filter((msg) => !draft._pendingMessages.some((e) => e.id === msg.id)),
        ]
      }

      // Deliberately untouched here — a delta carries no information about them:
      //  * usage: maintained live by SSE `usage` events; recomputing from a
      //    partial message set would undercount. Re-derived on the next full load.
      //  * hasMore / nextCursor: describe *older* history, which a delta never sees.
      //  * _leadRevertTime: its boundary message is usually outside the delta,
      //    so recomputing would clear the boundary and resurrect reverted blocks.
      const newest = newestMessageAt(delta)
      if (newest !== null && (draft._syncedThrough === null || newest > draft._syncedThrough)) {
        draft._syncedThrough = newest
      }
    })
  },

  loadOlderMessages: async () => {
    const { sessionId, nextCursor, hasMore, leadName, _leadRevertTime, _loadingOlder } = get()
    if (!sessionId || !hasMore || !nextCursor || _loadingOlder) return
    set((draft) => { draft._loadingOlder = true })
    try {
      const history = await teamHistory(sessionId, nextCursor)
      set((draft) => {
        draft._loadingOlder = false
        draft.hasMore = history.has_more
        draft.nextCursor = history.next_cursor
        if (leadName && draft.agentStreams[leadName]) {
          const filtered = messagesBeforeTime(history.lead.messages, _leadRevertTime)
          const leadStream = draft.agentStreams[leadName]
          // Claim results orphaned by the page boundary: the newer page may
          // hold a tool result whose call row is in this older page.
          const orphans = { ...(leadStream._orphanToolResults ?? {}) }
          const older = applyOrphanToolResults(parseTeamBlocks(filtered, orphans), orphans)
          leadStream.blocks = [...older, ...leadStream.blocks]
          leadStream._orphanToolResults = orphans
          // Usage is NOT accumulated here: `loadSession` restores the
          // authoritative full-session total from the server, so older pages
          // carry nothing new to add. Accumulating the page's messages would
          // double-count the cost/tokens the server total already includes.
        }
        history.members.forEach((member) => {
          if (draft.agentStreams[member.name]) {
            const filtered = messagesBeforeTime(member.messages, _leadRevertTime)
            const memberStream = draft.agentStreams[member.name]
            const orphans = { ...(memberStream._orphanToolResults ?? {}) }
            const older = applyOrphanToolResults(parseTeamBlocks(filtered, orphans), orphans)
            memberStream.blocks = [...older, ...memberStream.blocks]
            memberStream._orphanToolResults = orphans
          }
        })
      })
    } catch (err) {
      set((draft) => { draft._loadingOlder = false })
      throw err
    }
  },

  setActiveAgent: (name: string) => {
    set((draft) => { draft.activeAgent = name })
  },
})
