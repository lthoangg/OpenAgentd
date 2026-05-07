/**
 * Team chat Zustand store.
 *
 * Owns the live state for the team chat route: per-agent streams,
 * session id/title, working flag, the SSE abort controller, and the
 * pending-message queue.  Public actions are split between session
 * lifecycle (``sendMessage``, ``stopTeam``, ``connectStream``,
 * ``loadTeamStatus``, ``loadSession``, ``newSession``) and small UI
 * accessors (``setActiveAgent``, ``cycleActiveAgent``, ``toggleSidebar``).
 *
 * The bulk of streaming logic — one switch case per SSE event type —
 * lives in ``./sse-reducer.ts`` to keep this file focused on store
 * assembly.  Helpers, types, and defaults live in their own modules.
 *
 * The public import path ``@/stores/useTeamStore`` resolves to this
 * file via folder-with-index, so consumers don't need updating.
 */
import { create } from 'zustand'
import { immer } from 'zustand/middleware/immer'
import { postTeamChat, teamStream, teamStatus, teamHistory } from '@/api/client'
import { parseTeamBlocks, sumUsageFromMessages } from '@/utils/messages'
import { createDefaultAgentStream } from './defaults'
import { revokeBlobUrlsFromBlocks } from './helpers'
import { createSSEHandler } from './sse-reducer'
import { useToastStore } from '@/stores/useToastStore'
import type { TeamStore } from './types'

// Re-export types so existing ``import type { AgentStream } from
// '@/stores/useTeamStore'`` consumers keep working.
export type {
  AgentStream,
  CacheInvalidation,
  PendingMessage,
  TeamStoreState,
  TeamStoreActions,
  TeamStore,
} from './types'

export const useTeamStore = create<TeamStore>()(
  immer((set, get) => ({
    // State
    agentStreams: {},
    activeAgent: null,
    leadName: null,
    agentNames: [],
    sidebarOpen: false,
    sessionId: null,
    sessionTitle: null,
    isTeamWorking: false,
    isConnected: false,
    error: null,
    _pendingMessages: [],
    _abortController: null,
    _sessionGeneration: 0,
    cacheInvalidations: [],

    newSession: () => {
      set((state) => {
        state.sessionId = null
        state.sessionTitle = null
        state.isTeamWorking = false
        state.error = null
        state._pendingMessages = []
        state._sessionGeneration = (state._sessionGeneration ?? 0) + 1
        // Drop any pending cache invalidations from the previous
        // session — workspace_files / todos events are session-keyed
        // and would target the wrong cache after the reset.
        state.cacheInvalidations = []
        state._pendingMessages = []
        // Reset each agent's blocks but keep identity (name/model)
        Object.keys(state.agentStreams).forEach((name) => {
          state.agentStreams[name].blocks = []
          state.agentStreams[name].currentBlocks = []
          state.agentStreams[name].currentText = ''
          state.agentStreams[name].currentThinking = ''
          state.agentStreams[name].status = 'available'
          state.agentStreams[name].lastError = null
          state.agentStreams[name].usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedTokens: 0 }
          state.agentStreams[name]._completionBase = 0
        })
      })
    },

    sendMessage: async (content: string, files?: File[]) => {
      const { leadName, agentStreams } = get()
      const leadWorking = leadName ? agentStreams[leadName]?.status === 'working' : false

      // Only queue if the lead is busy. Members running in the background
      // (e.g. sub-tasks) don't block the user from sending a new message.
      if (leadWorking) {
        set((draft) => {
          draft._pendingMessages.push({ id: `pm-${Date.now()}`, content, files })
          draft.error = null
        })
        return
      }

      get()._abortController?.abort()

      // Build optimistic attachments from files for immediate display
      const optimisticAttachments = files?.map((f) => ({
        original_name: f.name,
        media_type: f.type,
        category: (f.type.startsWith('image/') ? 'image' : 'document') as 'image' | 'document' | 'text',
        url: f.type.startsWith('image/') ? URL.createObjectURL(f) : undefined,
      }))

      set((draft) => {
        draft.isTeamWorking = true
        draft.error = null
        // Push user message as an optimistic block into the lead's stream
        if (leadName && draft.agentStreams[leadName]) {
          draft.agentStreams[leadName].currentBlocks.push({
            id: `user-${Date.now()}`,
            type: 'user',
            content,
            timestamp: new Date(),
            attachments: optimisticAttachments,
          })
        }
      })

      try {
        const result = await postTeamChat(content, get().sessionId, false, files)
        set((draft) => {
          draft.sessionId = result.session_id
        })
        get().connectStream()
      } catch (err) {
        set((draft) => {
          draft.error = err instanceof Error ? err.message : 'Failed to send message'
          draft.isTeamWorking = false
        })
      }
    },

    removePendingMessage: (id: string) => {
      set((draft) => {
        draft._pendingMessages = draft._pendingMessages.filter((m) => m.id !== id)
      })
    },

    stopTeam: async () => {
      const sessionId = get().sessionId
      if (!sessionId || !get().isTeamWorking) return

      // Interrupt all working members (interrupt=true, no message)
      try {
        await postTeamChat(null, sessionId, true)
      } catch (err) {
        console.warn('stopTeam failed', err)
      }
      // The SSE stream will deliver done event once all members go idle
    },

    connectStream: () => {
      const sessionId = get().sessionId
      if (!sessionId) return new AbortController()

      get()._abortController?.abort()
      const abort = new AbortController()
      set((draft) => { draft.isConnected = true; draft._abortController = abort })

      teamStream(
        sessionId,
        {
          onEvent: (type, data) => get()._handleSSEEvent(type, data),
          onError: (err) => {
            set((draft) => { draft.error = err.message; draft.isConnected = false })
          },
          onDone: () => {
            set((draft) => { draft.isConnected = false })
          },
        },
        abort.signal,
      )
      return abort
    },

    loadTeamStatus: async () => {
      try {
        const status = await teamStatus()
        if (status) {
          const allAgents = [status.lead, ...status.members]
          set((draft) => {
            draft.leadName = status.lead.name
            draft.agentNames = allAgents.map((a) => a.name)
            allAgents.forEach((agent) => {
              if (!draft.agentStreams[agent.name]) {
                draft.agentStreams[agent.name] = createDefaultAgentStream()
              }
              draft.agentStreams[agent.name].model = agent.model
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

    loadSession: async (sessionId: string) => {
      const gen = get()._sessionGeneration
      try {
        const history = await teamHistory(sessionId)

        if (get()._sessionGeneration !== gen) return

        set((draft) => {
          draft.sessionId = sessionId
          // Reset working state — the session being loaded is a completed
          // (or idle) history snapshot. If session A was streaming when the
          // user switched to session B, isTeamWorking would remain true and
          // the "..." indicator would persist indefinitely.
          draft.isTeamWorking = false
          draft.error = null

          const leadName = history.lead.agent_name
          draft.leadName = leadName

          const memberNames = history.members.map((m) => m.name)
          const allNames = leadName ? [leadName, ...memberNames] : memberNames
          draft.agentNames = allNames

          // Load lead blocks (includes user blocks from parseTeamBlocks)
          if (leadName) {
            if (!draft.agentStreams[leadName]) {
              draft.agentStreams[leadName] = createDefaultAgentStream()
            }
            // Revoke blob URLs from old blocks before replacing them
            revokeBlobUrlsFromBlocks(draft.agentStreams[leadName].currentBlocks)
            draft.agentStreams[leadName].blocks = parseTeamBlocks(history.lead.messages)
            draft.agentStreams[leadName].currentBlocks = []
            draft.agentStreams[leadName].currentText = ''
            draft.agentStreams[leadName].currentThinking = ''
            draft.agentStreams[leadName].status = 'available'
            const leadUsage = sumUsageFromMessages(history.lead.messages)
            draft.agentStreams[leadName].usage = leadUsage
            // Seed _completionBase so next live turn accumulates correctly
            draft.agentStreams[leadName]._completionBase = leadUsage.completionTokens
          }

          // Load member blocks
          history.members.forEach((member) => {
            if (!draft.agentStreams[member.name]) {
              draft.agentStreams[member.name] = createDefaultAgentStream()
            }
            // Revoke blob URLs from old blocks before replacing them
            revokeBlobUrlsFromBlocks(draft.agentStreams[member.name].currentBlocks)
            draft.agentStreams[member.name].blocks = parseTeamBlocks(member.messages)
            draft.agentStreams[member.name].currentBlocks = []
            draft.agentStreams[member.name].currentText = ''
            draft.agentStreams[member.name].currentThinking = ''
            draft.agentStreams[member.name].status = 'available'
            const memberUsage = sumUsageFromMessages(member.messages)
            draft.agentStreams[member.name].usage = memberUsage
            // Seed _completionBase so next live turn accumulates correctly
            draft.agentStreams[member.name]._completionBase = memberUsage.completionTokens
          })

          if (!draft.activeAgent || !allNames.includes(draft.activeAgent)) {
            draft.activeAgent = leadName ?? allNames[0] ?? null
          }
        })
      } catch (err) {
        if (get()._sessionGeneration !== gen) return
        set((draft) => {
          draft.error = err instanceof Error ? err.message : 'Failed to load session'
        })
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

    _drainCacheInvalidations: () => {
      // Snapshot then atomically clear, so an SSE event that pushes
      // between the read and the clear isn't lost.
      const events = get().cacheInvalidations
      if (events.length === 0) return []
      set((draft) => { draft.cacheInvalidations = [] })
      return events
    },

    _handleSSEEvent: createSSEHandler({ set, get }),
  }))
)

// Push a toast whenever the team-level error is set.
// Covers all three write paths: SSE error event, sendMessage catch,
// and connectStream onError.
useTeamStore.subscribe((state, prev) => {
  if (state.error && state.error !== prev.error) {
    useToastStore.getState().push({ tone: 'error', title: 'Agent error', description: state.error })
  }
})
