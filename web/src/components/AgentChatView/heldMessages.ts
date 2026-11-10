/**
 * How a composer message reaches the agent while a turn runs. "Queue until
 * done" is held on the server (``hold_until_turn_end``): the running turn does
 * not read it, and it starts a turn of its own once that one ends, whether or
 * not this client is still open. Queued messages go back to the composer
 * whenever sending them would no longer be what the user asked for.
 */
import { useEffect, useRef, type RefObject } from 'react'
import { haptic, outcomeHapticFeedback } from '@/lib/haptics'
import { pauseSessionGoal } from '@/api/client'
import { useAgentStore, type PendingMessage } from '@/stores/useAgentStore'
import { useToastStore } from '@/stores/useToastStore'
import type { InputComposerHandle, SendDelivery } from '../InputComposer'

/** Send with the session's current model settings, as the composer does. */
function sendFromComposer(workspace: string, content: string, files?: File[], mentions?: string[], holdUntilTurnEnd = false) {
  const current = useAgentStore.getState()
  return current.sendMessage(content, files, {
    workspace,
    model: current.sessionModel || null,
    thinkingLevel: current.sessionThinkingLevel || null,
    fastMode: current.sessionFastMode,
    mentions,
    ...(holdUntilTurnEnd ? { holdUntilTurnEnd } : {}),
  })
}

/** What goes back into the composer: a called-off queued message. */
interface Returned {
  content: string
  files?: File[]
  mentions?: string[]
}

/** Put messages back in the composer, after anything it already holds. */
export function returnToComposer(composer: InputComposerHandle | null, held: Returned[]) {
  if (!composer || held.length === 0) return
  const mentions = [...new Set(held.flatMap((message) => message.mentions ?? []))]
  composer.appendValue(held.map((message) => message.content).join('\n\n'), { paragraph: true, ...(mentions.length > 0 ? { mentions } : {}) })
  const files = held.flatMap((message) => message.files ?? [])
  if (files.length > 0) composer.addFiles(files)
  composer.focus()
}

/** Delivery intent stays separate from the server's accepted-message queue. */
export type ComposerDeliveryPlan =
  | { kind: 'hold'; sessionId: string }
  | { kind: 'stop_then_send' }
  | { kind: 'send' }

export function planComposerDelivery(input: {
  working: boolean
  sessionId: string | null
  delivery: SendDelivery
}): ComposerDeliveryPlan {
  if (input.working && input.sessionId && input.delivery === 'after-turn') return { kind: 'hold', sessionId: input.sessionId }
  if (input.working && input.delivery === 'interrupt') return { kind: 'stop_then_send' }
  return { kind: 'send' }
}

export type QueuedAfterFailureDecision =
  | { kind: 'wait' }
  | { kind: 'return_to_composer' }

/**
 * A failed turn starts nothing from its queue, held messages included (the
 * server leaves them queued): this client's go back to the composer instead.
 */
export function decideQueuedAfterFailure(input: {
  hasTarget: boolean
  /** Idle by the loaded history, not merely by the working flag. */
  idle: boolean
  returning: boolean
  turnFailed: boolean
  queuedCount: number
}): QueuedAfterFailureDecision {
  if (!input.hasTarget || !input.idle || input.returning || !input.turnFailed) return { kind: 'wait' }
  return input.queuedCount === 0 ? { kind: 'wait' } : { kind: 'return_to_composer' }
}

/**
 * A queued steer this browser can hand back whole. Cancelling deletes its
 * uploads on the server, so one whose files were sent from another device
 * (or before a reload) stays queued and goes out with the next message.
 * A prompt another workspace's agent sent is not the user's to take back.
 */
function canCallOff(message: PendingMessage): boolean {
  if (message.sentFromWorkspace) return false
  return !message.attachments?.length || Boolean(message.files?.length)
}

/**
 * Cancel this client's queued messages for ``sessionId``: unread steers and
 * held ones (``heldOnly`` keeps the steers). Returns the ones that were still
 * queued, oldest first; one the agent read first stays where it is.
 */
export async function callOffSteers(sessionId: string, options: { heldOnly?: boolean } = {}): Promise<Returned[]> {
  const { _pendingMessages: pending, removePendingMessage } = useAgentStore.getState()
  const steers = pending
    .filter((message) => message.sessionId === sessionId && canCallOff(message))
    .filter((message) => !options.heldOnly || message.heldUntilTurnEnd)
    .sort((a, b) => (a.submittedAt ?? 0) - (b.submittedAt ?? 0))
  const outcomes = await Promise.all(steers.map((message) => removePendingMessage(message.id)))
  return steers
    .filter((_, i) => outcomes[i] === 'cancelled')
    .map((message) => ({
      content: message.content,
      ...(message.files?.length ? { files: message.files } : {}),
      ...(message.mentions?.length ? { mentions: message.mentions } : {}),
    }))
}

/**
 * Stop the running turn. Stopping also calls off what was lined up behind it:
 * unread steers and held messages, in the order they were sent, return to
 * the composer rather than reaching the agent after the stop.
 */
export async function stopTurn(composer: InputComposerHandle | null): Promise<void> {
  const { sessionId, stopAgent } = useAgentStore.getState()
  if (!sessionId) return stopAgent()
  // Before the interrupt, which would release queued messages into history.
  const queued = await callOffSteers(sessionId)
  returnToComposer(composer, queued)
  return stopAgent()
}

/**
 * After a Stop on a phone: a "Stopped" toast whose Resume sends "Continue",
 * so a stop by mistake costs one tap (mockup J5 5.2).
 */
export function pushStoppedToast(workspace: string, composer: () => InputComposerHandle | null): string {
  return useToastStore.getState().push({
    tone: 'info',
    title: 'Stopped',
    action: { label: 'Resume', onAction: () => { void deliverFromComposer(workspace, composer(), { content: 'Continue' }) } },
  })
}

/** Send a composer message the way the user chose; an idle agent just starts a turn. */
export async function deliverFromComposer(
  workspace: string,
  composer: InputComposerHandle | null,
  message: { content: string; files?: File[]; mentions?: string[] },
  delivery: SendDelivery = 'steer',
): Promise<void> {
  // Phones: a light tap confirms the message left the composer (no-op elsewhere).
  haptic('tick')
  const { isAgentWorking, sessionId } = useAgentStore.getState()
  const plan = planComposerDelivery({ working: isAgentWorking, sessionId, delivery })
  let calledOff: Returned[] = []
  const stoppedForSend = plan.kind === 'stop_then_send'
  if (stoppedForSend) {
    // Stopping calls off held messages as any stop does (unread steers go
    // along with the stop as context), but they return to the composer only
    // after this send, so a failed send restores its own draft first
    // (``restoreLastSubmission`` yields to a non-empty composer).
    if (sessionId) calledOff = await callOffSteers(sessionId, { heldOnly: true })
    // The stop only adds context, so an active goal stays active.
    await useAgentStore.getState().stopAgent({ keepGoal: true })
  }
  // A held message waits on the server, so it still goes out if this client
  // closes before the turn ends.
  const delivered = await sendFromComposer(workspace, message.content, message.files, message.mentions, plan.kind === 'hold')
  // The composer cleared itself on submit; a send that never landed gets its
  // draft and attachments back instead of vanishing behind an error banner.
  if (!delivered) {
    outcomeHapticFeedback('error')
    composer?.restoreLastSubmission()
    // Nothing is left to run the goal's next turn: pause it, as a plain Stop
    // would have (a session without a goal answers with an error, ignored).
    if (stoppedForSend && sessionId) void pauseSessionGoal(sessionId).catch(() => {})
  }
  returnToComposer(composer, calledOff)
}

/**
 * After a failed turn, hands this client's queued messages (steers and held
 * ones) back to the composer: nothing will send them, and the next message
 * would otherwise carry them along unasked.
 */
export function useReturnQueuedAfterFailure({ sessionId, composerRef }: {
  sessionId: string | null
  composerRef: RefObject<InputComposerHandle | null>
}) {
  const queuedCount = useAgentStore((s) => (
    sessionId ? (s._pendingMessages ?? []).filter((message) => message.sessionId === sessionId).length : 0
  ))
  // A session switch clears the working flag before the server has said
  // whether that session's turn is still running; its loaded history is what
  // makes an idle flag trustworthy.
  const idle = useAgentStore((s) => !s.isAgentWorking && s._syncedThrough !== null)
  const turnFailed = useAgentStore((s) => (s.leadName ? s.agentStreams[s.leadName]?.status === 'error' : false))
  const returningRef = useRef(false)

  useEffect(() => {
    const decision = decideQueuedAfterFailure({
      hasTarget: Boolean(sessionId),
      idle,
      returning: returningRef.current,
      turnFailed,
      queuedCount,
    })
    if (decision.kind === 'wait' || !sessionId) return
    returningRef.current = true
    void callOffSteers(sessionId)
      .then((queued) => returnToComposer(composerRef.current, queued))
      .finally(() => { returningRef.current = false })
  }, [sessionId, idle, queuedCount, turnFailed, composerRef])
}
