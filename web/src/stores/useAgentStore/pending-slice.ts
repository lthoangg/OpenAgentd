import type { StateCreator } from 'zustand'
import { cancelQueuedMessage, postAgentChat } from '@/api/client'
import { applyQuestionResolution, revokeBlobUrlsFromBlocks } from './helpers'
import { createDefaultAgentStream } from './defaults'
import { clearReconnectTimer } from './stream-slice'
import type { PendingMessage, AgentStore, SendMessageOptions } from './types'
import type { MessageAttachment, SessionInteractionMode } from '@/api/types'

/**
 * The mode picked on the new-session screen rides on the message that
 * creates the session; an existing session switches through PATCH instead.
 */
function newSessionInteractionMode(state: AgentStore): SessionInteractionMode | undefined {
  return state.sessionId ? undefined : state.sessionInteractionMode
}

type SendOptions = SendMessageOptions

function effectiveLeadModel(state: AgentStore, leadName: string | null, requestedModel?: string | null): string | null {
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
  draft: AgentStore,
  leadName: string | null,
  args: {
    id: string
    content: string
    submittedAt: number
    attachments?: MessageAttachment[]
    options?: SendOptions
  },
) {
  const effectiveName = leadName || draft.leadName || 'openagentd'
  draft.leadName = effectiveName
  if (!draft.agentStreams[effectiveName]) draft.agentStreams[effectiveName] = createDefaultAgentStream()
  const stream = draft.agentStreams[effectiveName]
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
      // The objective of a `/goal`: the server row carries the goal's id.
      ...(args.options?.goal ? { goal: {} } : {}),
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

/** Whether ``queued_turn_start`` already put the queued message ``id`` in a
 *  stream (it can beat the POST response). By id only: matching text hid
 *  every steer whose text the session had already sent once. */
function isSpliced(draft: AgentStore, id: string): boolean {
  return Object.values(draft.agentStreams).some((stream) =>
    stream.currentBlocks.some((b) => b.id === id) || stream.blocks.some((b) => b.id === id),
  )
}

function makePendingMessage(
  id: string,
  sessionId: string,
  content: string,
  submittedAt: number,
  files?: File[],
  goal?: boolean,
): PendingMessage {
  const attachments = queuedAttachmentMetas(files)
  return {
    id,
    sessionId,
    content,
    submittedAt,
    ...(attachments && attachments.length > 0 ? { attachments, files } : {}),
    ...(goal ? { goal: true } : {}),
  }
}

export type PendingSlice = Pick<
  AgentStore,
  '_pendingMessages' | 'sendMessage' | 'removePendingMessage'
>

export const createPendingSlice: StateCreator<
  AgentStore,
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
   * ``AgentChatView``.
   */
  sendMessage: async (content: string, files: File[] | undefined, options: SendOptions): Promise<boolean> => {
    const { leadName, agentStreams } = get()
    const effectiveLead = leadName || 'openagentd'
    const leadWorking = agentStreams[effectiveLead]?.status === 'working'

    // Whether this message runs now or waits in the queue is the *backend's*
    // call (``has_active_user_turn`` also covers members the lead delegated
    // to, and another client may have started a turn since). ``leadWorking``
    // only picks which optimistic rendering to show first; both branches
    // below reconcile against ``result.status`` when the POST answers.
    if (leadWorking) {
      try {
        const result = await postAgentChat(
          content,
          get().sessionId,
          false,
          options.workspace,
          files,
          options?.model ?? get().sessionModel,
          options?.thinkingLevel ?? get().sessionThinkingLevel,
          options?.fastMode ?? get().sessionFastMode,
          options?.mentions,
          newSessionInteractionMode(get()),
          options?.goal,
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
            applyQuestionResolution(draft, null, null, 'superseded')
            draft.sessionModel = options?.model ?? get().sessionModel
            draft.sessionThinkingLevel = options?.thinkingLevel ?? get().sessionThinkingLevel
            draft._sessionSettingsDirty = false
            draft._sessionSettingsVersion += 1
            draft.isAgentWorking = true
            draft.error = null
            if (options?.workspace) draft._workspace = options.workspace
            appendOptimisticUserBlock(draft, effectiveLead, {
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
          applyQuestionResolution(draft, null, null, 'superseded')
          const msgId = result.message_id ?? ''
          const alreadySpliced = isSpliced(draft, msgId)
          if (!alreadySpliced) {
            draft._pendingMessages.push(
              makePendingMessage(
                msgId,
                result.session_id,
                content,
                Date.now(),
                files,
                Boolean(options?.goal),
              ),
            )
          }
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
        draft.isAgentWorking = true
        draft.error = null
        draft.setupRequired = null
      draft._leadRevertTime = null
      Object.values(draft.agentStreams).forEach((stream) => {
        stream._revertedSuffix = []
        stream.revertedCount = 0
        stream.revertedMessages = []
      })
      appendOptimisticUserBlock(draft, effectiveLead, {
        id: optimisticId,
        content,
        submittedAt,
        attachments: optimisticAttachments,
        options,
      })
    })

    try {
      const result = await postAgentChat(
        content,
        get().sessionId,
        false,
        options.workspace,
        files,
        options?.model ?? get().sessionModel,
        options?.thinkingLevel ?? get().sessionThinkingLevel,
        options?.fastMode ?? get().sessionFastMode,
        options?.mentions,
        newSessionInteractionMode(get()),
        options?.goal,
      )
      set((draft) => {
        draft.sessionId = result.session_id
        applyQuestionResolution(draft, null, null, 'superseded')
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
          // The agent still owned an active turn server-side (typically a
          // member the lead delegated to, which this client's lead status
          // cannot see), so the message is queued rather than running. Move
          // the optimistic bubble into the queue: left in ``currentBlocks``
          // it renders *inside* the turn that is still streaming, and
          // ``queued_turn_start`` would later splice the very same row in a
          // second time.
          const stream = draft.agentStreams[effectiveLead]
          if (stream) {
            revokeBlobUrlsFromBlocks(
              stream.currentBlocks.filter((b) => b.id === optimisticId),
            )
            stream.currentBlocks = stream.currentBlocks.filter((b) => b.id !== optimisticId)
            stream._turnStartedAt = turnStartedBefore
          }
          const msgId = result.message_id
          const alreadySpliced = isSpliced(draft, msgId)
          if (!alreadySpliced) {
            draft._pendingMessages.push(
              makePendingMessage(result.message_id, result.session_id, content, submittedAt, files, Boolean(options?.goal)),
            )
          }
          return
        }
        // Adopt the server's id for the optimistic bubble the moment it's
        // known, instead of leaving reconciliation to infer "is this the same
        // message?" from content + a clock-skew time window later (see
        // removePersistedOptimisticUserBlocks) — an id match can't ever be
        // ambiguous.
        if (result.message_id) {
          const block = draft.agentStreams[effectiveLead]?.currentBlocks.find((b) => b.id === optimisticId)
          if (block) block.id = result.message_id
        }
      })
      get().connectStream()
      return true
    } catch (err) {
      set((draft) => {
        draft.error = err instanceof Error ? err.message : 'Failed to send message'
        draft.isAgentWorking = false
      })
      return false
    }
  },

  removePendingMessage: async (id: string) => {
    const pending = get()._pendingMessages.find((m) => m.id === id)
    const drop = () => set((draft) => {
      draft._pendingMessages = draft._pendingMessages.filter((m) => m.id !== id)
    })
    // Already spliced into the transcript: the agent has it.
    if (!pending) return 'sent'
    if (!pending.sessionId) {
      drop()
      return 'cancelled'
    }
    // The chip stays until the server answers: the agent may read the message
    // in the meantime, and then it is no longer the user's to edit.
    try {
      const cancelled = await cancelQueuedMessage(pending.sessionId, id)
      drop()
      return cancelled ? 'cancelled' : 'sent'
    } catch (err) {
      set((draft) => {
        draft.error = err instanceof Error ? err.message : 'Failed to cancel queued message'
      })
      return 'failed'
    }
  },
})
