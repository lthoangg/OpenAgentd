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

  /**
   * Send (or queue) a user message. Resolves ``true`` when the backend
   * accepted it, ``false`` when it did not.
   *
   * The composer clears optimistically on submit for responsiveness, so the
   * caller is the only thing standing between a failed POST and the user's
   * text and attachments being silently destroyed — see the restore in
   * ``TeamChatView``.
   */
  sendMessage: async (content: string, files?: File[], options?: { mode?: string; workspace?: string | null; model?: string | null; thinkingLevel?: string | null; fastMode?: boolean; mentions?: string[] }): Promise<boolean> => {
    const { leadName, agentStreams } = get()
    const leadWorking = leadName ? agentStreams[leadName]?.status === 'working' : false

    if (leadWorking) {
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
          options?.fastMode ?? get().sessionFastMode,
          options?.mentions,
        )
        if (result.status === 'queued' && !result.message_id) {
          throw new Error('Backend did not return a queued message id')
        }
        // Display metadata only — no blob URLs, so nothing to revoke when the
        // queued message is spliced into the stream or cancelled. Real URLs
        // arrive with the next history load.
        const queuedAttachments = files?.map((f) => ({
          original_name: f.name,
          media_type: f.type,
          category: (f.type.startsWith('image/') ? 'image' : 'document') as 'image' | 'document' | 'text',
        }))
        set((draft) => {
          draft.sessionId = result.session_id
          draft.sessionModel = options?.model ?? get().sessionModel
          draft.sessionThinkingLevel = options?.thinkingLevel ?? get().sessionThinkingLevel
          draft._sessionSettingsDirty = false
          draft._sessionSettingsVersion += 1
          draft._pendingMessages.push({
            id: result.message_id ?? '',
            sessionId: result.session_id,
            content,
            submittedAt: Date.now(),
            ...(queuedAttachments && queuedAttachments.length > 0
              ? { attachments: queuedAttachments, files }
              : {}),
          })
          draft.error = null
        })
      } catch (err) {
        set((draft) => {
          draft.error = err instanceof Error ? err.message : 'Failed to queue message'
        })
        return false
      }
      return true
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
    const optimisticId = `user-${submittedAt}`
    set((draft) => {
        draft.isTeamWorking = true
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
          id: optimisticId,
          type: 'user',
          content,
          timestamp: new Date(submittedAt),
          attachments: optimisticAttachments,
          extra: {
            ...(effectiveModel ? { model: effectiveModel } : {}),
            ...(effectiveThinkingLevel ? { thinking_level: effectiveThinkingLevel } : {}),
            ...((options?.fastMode ?? draft.sessionFastMode) ? { service_tier: 'fast' } : {}),
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
        options?.fastMode ?? get().sessionFastMode,
        options?.mentions,
      )
      set((draft) => {
        draft.sessionId = result.session_id
        draft.sessionModel = options?.model ?? get().sessionModel
        draft.sessionThinkingLevel = options?.thinkingLevel ?? get().sessionThinkingLevel
        draft._sessionSettingsDirty = false
        draft._sessionSettingsVersion += 1
        draft._pendingMessages.forEach((msg) => {
          if (msg.sessionId === null || msg.sessionId === undefined) msg.sessionId = result.session_id
        })
        if (options?.workspace) {
          draft._workspace = options.workspace
        }
        // Adopt the server's id for the optimistic bubble the moment it's
        // known, instead of leaving reconciliation to infer "is this the same
        // message?" from content + a clock-skew time window later (see
        // removePersistedOptimisticUserBlocks) — an id match can't ever be
        // ambiguous.
        if (result.message_id && leadName) {
          const block = draft.agentStreams[leadName]?.currentBlocks.find((b) => b.id === optimisticId)
          if (block) block.id = result.message_id
        }
      })
      get().connectStream()
      return true
    } catch (err) {
      set((draft) => {
        draft.error = err instanceof Error ? err.message : 'Failed to send message'
        draft.isTeamWorking = false
      })
      return false
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
