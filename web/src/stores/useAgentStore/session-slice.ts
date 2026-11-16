/**
 * The open session itself: which session and agents are on screen, opening and
 * leaving it, its run settings and interaction mode, and the workspace's
 * agent roster. Its history lives in history-slice.ts.
 */
import { failureSentence } from '@/lib/failure-toast'
import type { StateCreator } from 'zustand'
import { agentStatus, updateSessionInteractionMode, updateSessionRunSettings } from '@/api/client'
import { useToastStore } from '@/stores/useToastStore'
import { isTransientNetworkError } from '@/utils/errors'
import { createDefaultAgentStream } from './defaults'
import { clearReconnectTimer } from './stream-slice'
import type { AgentStream, AgentStore } from './types'
import type { SessionInteractionMode } from '@/api/types'

function hasVisibleBlocks(stream: AgentStream | undefined): boolean {
  if (!stream) return false
  return [...stream.blocks, ...stream.currentBlocks].some((block) => block.type !== 'compaction')
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
  | '_leadRevertTime'
  | 'revertKeepsFiles'
  | '_workspace'
  | '_resolvedSessionReadyId'
  | 'newSession'
  | 'beginResolvedSession'
  | 'isEmptyIdleSession'
  | 'consumeResolvedSessionReady'
  | 'setSessionInteractionMode'
  | 'setSessionModelSettings'
  | 'setSessionRunSettings'
  | 'loadAgentStatus'
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
  _leadRevertTime: null,
  revertKeepsFiles: false,
  _workspace: null,
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
})
