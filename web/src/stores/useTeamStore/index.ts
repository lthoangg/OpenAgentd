import { create } from 'zustand'
import { immer } from 'zustand/middleware/immer'
import { cancelQueuedTeamMessage, postTeamChat, postTeamCommand, teamStream, teamStatus, teamHistory } from '@/api/client'
import { parseTeamBlocks, sumUsageFromMessages } from '@/utils/messages'
import { createDefaultAgentStream } from './defaults'
import { applyRevertBoundary, revokeBlobUrlsFromBlocks } from './helpers'
import { createSSEHandler } from './sse-reducer'
import { useToastStore } from '@/stores/useToastStore'
import { isTransientNetworkError } from '@/utils/errors'
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
    }))
}

function fastModeFromMessages(messages: MessageResponse[]): boolean {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const msg = messages[index]
    if (msg.role === 'user') return msg.extra?.service_tier === 'fast'
  }
  return false
}

function effectiveLeadModel(state: TeamStore, leadName: string | null, requestedModel?: string | null): string | null {
  return requestedModel ?? state.sessionModel ?? (leadName ? state.agentStreams[leadName]?.model : null) ?? null
}

function hasVisibleBlocks(stream: AgentStream | undefined): boolean {
  if (!stream) return false
  return [...stream.blocks, ...stream.currentBlocks].some((block) => block.type !== 'compaction')
}

function resetSessionState(
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
  state.activeLoop = null
  state.setupRequired = null
  state._abortController = null
  state._pendingMessages = []
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

export type {
  ActiveLoop,
  AgentStream,
  CacheInvalidation,
  PendingMessage,
  TeamStoreState,
  TeamStoreActions,
  TeamStore,
} from './types'

function mergeChangedPaths(
  changed: { added: string[]; modified: string[]; removed: string[] } | undefined,
): string[] | undefined {
  if (!changed) return undefined
  const seen = new Set<string>()
  for (const p of changed.added) seen.add(p)
  for (const p of changed.modified) seen.add(p)
  for (const p of changed.removed) seen.add(p)
  return [...seen]
}

function enqueueWorkspaceInvalidation(
  set: (fn: (draft: TeamStore) => void) => void,
  get: () => TeamStore,
  sessionId: string,
  paths?: string[],
) {
  const workspace = get()._workspace
  if (workspace && paths !== undefined) {
    if (paths.length === 0) return
    set((draft) => {
      draft.cacheInvalidations.push({
        kind: 'coding_workspace_paths',
        workspace,
        paths,
      })
    })
    return
  }
  set((draft) => {
    draft.cacheInvalidations.push(
      workspace
        ? { kind: 'coding_workspace', workspace }
        : { kind: 'workspace_files', sessionId },
    )
  })
}

export const useTeamStore = create<TeamStore>()(
  immer((set, get) => ({
    agentStreams: {},
    activeAgent: null,
    leadName: null,
    agentNames: [],
    liveAgentNames: null,
    sidebarOpen: false,
    sessionId: null,
    sessionTitle: null,
    sessionModel: null,
    sessionThinkingLevel: null,
    sessionFastMode: false,
    isTeamWorking: false,
    isContinuing: false,
    isConnected: false,
    error: null,
    activeLoop: null,
    setupRequired: null,
    _pendingMessages: [],
    _abortController: null,
    _sessionGeneration: 0,
    cacheInvalidations: [],
    hasMore: false,
    nextCursor: null,
    _leadRevertTime: null,
    _workspace: null,
    _loadingOlder: false,
    _resolvedSessionReadyId: null,
    _unloading: false,

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

    sendMessage: async (content: string, files?: File[], options?: { mode?: string; workspace?: string | null; model?: string | null; thinkingLevel?: string | null; fastMode?: boolean; shell?: boolean }) => {
      const { leadName, agentStreams } = get()
      const leadWorking = leadName ? agentStreams[leadName]?.status === 'working' : false

      if (leadWorking) {
        if (files && files.length > 0) {
          set((draft) => {
            draft.error = 'Files cannot be queued yet. Wait for this response to finish, then send the attachment.'
          })
          return
        }
        try {
          const result = await postTeamChat(
            content,
            get().sessionId,
            false,
            files,
            options?.mode ?? 'normal',
            options?.workspace ?? null,
            options?.model ?? get().sessionModel,
            options?.thinkingLevel ?? get().sessionThinkingLevel,
            options?.shell ?? false,
            options?.fastMode ?? get().sessionFastMode,
          )
          if (result.status === 'queued' && !result.message_id) {
            throw new Error('Backend did not return a queued message id')
          }
          set((draft) => {
            draft.sessionId = result.session_id
            draft.sessionModel = options?.model ?? get().sessionModel
            draft.sessionThinkingLevel = options?.thinkingLevel ?? get().sessionThinkingLevel
            draft._pendingMessages.push({
              id: result.message_id ?? '',
              sessionId: result.session_id,
              content,
              submittedAt: Date.now(),
            })
            draft.error = null
          })
        } catch (err) {
          set((draft) => {
            draft.error = err instanceof Error ? err.message : 'Failed to queue message'
          })
        }
        return
      }

      get()._abortController?.abort()

      const optimisticAttachments = files?.map((f) => ({
        original_name: f.name,
        media_type: f.type,
        category: (f.type.startsWith('image/') ? 'image' : 'document') as 'image' | 'document' | 'text',
        url: f.type.startsWith('image/') ? URL.createObjectURL(f) : undefined,
      }))

      const submittedAt = Date.now()
      set((draft) => {
          draft.isTeamWorking = true
          draft.isContinuing = false
          draft.error = null
          draft.setupRequired = null
        draft._leadRevertTime = null
        Object.values(draft.agentStreams).forEach((stream) => {
          stream._revertedSuffix = []
          stream.revertedCount = 0
          stream.revertedMessages = []
        })
        if (leadName && draft.agentStreams[leadName]) {
          draft.agentStreams[leadName]._turnStartedAt = submittedAt
          const effectiveModel = effectiveLeadModel(draft, leadName, options?.model)
          const effectiveThinkingLevel = options?.thinkingLevel ?? draft.sessionThinkingLevel
          draft.agentStreams[leadName].currentBlocks.push({
            id: `user-${Date.now()}`,
            type: 'user',
            content,
            timestamp: new Date(submittedAt),
            attachments: optimisticAttachments,
            extra: {
              ...(effectiveModel ? { model: effectiveModel } : {}),
              ...(effectiveThinkingLevel ? { thinking_level: effectiveThinkingLevel } : {}),
              ...((options?.fastMode ?? draft.sessionFastMode) ? { service_tier: 'fast' } : {}),
              ...(options?.shell ? { kind: 'user_shell', command: content.replace(/^!/, '').trim() } : {}),
            },
          })
        }
      })

      try {
        const result = await postTeamChat(
          content,
          get().sessionId,
          false,
          files,
          options?.mode ?? 'normal',
          options?.workspace ?? null,
          options?.model ?? get().sessionModel,
          options?.thinkingLevel ?? get().sessionThinkingLevel,
          options?.shell ?? false,
          options?.fastMode ?? get().sessionFastMode,
        )
        set((draft) => {
          draft.sessionId = result.session_id
          draft.sessionModel = options?.model ?? get().sessionModel
          draft.sessionThinkingLevel = options?.thinkingLevel ?? get().sessionThinkingLevel
          draft._pendingMessages.forEach((msg) => {
            if (msg.sessionId === null || msg.sessionId === undefined) msg.sessionId = result.session_id
          })
          if (options?.workspace) {
            draft._workspace = options.workspace
          }
        })
        get().connectStream()
      } catch (err) {
        set((draft) => {
          draft.error = err instanceof Error ? err.message : 'Failed to send message'
          draft.isTeamWorking = false
        })
      }
    },

    setSessionModelSettings: (model: string | null, thinkingLevel: string | null, fastMode?: boolean) => {
      set((draft) => {
        draft.sessionModel = model
        draft.sessionThinkingLevel = thinkingLevel
        if (fastMode !== undefined) draft.sessionFastMode = fastMode
      })
    },

    continueTeam: async () => {
      const sessionId = get().sessionId
      if (!sessionId) {
        set((draft) => { draft.error = 'No active session to continue' })
        return
      }

      try {
        const submittedAt = Date.now()
        set((draft) => {
          draft.isTeamWorking = true
          draft.isContinuing = true
          draft.error = null
          if (draft.leadName && draft.agentStreams[draft.leadName]) {
            draft.agentStreams[draft.leadName]._turnStartedAt = submittedAt
          }
        })
        await postTeamCommand('continue', sessionId)
        get().connectStream()
      } catch (err) {
        set((draft) => {
          draft.error = err instanceof Error ? err.message : 'Failed to continue'
          draft.isTeamWorking = false
          draft.isContinuing = false
        })
      }
    },

    compactTeam: async () => {
      const sessionId = get().sessionId
      if (!sessionId) {
        set((draft) => { draft.error = 'No active session to compact' })
        return
      }

      try {
        const submittedAt = Date.now()
        set((draft) => {
          draft.isTeamWorking = true
          draft.error = null
          if (draft.leadName && draft.agentStreams[draft.leadName]) {
            draft.agentStreams[draft.leadName]._turnStartedAt = submittedAt
          }
        })
        await postTeamCommand('compact', sessionId)
        get().connectStream()
      } catch (err) {
        set((draft) => {
          draft.error = err instanceof Error ? err.message : 'Failed to compact'
          draft.isTeamWorking = false
        })
      }
    },

    undoTeam: async () => {
      const sessionId = get().sessionId
      if (!sessionId) {
        set((draft) => { draft.error = 'No active session to undo' })
        return
      }
      // Reverting mid-stream orphans the in-flight assistant tokens
      // (currentBlocks gets spliced into _revertedSuffix while SSE keeps
      // pushing deltas). Force the user to /stop first — matches the
      // backend precondition in AgentTeam.handle_undo.
      if (get().isTeamWorking) {
        set((draft) => {
          draft.error = 'Cannot undo while agents are working — /stop first'
        })
        return
      }

      try {
        set((draft) => { draft.error = null })
        const response = await postTeamCommand('undo', sessionId)
        const boundaryIso = response.message?.created_at
        const boundaryTime = boundaryIso ? new Date(boundaryIso).getTime() : null
        set((draft) => {
          draft._leadRevertTime = boundaryTime
          Object.values(draft.agentStreams).forEach((stream) => {
            applyRevertBoundary(stream, boundaryTime, {
              includeCurrent: true,
              boundaryId: response.message?.id ?? null,
              boundaryContent: response.message?.content ?? null,
            })
          })
        })
        enqueueWorkspaceInvalidation(
          set,
          get,
          sessionId,
          mergeChangedPaths(response.changed_paths),
        )
        return response
      } catch (err) {
        set((draft) => {
          draft.error = err instanceof Error ? err.message : 'Failed to undo'
        })
        return undefined
      }
    },

    redoTeam: async () => {
      const sessionId = get().sessionId
      if (!sessionId) {
        set((draft) => { draft.error = 'No active session to redo' })
        return
      }

      const MAX_ITER = 200
      const allChangedPaths = new Set<string>()
      let sawChangedPaths = false
      let sawMissingChangedPaths = false
      let sawResponse = false
      try {
        set((draft) => { draft.error = null })
        for (let i = 0; i < MAX_ITER; i++) {
          const response = await postTeamCommand('redo', sessionId)
          sawResponse = true
          const boundaryIso = response.message?.created_at
          const boundaryTime = boundaryIso ? new Date(boundaryIso).getTime() : null
          set((draft) => {
            draft._leadRevertTime = boundaryTime
            Object.values(draft.agentStreams).forEach((stream) => {
              applyRevertBoundary(stream, boundaryTime)
            })
          })
          if (response.changed_paths === undefined) {
            sawMissingChangedPaths = true
          } else {
            sawChangedPaths = true
          }
          const merged = mergeChangedPaths(response.changed_paths)
          merged?.forEach((p) => allChangedPaths.add(p))
          if (response.message === null) break

          if (i === MAX_ITER - 1) {
            throw new Error('Redo did not reach the live tip')
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        if (message.includes('No undone message to redo')) {
          set((draft) => {
            draft._leadRevertTime = null
            Object.values(draft.agentStreams).forEach((stream) => {
              applyRevertBoundary(stream, null)
            })
          })
        } else {
          set((draft) => {
            draft.error = `Failed to redo: ${message}`
          })
        }
      } finally {
        if (sawMissingChangedPaths) {
          enqueueWorkspaceInvalidation(set, get, sessionId)
        } else if (allChangedPaths.size > 0) {
          enqueueWorkspaceInvalidation(
            set,
            get,
            sessionId,
            [...allChangedPaths],
          )
        } else if (sawChangedPaths) {
          enqueueWorkspaceInvalidation(set, get, sessionId, [])
        } else if (sawResponse) {
          enqueueWorkspaceInvalidation(set, get, sessionId)
        }
      }
    },

    sendLoopCommand: async (command, prompt, options) => {
      const sessionId = get().sessionId
      const isStart = prompt !== undefined
      const canCreateSession = isStart || command.startsWith('/loop:set ')
      if (!sessionId && !canCreateSession) {
        set((draft) => { draft.error = 'No active session for loop command' })
        return
      }
      const content = isStart ? prompt : command
      const leadName = get().leadName
      const submittedAt = Date.now()
      const currentLoop = get().activeLoop
      if (isStart && prompt) {
        const limit = currentLoop?.limit ?? 10
        set((draft) => {
          draft.activeLoop = {
            prompt,
            limit,
            remaining: Math.max(limit - 1, 0),
            used: Math.min(1, limit),
            paused: false,
          }
        })
      } else if (command.startsWith('/loop:set ')) {
        const limit = Number(command.slice('/loop:set '.length).trim())
        if (Number.isFinite(limit) && limit > 0) {
          set((draft) => {
            draft.activeLoop = { prompt: null, limit, remaining: limit, used: 0, paused: false }
          })
        }
      } else if (command === '/loop:pause' && currentLoop) {
        set((draft) => {
          if (draft.activeLoop) draft.activeLoop.paused = true
        })
      } else if (command === '/loop:resume' && currentLoop) {
        set((draft) => {
          if (draft.activeLoop) draft.activeLoop.paused = false
        })
      } else if (command === '/loop:stop') {
        set((draft) => { draft.activeLoop = null })
      }
      if (isStart && leadName) {
        set((draft) => {
          if (!draft.agentStreams[leadName]) {
            draft.agentStreams[leadName] = createDefaultAgentStream()
          }
          draft.isTeamWorking = true
          draft.isContinuing = false
          draft.error = null
          draft.setupRequired = null
          draft._leadRevertTime = null
          Object.values(draft.agentStreams).forEach((stream) => {
            stream._revertedSuffix = []
            stream.revertedCount = 0
            stream.revertedMessages = []
          })
          const stream = draft.agentStreams[leadName]
          if (!stream) return
          stream._turnStartedAt = submittedAt
          const effectiveModel = effectiveLeadModel(draft, leadName, options?.model)
          const effectiveThinkingLevel = options?.thinkingLevel ?? draft.sessionThinkingLevel
          stream.currentBlocks.push({
            id: `user-${Date.now()}`,
            type: 'user',
            content,
            timestamp: new Date(submittedAt),
            extra: {
              ...(effectiveModel ? { model: effectiveModel } : {}),
              ...(effectiveThinkingLevel ? { thinking_level: effectiveThinkingLevel } : {}),
              ...((options?.fastMode ?? draft.sessionFastMode) ? { service_tier: 'fast' } : {}),
            },
          })
        })
      }
      try {
        const result = await postTeamChat(
          command,
          sessionId,
          false,
          undefined,
          options?.mode ?? 'coding',
          options?.workspace ?? get()._workspace,
          options?.model ?? get().sessionModel,
          options?.thinkingLevel ?? get().sessionThinkingLevel,
          false,
          options?.fastMode ?? get().sessionFastMode,
        )
        set((draft) => {
          draft.sessionId = result.session_id
          draft.sessionModel = options?.model ?? get().sessionModel
          draft.sessionThinkingLevel = options?.thinkingLevel ?? get().sessionThinkingLevel
          if (options?.workspace) draft._workspace = options.workspace
        })
        get().connectStream()
      } catch (err) {
        set((draft) => {
          draft.error = err instanceof Error ? err.message : 'Failed to run loop command'
          if (isStart) draft.isTeamWorking = false
        })
      }
    },

    removePendingMessage: (id: string) => {
      const pending = get()._pendingMessages.find((m) => m.id === id)
      set((draft) => {
        draft._pendingMessages = draft._pendingMessages.filter((m) => m.id !== id)
      })
      if (pending?.sessionId) {
        void cancelQueuedTeamMessage(pending.sessionId, id).catch((err) => {
          set((draft) => {
            draft.error = err instanceof Error ? err.message : 'Failed to cancel queued message'
          })
        })
      }
    },

    stopTeam: async () => {
      const sessionId = get().sessionId
      if (!sessionId || !get().isTeamWorking) return

      try {
        await postTeamChat(null, sessionId, true)
        await get().loadSession(sessionId, get()._workspace)
      } catch (err) {
        console.warn('stopTeam failed', err)
      }
    },

    connectStream: () => {
      const sessionId = get().sessionId
      if (!sessionId) return new AbortController()
      const generation = get()._sessionGeneration

      get()._abortController?.abort()
      const abort = new AbortController()
      set((draft) => { draft.isConnected = true; draft._abortController = abort })

      teamStream(
        sessionId,
        {
          onEvent: (type, data) => {
            const current = get()
            if (current._unloading && type === 'error') return
            if (current.sessionId !== sessionId || current._sessionGeneration !== generation) {
              if (type === 'desktop_notification') current._handleSSEEvent(type, data)
              return
            }
            current._handleSSEEvent(type, data)
          },
          onParseError: (err) => {
            console.warn(err.message)
          },
          onError: (err) => {
            const current = get()
            if (current.sessionId !== sessionId || current._sessionGeneration !== generation) return
            if (current._unloading || abort.signal.aborted) return
            if (isTransientNetworkError(err) || !current.isTeamWorking) {
              set((draft) => { draft.isConnected = false })
              return
            }
            set((draft) => { draft.error = err.message; draft.isConnected = false })
          },
          onDone: () => {
            const current = get()
            if (current.sessionId !== sessionId || current._sessionGeneration !== generation) return
            set((draft) => {
              draft.isConnected = false
              draft.cacheInvalidations.push({ kind: 'team_sessions' })
            })
          },
        },
        abort.signal,
      )
      return abort
    },

    loadTeamStatus: async (workspace?: string | null) => {
      try {
        const status = await teamStatus(workspace)
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
        const existingLiveNames = get().liveAgentNames
        const liveNamesPromise = existingLiveNames === null
          ? teamStatus(workspace).then((status) =>
              status ? [status.lead, ...status.members].map((agent) => agent.name) : null,
            )
          : Promise.resolve(existingLiveNames)
        const historyPromise = teamHistory(sessionId)
        const [liveNames, history] = await Promise.all([liveNamesPromise, historyPromise])

        if (get()._sessionGeneration !== gen) return

        set((draft) => {
          draft.sessionId = sessionId
          draft.sessionModel = history.lead.model ?? null
          draft.sessionThinkingLevel = history.lead.thinking_level ?? null
          draft.sessionFastMode = fastModeFromMessages(history.lead.messages)
          draft.isTeamWorking = history.lead.running === true
          draft.isContinuing = false
          draft.error = null
          draft.activeLoop = history.loop_status ?? null

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

    cycleActiveAgent: (dir: 'next' | 'prev') => {
      set((draft) => {
        const names = draft.agentNames
        if (names.length === 0) return
        const idx = names.indexOf(draft.activeAgent || '')
        draft.activeAgent = dir === 'next'
          ? names[(idx + 1) % names.length]
          : names[(idx - 1 + names.length) % names.length]
      })
    },

    toggleSidebar: () => {
      set((draft) => { draft.sidebarOpen = !draft.sidebarOpen })
    },

    dismissSetupRequired: () => {
      set((draft) => { draft.setupRequired = null })
    },

    _drainCacheInvalidations: () => {
      const events = get().cacheInvalidations
      if (events.length === 0) return []
      set((draft) => { draft.cacheInvalidations = [] })
      return events
    },

    _handleSSEEvent: createSSEHandler({ set, get }),
  }))
)

useTeamStore.subscribe((state, prev) => {
  if (state.error && state.error !== prev.error && !state._unloading) {
    useToastStore.getState().push({ tone: 'error', title: 'Agent error', description: state.error })
  }
})

if (typeof window !== 'undefined') {
  const markUnloading = () => {
    useTeamStore.setState((state) => {
      state._unloading = true
      state._abortController?.abort()
    })
  }
  window.addEventListener('beforeunload', markUnloading)
  window.addEventListener('pagehide', markUnloading)
}
