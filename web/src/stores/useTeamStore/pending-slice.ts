import type { StateCreator } from 'zustand'
import { cancelQueuedTeamMessage, postTeamChat } from '@/api/client'
import { revokeBlobUrlsFromBlocks } from './helpers'
import { clearReconnectTimer } from './stream-slice'
import type { PendingMessage, TeamStore } from './types'
import type { MessageAttachment } from '@/api/types'

interface SendOptions {
  workspace: string
  model?: string | null
  thinkingLevel?: string | null
  fastMode?: boolean
  mentions?: string[]
}

function effectiveLeadModel(state: TeamStore, leadName: string | null, requestedModel?: string | null): string | null {
  return requestedModel ?? state.sessionModel ?? (leadName ? state.agentStreams[leadName]?.model : null) ?? null
}

/** Display metadata for an immediate send — images carry a blob URL so the
 *  bubble shows a thumbnail before the upload round-trips. Revoked by
 *  whichever path drops the block (see ``revokeBlobUrlsFromBlocks``). */
function optimisticAttachmentMetas(files?: File[]): MessageAttachment[] | undefined {
  return files?.map((f) => ({
    original_name: f.name,
    media_type: f.type,
    category: (f.type.startsWith('image/') ? 'image' : 'document') as 'image' | 'document' | 'text',
    url: f.type.startsWith('image/') ? URL.createObjectURL(f) : undefined,
  }))
}

/** Push the user's own bubble into the lead's live blocks, so a send renders
 *  before the POST resolves. Shared by the immediate-send path and the
 *  "client queued it but the backend ran it" reconciliation. */
function appendOptimisticUserBlock(
  draft: TeamStore,
  leadName: string | null,
  args: {
    id: string
    content: string
    submittedAt: number
    attachments?: MessageAttachment[]
    options?: SendOptions
  },
) {
  if (!leadName || !draft.agentStreams[leadName]) return
  const stream = draft.agentStreams[leadName]
  stream._turnStartedAt = args.submittedAt
  const effectiveModel = effectiveLeadModel(draft, leadName, args.options?.model)
  const effectiveThinkingLevel = args.options?.thinkingLevel ?? draft.sessionThinkingLevel
  stream.currentBlocks.push({
    id: args.id,
    type: 'user',
    content: args.content,
    timestamp: new Date(args.submittedAt),
    attachments: args.attachments,
    extra: {
      ...(effectiveModel ? { model: effectiveModel } : {}),
      ...(effectiveThinkingLevel ? { thinking_level: effectiveThinkingLevel } : {}),
      ...((args.options?.fastMode ?? draft.sessionFastMode) ? { service_tier: 'fast' } : {}),
      ...(args.options?.mentions && args.options.mentions.length > 0
        ? { mentions: args.options.mentions }
        : {}),
    },
  })
}

/** Display metadata for queued files — deliberately without blob URLs, so
 *  nothing has to be revoked when the queued message is spliced into the
 *  stream or cancelled. Real URLs arrive with the next history load. */
function queuedAttachmentMetas(files?: File[]) {
  return files?.map((f) => ({
    original_name: f.name,
    media_type: f.type,
    category: (f.type.startsWith('image/') ? 'image' : 'document') as 'image' | 'document' | 'text',
  }))
}

function makePendingMessage(
  id: string,
  sessionId: string,
  content: string,
  submittedAt: number,
  files?: File[],
): PendingMessage {
  const attachments = queuedAttachmentMetas(files)
  return {
    id,
    sessionId,
    content,
    submittedAt,
    ...(attachments && attachments.length > 0 ? { attachments, files } : {}),
  }
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
  sendMessage: async (content: string, files: File[] | undefined, options: { workspace: string; model?: string | null; thinkingLevel?: string | null; fastMode?: boolean; mentions?: string[] }): Promise<boolean> => {
    const { leadName, agentStreams } = get()
    const leadWorking = leadName ? agentStreams[leadName]?.status === 'working' : false

    // Whether this message runs now or waits in the queue is the *backend's*
    // call (``has_active_user_turn`` also covers members the lead delegated
    // to, and another client may have started a turn since). ``leadWorking``
    // only picks which optimistic rendering to show first; both branches
    // below reconcile against ``result.status`` when the POST answers.
    if (leadWorking) {
      try {
        const result = await postTeamChat(
          content,
          get().sessionId,
          false,
          options.workspace,
          files,
          options?.model ?? get().sessionModel,
          options?.thinkingLevel ?? get().sessionThinkingLevel,
          options?.fastMode ?? get().sessionFastMode,
          options?.mentions,
        )
        if (result.status !== 'queued') {
          // The lead had already gone idle by the time the POST landed, so
          // the backend started this message straight away. Keeping it in
          // ``_pendingMessages`` would leave a "queued" chip for a running
          // message that no ``queued_turn_start`` will ever clear — and the
          // turn's own rows would then render it a second time.
          const submittedAt = Date.now()
          set((draft) => {
            draft.sessionId = result.session_id
            draft.sessionModel = options?.model ?? get().sessionModel
            draft.sessionThinkingLevel = options?.thinkingLevel ?? get().sessionThinkingLevel
            draft._sessionSettingsDirty = false
            draft._sessionSettingsVersion += 1
            draft.isTeamWorking = true
            draft.error = null
            if (options?.workspace) draft._workspace = options.workspace
            appendOptimisticUserBlock(draft, leadName, {
              id: result.message_id ?? `user-${submittedAt}`,
              content,
              submittedAt,
              attachments: optimisticAttachmentMetas(files),
              options,
            })
          })
          get().connectStream()
          return true
        }
        if (result.status === 'queued' && !result.message_id) {
          throw new Error('Backend did not return a queued message id')
        }
        set((draft) => {
          draft.sessionId = result.session_id
          draft.sessionModel = options?.model ?? get().sessionModel
          draft.sessionThinkingLevel = options?.thinkingLevel ?? get().sessionThinkingLevel
          draft._sessionSettingsDirty = false
          draft._sessionSettingsVersion += 1
          draft._pendingMessages.push(
            makePendingMessage(
              result.message_id ?? '',
              result.session_id,
              content,
              Date.now(),
              files,
            ),
          )
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

    const optimisticAttachments = optimisticAttachmentMetas(files)

    const submittedAt = Date.now()
    const optimisticId = `user-${submittedAt}`
    const turnStartedBefore = leadName ? agentStreams[leadName]?._turnStartedAt ?? null : null
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
      appendOptimisticUserBlock(draft, leadName, {
        id: optimisticId,
        content,
        submittedAt,
        attachments: optimisticAttachments,
        options,
      })
    })

    try {
      const result = await postTeamChat(
        content,
        get().sessionId,
        false,
        options.workspace,
        files,
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
        if (result.status === 'queued' && result.message_id) {
          // The team still owned an active turn server-side (typically a
          // member the lead delegated to, which this client's lead status
          // cannot see), so the message is queued rather than running. Move
          // the optimistic bubble into the queue: left in ``currentBlocks``
          // it renders *inside* the turn that is still streaming, and
          // ``queued_turn_start`` would later splice the very same row in a
          // second time.
          const stream = leadName ? draft.agentStreams[leadName] : undefined
          if (stream) {
            revokeBlobUrlsFromBlocks(
              stream.currentBlocks.filter((b) => b.id === optimisticId),
            )
            stream.currentBlocks = stream.currentBlocks.filter((b) => b.id !== optimisticId)
            stream._turnStartedAt = turnStartedBefore
          }
          draft._pendingMessages.push(
            makePendingMessage(result.message_id, result.session_id, content, submittedAt, files),
          )
          return
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
