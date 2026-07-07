import type { StateCreator } from 'zustand'
import { cancelQueuedTeamMessage, postTeamChat } from '@/api/client'
import { clearReconnectTimer } from './stream-slice'
import type { TeamStore } from './types'

function effectiveLeadModel(state: TeamStore, leadName: string | null, requestedModel?: string | null): string | null {
  return requestedModel ?? state.sessionModel ?? (leadName ? state.agentStreams[leadName]?.model : null) ?? null
}

export type PendingSlice = Pick<
  TeamStore,
  '_pendingMessages' | 'sendMessage' | 'removePendingMessage'
>

export const createPendingSlice: StateCreator<
  TeamStore,
  [['zustand/immer', never]],
  [],
  PendingSlice
> = (set, get) => ({
  _pendingMessages: [],

  sendMessage: async (content: string, files?: File[], options?: { mode?: string; workspace?: string | null; model?: string | null; thinkingLevel?: string | null; fastMode?: boolean; shell?: boolean; mentions?: string[] }) => {
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
          options?.mentions,
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
    set((draft) => {
      clearReconnectTimer(draft)
    })

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
            ...(options?.mentions && options.mentions.length > 0 ? { mentions: options.mentions } : {}),
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
        options?.mentions,
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
})
