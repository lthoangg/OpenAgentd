/**
 * Loading a session's newest history page into the store: the session's
 * settings, each agent's confirmed rows and usage, the queued steers, and the
 * open question, without losing live content that is newer than the page.
 * Concurrent loads of one visit share a single fetch.
 */
import { sessionHistory } from '@/api/client'
import { takePrefetchedHistory } from '@/lib/session-prefetch'
import { readBlocks } from '@/utils/blocks'
import { isTransientNetworkError } from '@/utils/errors'
import { parseAgentBlocks, sumUsageFromMessages } from '@/utils/messages'
import type { OrphanToolResult } from '@/utils/messages'
import { createDefaultAgentStream } from './defaults'
import { applyQuestionResolution, applyRevertBoundary, revokeBlobUrlsFromBlocks } from './helpers'
import {
  dropSnapshotAlignedPrefix,
  dropSnapshotCoveredBlocks,
  hasLiveContent,
  keepLiveIds,
  removePersistedOptimisticUserBlocks,
  snapshotCoverableCount,
} from './history-alignment'
import {
  fastModeFromMessages,
  messagesBeforeRevert,
  messagesBeforeTime,
  newestMessageAt,
  queuedMessagesFromHistory,
  revertBoundaryTime,
} from './history-rows'
import { toPendingQuestion } from './sse-questions'
import type { AgentStore, AgentStream, StoreGet, StoreSet } from './types'
import type { ContentBlock, MessageResponse } from '@/api/types'

/**
 * Replace a stream's confirmed rows with a history page's, applying the
 * revert boundary. Provider errors only this client saw (they never persist)
 * are kept. ``keepLive``: the live blocks hold newer content and stay, so
 * their blob URLs must too.
 */
function installPage(
  stream: AgentStream,
  messages: MessageResponse[],
  keepLive: boolean,
  revertTime: number | null,
  boundary: { boundaryId?: string; boundaryContent?: string | null },
) {
  const localErrors = [...stream.blocks, ...stream.currentBlocks].filter(
    (b) => b.type === 'provider_status' && (b.extra?.status === 'error' || b.extra?.status === 'exhausted' || b.extra?.category === 'provider'),
  )
  if (!keepLive) revokeBlobUrlsFromBlocks(stream.currentBlocks)
  const orphans: Record<string, OrphanToolResult> = {}
  stream.blocks = parseAgentBlocks(messages, orphans)
  // Results whose calls sit in older, not-yet-loaded pages — parked for
  // loadOlderMessages to attach when the owning card scrolls in.
  stream._orphanToolResults = orphans
  if (localErrors.length > 0) {
    const existingIds = new Set(stream.blocks.map((b) => b.id))
    const toKeep = localErrors.filter((b) => !existingIds.has(b.id))
    stream.blocks = [...stream.blocks, ...toKeep]
  }
  stream._revertedSuffix = []
  applyRevertBoundary(stream, revertTime, boundary)
}

/**
 * Restore a stream's usage from a history page and the server's totals.
 *
 * The server sums the WHOLE session (every page, compaction summaries
 * included), while the visible page only carries the newest
 * `_HISTORY_PAGE_SIZE` rows — a client-side sum over it undercounts longer
 * sessions. Prefer the authoritative total, but never regress below the live
 * SSE value (an in-flight turn may hold events the server has not persisted
 * yet). promptTokens/cachedTokens stay page-derived: they describe the
 * *latest* call, which is always in the newest page. A stream with newer live
 * content keeps its own latest-call figures.
 */
function restoreUsage(
  stream: AgentStream,
  visibleMessages: MessageResponse[],
  totals: { estimated_cost_usd?: number | null; completion_tokens?: number | null },
  keepLive: boolean,
) {
  const pageUsage = sumUsageFromMessages(visibleMessages)
  const prevEstimatedCost = stream.usage?.estimatedCostUsd ?? 0
  const prevCompletionTokens = stream.usage?.completionTokens ?? 0
  const costUsd = typeof totals.estimated_cost_usd === 'number'
    ? totals.estimated_cost_usd
    : (pageUsage.estimatedCostUsd ?? 0)
  const completionTotal = typeof totals.completion_tokens === 'number'
    ? totals.completion_tokens
    : pageUsage.completionTokens
  if (!keepLive) stream.usage = pageUsage
  else stream.usage.promptTokens = stream.usage.promptTokens || pageUsage.promptTokens
  stream.usage.completionTokens = Math.max(prevCompletionTokens, completionTotal)
  stream.usage.estimatedCostUsd = Math.round(Math.max(prevEstimatedCost, costUsd) * 1e8) / 1e8
  stream.usage.totalTokens = stream.usage.promptTokens + stream.usage.completionTokens
}

// Keyed by session generation, id and workspace. Coalesces concurrent
// `loadSession` calls for the same visit to a session — see the comment on
// `loadSessionOnce` below.
const inflightLoadSession = new Map<string, Promise<void>>()

function loadSessionKey(generation: number, sessionId: string, workspace?: string | null) {
  return `${generation}\u0000${sessionId}\u0000${workspace ?? ''}`
}

async function loadSessionImpl(
  get: () => AgentStore,
  set: (fn: (draft: AgentStore) => void) => void,
  sessionId: string,
  workspace?: string | null,
): Promise<void> {
  const gen = get()._sessionGeneration
  const settingsVersion = get()._sessionSettingsVersion
  // A fresh open (history not here yet) may take the page a sidebar hover
  // prefetched. Its earlier start time only treats more live content as
  // newer than the page, which keeps it.
  const prefetched = get().isLoadingHistory ? takePrefetchedHistory(sessionId) : null
  const fetchStartedAt = prefetched?.startedAt ?? Date.now()
  // How much live content each stream held before the request went out, so
  // the resolve path can tell it apart from anything appended since.
  const liveCountsAtFetch = new Map(
    Object.entries(get().agentStreams).map(([name, s]) => [name, s.currentBlocks.length]),
  )
  // The question on screen when the request went out. If the live stream
  // changed it during the fetch (asked, answered, dismissed), the stream is
  // newer than the response: a response fetched before a review opened
  // cleared the live card, and the agent looked stuck until the next reload.
  const questionIdAtFetch = get().pendingQuestion?.id ?? null
  set((draft) => {
    if (draft.sessionId !== sessionId) {
      draft.isAgentWorking = false
    }
  })
  try {
    const liveNames = get().liveAgentNames
    const history = await (prefetched?.promise.catch(() => sessionHistory(sessionId)) ?? sessionHistory(sessionId))

    if (get()._sessionGeneration !== gen) return

    set((draft) => {
      draft.sessionId = sessionId
      draft.parentSessionId = history.lead.parent_session_id ?? null
      draft.sessionTitle = history.lead.title ?? null
      draft.sessionSentFrom = history.lead.sent_from ?? null
      draft.sessionInteractionMode = history.lead.interaction_mode ?? 'code'
      draft.sessionPendingInteractionMode = history.lead.pending_interaction_mode ?? null
      if (!draft._sessionSettingsDirty && draft._sessionSettingsVersion === settingsVersion) {
        draft.sessionModel = history.lead.model ?? null
        draft.sessionThinkingLevel = history.lead.thinking_level ?? null
        draft.sessionCredentialId = history.lead.credential_id ?? null
      }
      draft.sessionFastMode = fastModeFromMessages(history.lead.messages)
      draft.error = null
      Object.values(draft.agentStreams).forEach((stream) => {
        stream.revertedCount = 0
        stream.revertedMessages = []
      })

      const memberNames = history.members.map((m) => m.name)
      const isSubagentSession = Boolean(history.lead.parent_session_id)
      const leadName =
        history.lead.agent_name || (isSubagentSession ? 'member' : 'code')
      draft.leadName = leadName
      if (liveNames !== null) draft.liveAgentNames = liveNames

      const allNames = Array.from(new Set([leadName, ...(liveNames ?? []), ...memberNames]))
      draft.agentNames = allNames

      // Prune streams from previously viewed sessions that do not belong here
      const validStreamNames = new Set([leadName, ...memberNames])
      Object.keys(draft.agentStreams).forEach((streamName) => {
        if (!validStreamNames.has(streamName)) {
          delete draft.agentStreams[streamName]
        }
      })

      const leadRevertTime = revertBoundaryTime(history.lead)
      const boundaryId = history.lead.revert?.message_id
      const boundaryMsg = boundaryId ? history.lead.messages.find((msg) => msg.id === boundaryId) : undefined
      const boundary = { boundaryId, boundaryContent: boundaryMsg?.content }

      // The client's `isAgentWorking` lags the server: after a /stop the
      // backend keeps unwinding for seconds before its trailing `done` clears
      // the flag, and `session_turn_completed` can arrive over the global
      // stream ahead of that `done` too. When the server says the turn is
      // over it had already persisted it in full, so every live block from
      // before this fetch is now duplicated by the canonical rows below —
      // preserving them is what let the belated `done` append the turn twice.
      // Drop them up front; everything downstream then sees only genuinely
      // newer content and needs no special casing.
      const turnStillRunning = history.lead.running === true
      // Read before this page overwrites it; a switch to another session
      // cleared it when the request went out.
      const believedRunning = draft.isAgentWorking
      // What each stream showed before this page lands (before the covered
      // live blocks are dropped), so a just-finished turn keeps its ids.
      const shownBefore = new Map<string, readonly ContentBlock[]>()
      Object.entries(draft.agentStreams).forEach(([name, stream]) => {
        shownBefore.set(name, [...readBlocks(stream.blocks), ...readBlocks(stream.currentBlocks)])
      })
      if (!turnStillRunning) {
        Object.entries(draft.agentStreams).forEach(([name, stream]) => {
          dropSnapshotCoveredBlocks(
            stream,
            snapshotCoverableCount(stream, fetchStartedAt, liveCountsAtFetch.get(name) ?? 0, 0),
          )
        })
      }

      // Computed against the stream identified by the *resolved* leadName,
      // before anything below overwrites it — see hasLiveContent.
      // Durable, so it outranks whatever the client last saw: a card the user
      // has not resolved is still on the table after a reload, an app restart,
      // or a switch to another device.
      const historyQuestion = history.pending_question
        ? toPendingQuestion(history.pending_question)
        : null
      const liveQuestionChanged = (draft.pendingQuestion?.id ?? null) !== questionIdAtFetch
      const restoredQuestion = liveQuestionChanged ? draft.pendingQuestion : historyQuestion
      const awaitingAnswer = restoredQuestion !== null
      if (!liveQuestionChanged) {
        // The server closed the card this client showed (another window, a
        // stop or dismissal whose event it missed): record that, or the card
        // would fall back to its persisted placeholder and "wait" for good.
        if (draft.pendingQuestion && draft.pendingQuestion.id !== historyQuestion?.id) {
          applyQuestionResolution(draft, draft.pendingQuestion.id, null, 'resolved_elsewhere')
        }
        draft.pendingQuestion = historyQuestion
      }
      // A review restored here may be for a plan revision this client never
      // saw written.
      if (restoredQuestion?.kind === 'plan_review') {
        draft.cacheInvalidations.push({ kind: 'plan', sessionId })
      }

      const leadHadNewerActivity = leadName
        ? hasLiveContent(draft.agentStreams[leadName], draft.isAgentWorking, fetchStartedAt)
        : false
      if (!leadHadNewerActivity) {
        // After a daemon restart the stream store has forgotten the turn, so
        // ``running`` is false while the question row says otherwise. The row is
        // the durable half, so it wins.
        draft.isAgentWorking =
          history.lead.running === true ||
          history.members.some((m) => m.running === true) ||
          awaitingAnswer
      }

      if (leadName) {
        if (!draft.agentStreams[leadName]) {
          draft.agentStreams[leadName] = createDefaultAgentStream()
        }
        const leadStream = draft.agentStreams[leadName]
        installPage(leadStream, history.lead.messages, leadHadNewerActivity, leadRevertTime, boundary)
        if (leadHadNewerActivity) {
          // A running turn keeps its live tail (the in-flight part is not in
          // the snapshot yet), so strip whatever the snapshot already covers
          // instead of rendering both copies.
          if (turnStillRunning) {
            dropSnapshotAlignedPrefix(
              leadStream,
              snapshotCoverableCount(
                leadStream,
                fetchStartedAt,
                liveCountsAtFetch.get(leadName) ?? 0,
                leadStream.currentBlocks.length,
              ),
            )
          }
          removePersistedOptimisticUserBlocks(leadStream)
          // The page may have just committed the bubble that showed the send
          // was pending. When the server says the turn runs and this client
          // still expects it to, the lead reads as working without waiting
          // for a stream frame; otherwise the transcript looks finished.
          // Only from idle: a live frame that failed or parked the lead since
          // the page was read is newer than the page.
          if (turnStillRunning && !awaitingAnswer && draft.isAgentWorking && leadStream.status === 'idle') {
            leadStream.status = 'working'
          }
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
        // A turn that just ended keeps its live ids, so it is not rebuilt.
        keepLiveIds(leadStream, shownBefore.get(leadName))
        // No restart bookkeeping needed here: the status assigned above is the
        // snapshot's verdict, and `isAwaitingRestartOutput` only reports a
        // pending restart for a `working` stream. A turn the server says has
        // ended (`idle`) or parked on another question (`waiting_input`) stops
        // matching on its own — which is what keeps the dots from stranding
        // when a reconnecting client missed the whole resumed turn.
        restoreUsage(leadStream, messagesBeforeRevert(history.lead), history.lead, leadHadNewerActivity)
      }

      const confirmedUser = history.lead.messages.filter(
        (m) => m.role === 'user' && m.kind !== 'queued' && m.extra?.queue_status !== 'queued',
      )
      // Queued messages always carry their server id, so they are matched by
      // id alone: matching text dropped any queued "yes" or "continue" the
      // session had already sent once.
      const confirmedUserIds = new Set(confirmedUser.map((m) => m.id))

      const queued = queuedMessagesFromHistory(sessionId, history.lead.messages).filter(
        (msg) => !confirmedUserIds.has(msg.id),
      )
      const queuedIds = new Set(queued.map((msg) => msg.id))
      draft._pendingMessages = [
        ...draft._pendingMessages.filter((msg) => {
          if (msg.sessionId !== sessionId) return true
          if (confirmedUserIds.has(msg.id)) return false
          return queuedIds.has(msg.id) || (msg.submittedAt !== undefined && msg.submittedAt >= fetchStartedAt)
        }),
        ...queued.filter((msg) => !draft._pendingMessages.some((existing) => existing.id === msg.id)),
      ]

      history.members.forEach((member) => {
        const existingStatus = draft.agentStreams[member.name]?.status
        const isLiveMember = liveNames === null || liveNames.includes(member.name)
        if (!draft.agentStreams[member.name]) {
          draft.agentStreams[member.name] = createDefaultAgentStream()
        }
        const memberStream = draft.agentStreams[member.name]
        const memberHadNewerActivity = hasLiveContent(memberStream, draft.isAgentWorking, fetchStartedAt)
        installPage(memberStream, member.messages, memberHadNewerActivity, leadRevertTime, boundary)
        if (memberHadNewerActivity && turnStillRunning) {
          dropSnapshotAlignedPrefix(
            memberStream,
            snapshotCoverableCount(
              memberStream,
              fetchStartedAt,
              liveCountsAtFetch.get(member.name) ?? 0,
              memberStream.currentBlocks.length,
            ),
          )
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
        keepLiveIds(memberStream, shownBefore.get(member.name))
        restoreUsage(memberStream, messagesBeforeTime(member.messages, leadRevertTime), member, memberHadNewerActivity)
      })

      draft.hasMore = history.has_more
      draft.nextCursor = history.next_cursor
      draft.pinnedPrompt = history.latest_prompt ? parseAgentBlocks([history.latest_prompt])[0] ?? null : null
      draft.isLoadingHistory = false
      draft._leadRevertTime = leadRevertTime
      draft.revertKeepsFiles = history.lead.revert?.keep_files === true
      // Everything in this response is server-confirmed, so nothing is
      // pending reconciliation and the watermark advances to its newest row.
      draft._syncedThrough = newestMessageAt(history)
      Object.values(draft.agentStreams).forEach((stream) => {
        stream._unsyncedBlockIds = []
      })
      draft._workspace = workspace ?? null
      draft._loadingOlder = false
      draft._resolvedSessionReadyId = null
      // The sidebar row follows the same verdict as the transcript, so a
      // session opened mid-turn (or reloaded before a stream frame) is marked
      // running, and one this store took for running is cleared when the page
      // says the turn is over: with the event feed down, this page is the
      // only word of that. A session waiting on an answer is left alone: the
      // patch would clear the row's needs-input mark.
      if (!awaitingAnswer) {
        if (turnStillRunning && draft._runningPatchedFor !== sessionId) {
          draft._runningPatchedFor = sessionId
          draft.cacheInvalidations.push({ kind: 'session_running', sessionId, running: true })
        } else if (!turnStillRunning && !leadHadNewerActivity && believedRunning) {
          draft._runningPatchedFor = null
          draft.cacheInvalidations.push({ kind: 'session_running', sessionId, running: false })
        }
      }
    })

    if (liveNames === null && get()._sessionGeneration === gen) {
      void get().loadAgentStatus(workspace, gen, sessionId)
    }
  } catch (err) {
    if (get()._sessionGeneration !== gen) return
    set((draft) => {
      // A dropped connection is the banner's to report, and the reconnect
      // reloads this session: an error here stayed on screen after both.
      if (!isTransientNetworkError(err)) draft.error = err instanceof Error ? err.message : "Couldn't load session"
      draft.isLoadingHistory = false
    })
  }
}

export function loadSessionOnce(
  get: StoreGet,
  set: StoreSet,
  sessionId: string,
  workspace?: string | null,
): Promise<void> {
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
  // A fetch from an earlier visit (left and reopened while it was out)
  // discards its own answer, so it must not stand in for this one.
  const inflightKey = loadSessionKey(get()._sessionGeneration, sessionId, workspace)
  const existing = inflightLoadSession.get(inflightKey)
  if (existing) return existing
  const promise = loadSessionImpl(get, set, sessionId, workspace).finally(() => {
    if (inflightLoadSession.get(inflightKey) === promise) inflightLoadSession.delete(inflightKey)
  })
  inflightLoadSession.set(inflightKey, promise)
  return promise
}

/** Let the next load of this visit fetch afresh instead of joining the one in flight. */
export function forgetInflightLoad(generation: number, sessionId: string, workspace?: string | null) {
  inflightLoadSession.delete(loadSessionKey(generation, sessionId, workspace))
}
