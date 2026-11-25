/**
 * The open session's history as the server holds it: the full page load, the
 * tail a finished turn adds (``reconcileTurnTail``), the gap an attach or a
 * return to the app may leave, and older pages scrolled into view.
 */
import type { StateCreator } from 'zustand'
import { sessionHistory, sessionHistorySince } from '@/api/client'
import { readBlocks } from '@/utils/blocks'
import { applyOrphanToolResults, isPromptMessage, parseAgentBlocks } from '@/utils/messages'
import { createDefaultAgentStream } from './defaults'
import { adoptLiveBlockIds } from './helpers'
import { applyRun, isRunLive } from './run-state'
import { dropSnapshotAlignedPrefix } from './history-alignment'
import { deltaRows, holdsUnseenRows, messagesBeforeTime, newestMessageAt, queuedMessagesFromHistory, toolResultsOf } from './history-rows'
import { forgetInflightLoad, loadSessionOnce } from './load-session'
import type { AgentStream, AgentStore } from './types'
import type { ContentBlock, MessageResponse, SessionHistoryResponse } from '@/api/types'

/** Pages ⌥⌘↑ may fetch looking for an earlier prompt, e.g. across one long agent turn. */
const OLDER_PROMPT_PAGE_LIMIT = 10

/** Prepend one older history page to the lead and member streams. */
function prependOlderPage(draft: AgentStore, history: SessionHistoryResponse, revertTime: number | null) {
  draft.hasMore = history.has_more
  draft.nextCursor = history.next_cursor
  const pinnedId = draft.pinnedPrompt?.id
  if (pinnedId && history.lead.messages.some((msg) => msg.id === pinnedId)) draft.pinnedPrompt = null
  const prepend = (stream: AgentStream, messages: MessageResponse[]) => {
    // Claim results orphaned by the page boundary: the newer page may hold a
    // tool result whose call row is in this older page.
    const orphans = { ...(stream._orphanToolResults ?? {}) }
    const older = applyOrphanToolResults(parseAgentBlocks(messagesBeforeTime(messages, revertTime), orphans), orphans)
    // Spread the plain array, not the draft: spreading a draft drafts every
    // loaded block. Nothing in this recipe writes to those blocks afterwards.
    stream.blocks = [...older, ...readBlocks(stream.blocks)]
    stream._orphanToolResults = orphans
  }
  const lead = draft.leadName ? draft.agentStreams[draft.leadName] : undefined
  if (lead) prepend(lead, history.lead.messages)
  // Usage is NOT accumulated here: `loadSession` restores the authoritative
  // full-session total from the server, so older pages carry nothing new to
  // add. Accumulating the page's messages would double-count the cost/tokens
  // the server total already includes.
  for (const member of history.members) {
    const stream = draft.agentStreams[member.name]
    if (stream) prepend(stream, member.messages)
  }
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

export type HistorySlice = Pick<
  AgentStore,
  | 'hasMore'
  | 'nextCursor'
  | 'pinnedPrompt'
  | 'isLoadingHistory'
  | '_syncedThrough'
  | '_loadingOlder'
  | 'loadSession'
  | 'reconcileTurnTail'
  | 'fillAttachGap'
  | 'catchUpLiveTurn'
  | 'loadOlderMessages'
  | 'loadOlderUntilPrompt'
  | '_alignLiveWithHistory'
>

export const createHistorySlice: StateCreator<
  AgentStore,
  [['zustand/immer', never]],
  [],
  HistorySlice
> = (set, get) => ({
  hasMore: false,
  nextCursor: null,
  pinnedPrompt: null,
  isLoadingHistory: false,
  _syncedThrough: null,
  _loadingOlder: false,

  loadSession: async (sessionId, workspace, options) => loadSessionOnce(get, set, sessionId, workspace, options),

  _alignLiveWithHistory: () => {
    const streams = Object.values(get().agentStreams)
    if (!streams.some((stream) => stream.currentBlocks.length > 0 && stream.blocks.length > 0)) return
    set((draft) => {
      for (const stream of Object.values(draft.agentStreams)) {
        // Every live block came from the attach, so any of them may be saved.
        dropSnapshotAlignedPrefix(stream, stream.currentBlocks.length)
      }
    })
  },

  fillAttachGap: async (sessionId: string) => {
    const state = get()
    const since = state._syncedThrough
    if (state.sessionId !== sessionId || since === null) return
    const gen = state._sessionGeneration
    let delta: Awaited<ReturnType<typeof sessionHistorySince>>
    try {
      delta = await sessionHistorySince(sessionId, since)
    } catch {
      return
    }
    const now = get()
    if (now._sessionGeneration !== gen || now.sessionId !== sessionId) return
    if (!delta.truncated && !holdsUnseenRows(now, deltaRows(delta))) return
    // The mid-turn reload keeps the live tail and adds the rows it lacks.
    await get().loadSession(sessionId, now._workspace)
  },

  catchUpLiveTurn: async (sessionId: string, workspace: string | null) => {
    const state = get()
    if (state.sessionId !== sessionId || state._workspace !== workspace) return 'stale'
    const since = state._syncedThrough
    // Nothing to diff against, a turn that may have started while away, or a
    // compaction (its summary cannot be spliced): the full page decides.
    if (since === null || !isRunLive(state.sessionRun) || Object.values(state.agentStreams).some(hasUnsyncedCompaction)) {
      return 'reload'
    }
    const gen = state._sessionGeneration
    let delta: SessionHistoryResponse
    try {
      delta = await sessionHistorySince(sessionId, since)
    } catch {
      return 'reload'
    }
    const now = get()
    if (now._sessionGeneration !== gen || now.sessionId !== sessionId || now._workspace !== workspace) return 'stale'
    // The turn ended or stopped while away (its final rows replace the live
    // tail), or too much happened to stitch.
    if (delta.truncated || delta.lead.running !== true) return 'reload'
    const rows = deltaRows(delta)
    if (holdsUnseenRows(now, rows)) return 'reload'
    // The attach replays only the step in progress, so a shown tool that
    // finished in a step saved while away would stay "running" until the
    // turn ends. Its result is in the delta: finish the card from it.
    const results = toolResultsOf(rows)
    if (Object.keys(results).length > 0) {
      set((draft) => {
        for (const stream of Object.values(draft.agentStreams)) {
          const live = readBlocks(stream.currentBlocks)
          const finishedLive = applyOrphanToolResults(live, results)
          if (finishedLive !== live) stream.currentBlocks = finishedLive as ContentBlock[]
          const confirmed = readBlocks(stream.blocks)
          const finishedConfirmed = applyOrphanToolResults(confirmed, results)
          if (finishedConfirmed !== confirmed) stream.blocks = finishedConfirmed as ContentBlock[]
        }
      })
    }
    return 'attach'
  },

  reconcileTurnTail: async (sessionId: string, workspace?: string | null) => {
    const state = get()
    const since = state._syncedThrough

    const reload = async () => {
      forgetInflightLoad(get()._sessionGeneration, sessionId, workspace)
      await get().loadSession(sessionId, workspace)
    }

    // No confirmed baseline, a turn is still producing content, or the turn
    // compacted: an anchored summary cannot be tail-spliced safely, so take
    // the full page.
    if (
      state.sessionId !== sessionId ||
      since === null ||
      isRunLive(state.sessionRun) ||
      Object.values(state.agentStreams).some(hasUnsyncedCompaction)
    ) {
      await reload()
      return
    }

    const gen = state._sessionGeneration
    const settingsVersion = state._sessionSettingsVersion
    let delta: Awaited<ReturnType<typeof sessionHistorySince>>
    try {
      delta = await sessionHistorySince(sessionId, since)
    } catch {
      // Never leave the tail unreconciled — fall back to the full page.
      await reload()
      return
    }

    if (get()._sessionGeneration !== gen || get().sessionId !== sessionId) return

    // Too far behind to stitch, or a new turn started while the delta was in
    // flight (its blocks postdate this snapshot).
    if (delta.truncated || isRunLive(get().sessionRun)) {
      await reload()
      return
    }

    // A delta is only valid against the watermark it was fetched with. Pressing
    // Stop runs both reconciliation paths at once — the backend publishes
    // `session_turn_completed` (this path) *and* returns 202 to the interrupt
    // POST, whose `stopAgent` reload takes a full page — so the canonical rows
    // this delta carries can already be installed by the time it resolves, and
    // splicing it on top renders the just-sent user message twice.
    const syncedNow = get()._syncedThrough
    if (syncedNow !== since) {
      const newest = newestMessageAt(delta)
      // Already covered by whoever moved the watermark: nothing left to splice.
      if (newest === null || (syncedNow !== null && newest <= syncedNow)) return
      await reload()
      return
    }

    set((draft) => {
      // Metadata the delta carries authoritatively.
      draft.sessionTitle = delta.lead.title ?? draft.sessionTitle
      draft.sessionSentFrom = delta.lead.sent_from ?? draft.sessionSentFrom
      draft.sessionInteractionMode = delta.lead.interaction_mode ?? draft.sessionInteractionMode
      if (!draft._sessionSettingsDirty && draft._sessionSettingsVersion === settingsVersion) {
        draft.sessionModel = delta.lead.model ?? draft.sessionModel
        draft.sessionThinkingLevel = delta.lead.thinking_level ?? draft.sessionThinkingLevel
      }
      applyRun(draft, { type: 'snapshot', live: delta.lead.running === true })
      draft.error = null

      const revertTime = draft._leadRevertTime
      // A concurrent /undo may have moved the boundary while the delta was in
      // flight; keep reverted rows from resurfacing.
      const visible = (blocks: ReturnType<typeof parseAgentBlocks>) =>
        revertTime === null
          ? blocks
          : blocks.filter((b) => (b.timestamp?.getTime() ?? 0) < revertTime)

      const swapTail = (name: string, messages: MessageResponse[]) => {
        const stream = draft.agentStreams[name]
        if (!stream) return
        const unsynced = new Set(stream._unsyncedBlockIds ?? [])
        // Read the plain array: filtering or spreading the draft would draft
        // every confirmed block. The recipe never writes to them afterwards.
        const loaded = readBlocks(stream.blocks)
        const confirmedRaw = unsynced.size > 0
          ? loaded.filter((block) => !unsynced.has(block.id) || block.type === 'provider_status')
          : loaded
        // The delta can carry a tool result whose assistant row predates the
        // watermark (a mid-turn loadSession adopted it before the tool
        // finished). Attach such orphans to the already-confirmed card, or it
        // stays "running" forever when the live tool_end was missed.
        const orphans = { ...(stream._orphanToolResults ?? {}) }
        // The canonical rows keep the ids the live blocks they replace had,
        // so the finished turn is not remounted (``adoptLiveBlockIds``).
        const tail = adoptLiveBlockIds(
          loaded.filter((block) => unsynced.has(block.id)),
          visible(parseAgentBlocks(messages, orphans)),
          new Set(readBlocks(stream.currentBlocks).map((block) => block.id)),
        )
        const confirmed = applyOrphanToolResults(confirmedRaw, orphans)
        stream.blocks = [...confirmed, ...tail]
        stream._orphanToolResults = orphans
        stream._unsyncedBlockIds = []
      }

      const isSubagentSession = Boolean(delta.lead.parent_session_id)
      const leadName =
        delta.lead.agent_name || draft.leadName || (isSubagentSession ? 'member' : 'code')
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

      // A user row the server now reports as a real (non-queued) message has
      // left the queue. Queued messages always carry their server id, so the
      // match is by id: by text, a repeated "yes" lost its duplicate.
      const confirmedUser = delta.lead.messages.filter(
        (m) => m.role === 'user' && m.kind !== 'queued' && m.extra?.queue_status !== 'queued',
      )
      const confirmedUserIds = new Set(confirmedUser.map((m) => m.id))
      if (confirmedUserIds.size > 0) {
        draft._pendingMessages = draft._pendingMessages.filter((msg) => {
          if (msg.sessionId && msg.sessionId !== sessionId) return true
          return !confirmedUserIds.has(msg.id)
        })
      }

      // Adopt any queued rows the delta revealed, matching loadSession.
      const queued = queuedMessagesFromHistory(sessionId, delta.lead.messages).filter(
        (msg) => !confirmedUserIds.has(msg.id),
      )
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
    const { sessionId, nextCursor, hasMore, _leadRevertTime, _loadingOlder } = get()
    if (!sessionId || !hasMore || !nextCursor || _loadingOlder) return
    set((draft) => { draft._loadingOlder = true })
    try {
      const history = await sessionHistory(sessionId, nextCursor)
      set((draft) => {
        draft._loadingOlder = false
        prependOlderPage(draft, history, _leadRevertTime)
      })
    } catch (err) {
      set((draft) => { draft._loadingOlder = false })
      throw err
    }
  },

  loadOlderUntilPrompt: async (maxPages = OLDER_PROMPT_PAGE_LIMIT) => {
    const { sessionId, nextCursor, hasMore, _leadRevertTime, _loadingOlder, _sessionGeneration: generation } = get()
    if (!sessionId || !hasMore || !nextCursor || _loadingOlder) return false
    set((draft) => { draft._loadingOlder = true })
    const pages: SessionHistoryResponse[] = []
    let cursor: string | null = nextCursor
    let found = false
    try {
      // Cursor pages are sequential; fetch them all, then prepend once, so a
      // run of prompt-less pages (one long agent turn) costs one render.
      while (cursor && !found && pages.length < maxPages) {
        const history = await sessionHistory(sessionId, cursor)
        if (get()._sessionGeneration !== generation) return false
        pages.push(history)
        found = messagesBeforeTime(history.lead.messages, _leadRevertTime).some(isPromptMessage)
        cursor = history.has_more ? history.next_cursor : null
      }
    } finally {
      // Keep whatever arrived, even when a later page failed.
      set((draft) => {
        if (draft._sessionGeneration !== generation) return
        draft._loadingOlder = false
        for (const history of pages) prependOlderPage(draft, history, _leadRevertTime)
      })
    }
    return found
  },
})
