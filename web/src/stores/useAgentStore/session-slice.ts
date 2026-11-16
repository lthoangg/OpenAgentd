import { failureSentence } from '@/lib/failure-toast'
import type { StateCreator } from 'zustand'
import { agentStatus, sessionHistory, sessionHistorySince, updateSessionInteractionMode, updateSessionRunSettings } from '@/api/client'
import { useToastStore } from '@/stores/useToastStore'
import { applyOrphanToolResults, isPromptMessage, parseAgentBlocks } from '@/utils/messages'
import { readBlocks } from '@/utils/blocks'
import { isTransientNetworkError } from '@/utils/errors'
import { createDefaultAgentStream } from './defaults'
import { dropSnapshotAlignedPrefix } from './history-alignment'
import { deltaRows, holdsUnseenRows, messagesBeforeTime, newestMessageAt, queuedMessagesFromHistory, toolResultsOf } from './history-rows'
import { adoptLiveBlockIds } from './helpers'
import { forgetInflightLoad, loadSessionOnce } from './load-session'
import { clearReconnectTimer } from './stream-slice'
import type { AgentStream, AgentStore } from './types'
import type { ContentBlock, MessageResponse, SessionHistoryResponse, SessionInteractionMode } from '@/api/types'

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

function hasVisibleBlocks(stream: AgentStream | undefined): boolean {
  if (!stream) return false
  return [...stream.blocks, ...stream.currentBlocks].some((block) => block.type !== 'compaction')
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

function resetSessionState(
  state: AgentStore,
  options: {
    sessionId: string | null
    interactionMode?: SessionInteractionMode
    model?: string | null
    thinkingLevel?: string | null
    credentialId?: string | null
    fastMode?: boolean
    workspace?: string | null
  },
) {
  const leadCandidate = state.leadName && !state.leadName.includes('#') ? state.leadName : null
  const fallbackCandidate = state.agentNames.find((n) => !n.includes('#')) ?? null
  const leadName = leadCandidate ?? fallbackCandidate ?? (state.leadName ?? state.agentNames[0] ?? null)
  state.sessionId = options.sessionId
  state.parentSessionId = null
  state.sessionTitle = null
  state.sessionSentFrom = null
  state.sessionInteractionMode = options.interactionMode ?? 'code'
  state.sessionPendingInteractionMode = null
  state.sessionModel = options.model ?? null
  state.sessionThinkingLevel = options.thinkingLevel ?? null
  state.sessionCredentialId = options.credentialId ?? null
  state._sessionSettingsDirty = false
  state._sessionSettingsVersion = (state._sessionSettingsVersion ?? 0) + 1
  state.sessionFastMode = options.fastMode ?? false
  state.isAgentWorking = false
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
  state._silentStreamAttempts = 0
  state._sessionGeneration = (state._sessionGeneration ?? 0) + 1
  state.cacheInvalidations = []
  state._runningPatchedFor = null
  state.hasMore = false
  state.nextCursor = null
  state.pinnedPrompt = null
  // A saved session's history is not here yet; a draft has none to wait for.
  state.isLoadingHistory = options.sessionId !== null
  state._leadRevertTime = null
  state.revertKeepsFiles = false
  state._syncedThrough = null
  state._workspace = options.workspace ?? null
  state._loadingOlder = false
  state._resolvedSessionReadyId = null
  state.agentNames = leadName ? [leadName] : []
  state.liveAgentNames = leadName ? [leadName] : null

  Object.keys(state.agentStreams).forEach((name) => {
    if (!leadName || name !== leadName) {
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
  AgentStore,
  | 'leadName'
  | 'agentNames'
  | 'liveAgentNames'
  | 'sessionId'
  | 'parentSessionId'
  | 'sessionTitle'
  | 'sessionSentFrom'
  | 'sessionInteractionMode'
  | 'sessionPendingInteractionMode'
  | 'sessionModel'
  | 'sessionThinkingLevel'
  | 'sessionCredentialId'
  | '_sessionSettingsDirty'
  | '_sessionSettingsVersion'
  | 'sessionFastMode'
  | '_sessionGeneration'
  | '_runningPatchedFor'
  | 'hasMore'
  | 'nextCursor'
  | 'pinnedPrompt'
  | 'isLoadingHistory'
  | '_leadRevertTime'
  | 'revertKeepsFiles'
  | '_syncedThrough'
  | '_workspace'
  | '_loadingOlder'
  | '_resolvedSessionReadyId'
  | 'newSession'
  | 'beginResolvedSession'
  | 'isEmptyIdleSession'
  | 'consumeResolvedSessionReady'
  | 'setSessionInteractionMode'
  | 'setSessionModelSettings'
  | 'setSessionRunSettings'
  | 'loadAgentStatus'
  | 'loadSession'
  | 'reconcileTurnTail'
  | 'fillAttachGap'
  | 'catchUpLiveTurn'
  | 'loadOlderMessages'
  | 'loadOlderUntilPrompt'
  | '_alignLiveWithHistory'
>

export const createSessionSlice: StateCreator<
  AgentStore,
  [['zustand/immer', never]],
  [],
  SessionSlice
> = (set, get) => ({
  leadName: null,
  agentNames: [],
  liveAgentNames: null,
  sessionId: null,
  parentSessionId: null,
  sessionTitle: null,
  sessionSentFrom: null,
  sessionInteractionMode: 'code',
  sessionPendingInteractionMode: null,
  sessionModel: null,
  sessionThinkingLevel: null,
  sessionCredentialId: null,
  _sessionSettingsDirty: false,
  _sessionSettingsVersion: 0,
  sessionFastMode: false,
  _sessionGeneration: 0,
  _runningPatchedFor: null,
  hasMore: false,
  nextCursor: null,
  pinnedPrompt: null,
  isLoadingHistory: false,
  _leadRevertTime: null,
  revertKeepsFiles: false,
  _syncedThrough: null,
  _workspace: null,
  _loadingOlder: false,
  _resolvedSessionReadyId: null,

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
      get().isAgentWorking ||
      Boolean(
        get().leadName &&
          get().agentStreams[get().leadName!]?.currentBlocks.length > 0,
      )
    if (staysOnSameSession && isWorkingOrHasBlocks) {
      set((state) => {
        if (sessionId) state.sessionId = sessionId
        if (options?.interactionMode) state.sessionInteractionMode = options.interactionMode
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
    const localCredentialId = get().sessionCredentialId
    set((state) => {
      resetSessionState(state, {
        sessionId,
        interactionMode: options?.interactionMode,
        model: preserveLocalSettings ? localModel : options?.model,
        thinkingLevel: preserveLocalSettings ? localThinkingLevel : options?.thinkingLevel,
        credentialId: preserveLocalSettings ? localCredentialId : options?.credentialId,
        fastMode: options?.fastMode,
        workspace: options?.workspace,
      })
      if (options?.skipInitialRestore) {
        // Created here just now: there is no history to wait for.
        state._resolvedSessionReadyId = sessionId
        state.isLoadingHistory = false
      }
      if (preserveLocalSettings) state._sessionSettingsDirty = true
    })
  },

  isEmptyIdleSession: () => {
    const state = get()
    // A session whose history is still loading only looks empty.
    if (!state.sessionId || state.isAgentWorking || state.isLoadingHistory) return false
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

  setSessionRunSettings: async (patch) => {
    const before = {
      model: get().sessionModel,
      thinkingLevel: get().sessionThinkingLevel,
      credentialId: get().sessionCredentialId,
    }
    set((draft) => {
      if (patch.model !== undefined) draft.sessionModel = patch.model
      if (patch.thinkingLevel !== undefined) draft.sessionThinkingLevel = patch.thinkingLevel
      if (patch.credentialId !== undefined) draft.sessionCredentialId = patch.credentialId
      draft._sessionSettingsDirty = true
      draft._sessionSettingsVersion += 1
    })
    const sessionId = get().sessionId
    // A new-session draft has nothing to save yet: the first message carries it.
    if (!sessionId) return true
    const body: { model?: string | null; thinking_level?: string | null; credential_id?: string | null } = {}
    if (patch.model !== undefined) body.model = patch.model
    if (patch.thinkingLevel !== undefined) body.thinking_level = patch.thinkingLevel
    if (patch.credentialId !== undefined) body.credential_id = patch.credentialId
    try {
      const saved = await updateSessionRunSettings(sessionId, body)
      if (get().sessionId !== sessionId) return true
      set((draft) => {
        draft.sessionModel = saved.model ?? null
        draft.sessionThinkingLevel = saved.thinking_level ?? null
        draft.sessionCredentialId = saved.credential_id ?? null
        draft._sessionSettingsDirty = false
      })
      return true
    } catch (err) {
      if (get().sessionId !== sessionId) return false
      set((draft) => {
        draft.sessionModel = before.model
        draft.sessionThinkingLevel = before.thinkingLevel
        draft.sessionCredentialId = before.credentialId
      })
      // A toast, not `error`: the choice is put back, and Retry sends it again.
      useToastStore.getState().push({
        tone: 'error',
        title: "Couldn't save the run settings",
        description: failureSentence(err),
        action: { label: 'Retry', onAction: () => void get().setSessionRunSettings(patch) },
      })
      return false
    }
  },

  setSessionInteractionMode: async (mode) => {
    const sessionId = get().sessionId
    if (!sessionId) {
      // New-session draft: nothing to PATCH yet. Keep the pick locally; the
      // first message sends it and the session starts in that mode.
      if (get().isAgentWorking) return false
      set((draft) => {
        draft.sessionInteractionMode = mode
        draft.sessionPendingInteractionMode = null
      })
      return true
    }
    const effective = get().sessionPendingInteractionMode ?? get().sessionInteractionMode
    if (mode === effective) return true
    try {
      const session = await updateSessionInteractionMode(sessionId, mode)
      set((draft) => {
        if (draft.sessionId !== sessionId) return
        draft.sessionInteractionMode = session.interaction_mode ?? mode
        // The backend queues a switch requested mid-turn rather than stopping
        // the turn, so the toggle tracks the queued mode until it lands.
        draft.sessionPendingInteractionMode = session.pending_interaction_mode ?? null
        draft.isAgentWorking = session.running === true
        draft.error = null
      })
      return true
    } catch (err) {
      set((draft) => {
        draft.error = err instanceof Error ? err.message : "Couldn't switch interaction mode"
      })
      return false
    }
  },

  loadAgentStatus: async (workspace?: string | null, expectedGeneration?: number, sessionId?: string | null) => {
    try {
      const currentSessionId = sessionId === undefined ? get().sessionId : sessionId
      const status = await agentStatus(workspace, currentSessionId)
      if (expectedGeneration !== undefined && get()._sessionGeneration !== expectedGeneration) return
      if (status) {
        const allAgents = [status.lead, ...status.members]
        const liveNames = allAgents.map((a) => a.name)
        set((draft) => {
          // The roster describes the workspace's lead agent. A subagent
          // session runs its own agent, which its history names; applying the
          // roster there pointed the view at an empty lead stream, and the
          // subagent's transcript and live output vanished.
          if (draft.parentSessionId && draft.sessionId === currentSessionId) return
          draft.leadName = status.lead.name
          draft.liveAgentNames = liveNames
          const historicalNames = draft.agentNames.filter((name) => !liveNames.includes(name))
          draft.agentNames = [...liveNames, ...historicalNames]
          allAgents.forEach((agent) => {
            if (!draft.agentStreams[agent.name]) {
              draft.agentStreams[agent.name] = createDefaultAgentStream()
            }
            // No run state is set from here: /agent/agents (which this is a
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
        })
      }
    } catch (err) {
      if (expectedGeneration !== undefined && get()._sessionGeneration !== expectedGeneration) return
      if (isTransientNetworkError(err)) return
      set((draft) => {
        draft.error = err instanceof Error ? err.message : "Couldn't load agent status"
      })
    }
  },

  loadSession: async (sessionId: string, workspace?: string | null) => loadSessionOnce(get, set, sessionId, workspace),

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
    if (since === null || !state.isAgentWorking || Object.values(state.agentStreams).some(hasUnsyncedCompaction)) {
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
      state.isAgentWorking ||
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
    if (delta.truncated || get().isAgentWorking) {
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
      draft.isAgentWorking = delta.lead.running === true
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
