import type { StateCreator } from 'zustand'
import { teamStatus, teamHistory } from '@/api/client'
import { parseTeamBlocks, sumUsageFromMessages } from '@/utils/messages'
import { createDefaultAgentStream } from './defaults'
import { applyRevertBoundary, revokeBlobUrlsFromBlocks } from './helpers'
import { clearReconnectTimer } from './stream-slice'
import type { AgentStream, TeamStore } from './types'
import type { MessageResponse } from '@/api/types'

function revertBoundaryTime(session: { revert?: { message_id?: string } | null; messages: MessageResponse[] }): number | null {
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

export function resetSessionState(
  state: TeamStore,
  options: {
    sessionId: string | null
    model?: string | null
    thinkingLevel?: string | null
    fastMode?: boolean
    mode?: string
    workspace?: string | null
  },
) {
  const leadName = state.leadName ?? state.agentNames[0] ?? null
  state.sessionId = options.sessionId
  state.sessionTitle = null
  state.sessionModel = options.model ?? null
  state.sessionThinkingLevel = options.thinkingLevel ?? null
  state.sessionFastMode = options.fastMode ?? false
  state.isTeamWorking = false
  state.isContinuing = false
  state.isConnected = false
  state.error = null
  state.setupRequired = null
  state._abortController = null
  state._pendingMessages = []
  clearReconnectTimer(state)
  state._reconnectAttempts = 0
  state._sessionGeneration = (state._sessionGeneration ?? 0) + 1
  state.cacheInvalidations = []
  state.hasMore = false
  state.nextCursor = null
  state._leadRevertTime = null
  state._workspace = options.mode === 'coding' ? (options.workspace ?? null) : null
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
    state.agentStreams[name]._completionBase = 0
    state.agentStreams[name]._completionEstimated = 0
    state.agentStreams[name]._turnStartedAt = null
    state.agentStreams[name].revertedCount = 0
    state.agentStreams[name].revertedMessages = []
    state.agentStreams[name]._revertedSuffix = []
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
  | 'sessionFastMode'
  | '_sessionGeneration'
  | 'hasMore'
  | 'nextCursor'
  | '_leadRevertTime'
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
  | 'loadOlderMessages'
  | 'setActiveAgent'
>

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
  sessionFastMode: false,
  _sessionGeneration: 0,
  hasMore: false,
  nextCursor: null,
  _leadRevertTime: null,
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
    get()._abortController?.abort()
    set((state) => {
      resetSessionState(state, {
        sessionId,
        model: options?.model,
        thinkingLevel: options?.thinkingLevel,
        fastMode: options?.fastMode,
        mode: options?.mode,
        workspace: options?.workspace,
      })
      if (options?.skipInitialRestore) state._resolvedSessionReadyId = sessionId
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
      state._workspace !== expectedWorkspace ||
      !state.isEmptyIdleSession()
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
      if (fastMode !== undefined) draft.sessionFastMode = fastMode
    })
  },

  loadTeamStatus: async (workspace?: string | null, expectedGeneration?: number) => {
    try {
      const status = await teamStatus(workspace)
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
            if (agent.state === 'working') {
              draft.agentStreams[agent.name]._turnStartedAt ??= Date.now()
            }
            draft.agentStreams[agent.name].model = agent.model
          })
          historicalNames.forEach((name) => {
            const stream = draft.agentStreams[name]
            if (stream && name !== status.lead.name && stream.status !== 'error') {
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
    const gen = get()._sessionGeneration
    set((draft) => {
      draft.isTeamWorking = false
      draft.isContinuing = false
    })
    try {
      const liveNames = get().liveAgentNames
      const history = await teamHistory(sessionId)

      if (get()._sessionGeneration !== gen) return

      set((draft) => {
        draft.sessionId = sessionId
        draft.sessionTitle = history.lead.title ?? null
        draft.sessionModel = history.lead.model ?? null
        draft.sessionThinkingLevel = history.lead.thinking_level ?? null
        draft.sessionFastMode = fastModeFromMessages(history.lead.messages)
        draft.isTeamWorking = history.lead.running === true
        draft.isContinuing = false
        draft.error = null
        Object.values(draft.agentStreams).forEach((stream) => {
          stream.revertedCount = 0
          stream.revertedMessages = []
        })

        const memberNames = history.members.map((m) => m.name)
        const leadName = history.lead.agent_name ?? liveNames?.[0] ?? draft.leadName
        draft.leadName = leadName
        if (liveNames !== null) draft.liveAgentNames = liveNames

        const allNames = leadName ? [leadName, ...memberNames] : memberNames
        draft.agentNames = allNames
        const leadRevertTime = revertBoundaryTime(history.lead)

        if (leadName) {
          if (!draft.agentStreams[leadName]) {
            draft.agentStreams[leadName] = createDefaultAgentStream()
          }
          revokeBlobUrlsFromBlocks(draft.agentStreams[leadName].currentBlocks)
          const leadStream = draft.agentStreams[leadName]
          leadStream.blocks = parseTeamBlocks(history.lead.messages)
          leadStream._revertedSuffix = []
          applyRevertBoundary(leadStream, leadRevertTime)
          leadStream.currentBlocks = []
          leadStream.currentText = ''
          leadStream.currentThinking = ''
          leadStream.status = history.lead.running === true ? 'working' : 'idle'
          leadStream._turnStartedAt = history.lead.running === true ? Date.now() : null
          const leadVisibleMsgs = messagesBeforeRevert(history.lead)
          const leadUsage = sumUsageFromMessages(leadVisibleMsgs)
          leadStream.usage = leadUsage
          leadStream._completionBase = leadUsage.completionTokens
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
          revokeBlobUrlsFromBlocks(draft.agentStreams[member.name].currentBlocks)
          const memberStream = draft.agentStreams[member.name]
          memberStream.blocks = parseTeamBlocks(member.messages)
          memberStream._revertedSuffix = []
          applyRevertBoundary(memberStream, leadRevertTime)
          memberStream.currentBlocks = []
          memberStream.currentText = ''
          memberStream.currentThinking = ''
          memberStream.status =
            !isLiveMember
              ? 'offline'
              : existingStatus === 'offline' || existingStatus === 'error' ? existingStatus : 'idle'
          memberStream._turnStartedAt = null
          const memberVisibleMsgs = messagesBeforeTime(member.messages, leadRevertTime)
          const memberUsage = sumUsageFromMessages(memberVisibleMsgs)
          memberStream.usage = memberUsage
          memberStream._completionBase = memberUsage.completionTokens
        })

        if (!draft.activeAgent || !allNames.includes(draft.activeAgent)) {
          draft.activeAgent = leadName ?? allNames[0] ?? null
        }

        draft.hasMore = history.has_more
        draft.nextCursor = history.next_cursor
        draft._leadRevertTime = revertBoundaryTime(history.lead)
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
        draft.isContinuing = false
      })
    }
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
          const older = parseTeamBlocks(filtered)
          draft.agentStreams[leadName].blocks = [...older, ...draft.agentStreams[leadName].blocks]
        }
        history.members.forEach((member) => {
          if (draft.agentStreams[member.name]) {
            const filtered = messagesBeforeTime(member.messages, _leadRevertTime)
            const older = parseTeamBlocks(filtered)
            draft.agentStreams[member.name].blocks = [...older, ...draft.agentStreams[member.name].blocks]
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
