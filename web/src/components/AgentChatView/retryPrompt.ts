/**
 * Retry: rewind the latest prompt and send it again, unchanged.
 *
 * Resends with the session's *current* model settings, so switching models
 * and retrying is how to compare answers. The rewound answer is replaced,
 * as with /undo followed by a send.
 */
import type { MessageAttachment } from '@/api/types'
import { isGoalObjectiveBlock, restoredPromptText } from '@/lib/goal'
import { useAgentStore } from '@/stores/useAgentStore'
import { isTypedPromptBlock } from '@/stores/useAgentStore/helpers'
import { attachmentToFile } from './helpers'

/** ``@path`` mentions are re-attached server-side from ``mentions``; resending them as uploads would double them. */
function uploadedAttachments(attachments: MessageAttachment[] | undefined): MessageAttachment[] {
  return (attachments ?? []).filter((att) => att.source !== 'mention')
}

export async function retryLatestPrompt(workspace: string): Promise<boolean> {
  const store = useAgentStore.getState()
  const lead = store.leadName ? store.agentStreams[store.leadName] : undefined
  // A goal's own turns are hidden reminders, not something the user wrote:
  // retry the prompt before them (rewinding them too).
  const latest = lead ? [...lead.blocks].reverse().find(isTypedPromptBlock) : undefined
  if (!latest) return false

  const prompt = await store.revertToMessage(latest.id, { restoreDraft: false })
  if (!prompt) return false

  // Undoing a goal's objective ends that goal; sending it again sets it again.
  const goal = isGoalObjectiveBlock(prompt) ? {} : undefined
  const attachments = uploadedAttachments(prompt.attachments)
  const files = (await Promise.all(attachments.map(attachmentToFile))).filter((file): file is File => file !== null)
  const mentions = Array.isArray(prompt.extra?.mentions) ? prompt.extra.mentions as string[] : undefined
  const current = useAgentStore.getState()
  const delivered = await current.sendMessage(prompt.content, files, {
    workspace,
    model: current.sessionModel || null,
    thinkingLevel: current.sessionThinkingLevel || null,
    fastMode: current.sessionFastMode,
    mentions,
    ...(goal ? { goal } : {}),
  })
  // The prompt is already rewound; a failed resend must not lose it.
  if (!delivered) current.setPendingDraft({ content: restoredPromptText(prompt.content, prompt.extra) ?? '', attachments })
  return delivered
}
