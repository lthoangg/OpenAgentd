/**
 * How a composer message reaches the agent while a turn runs, and the
 * lifecycle of one held for "Queue until done" (see ``useHeldMessagesStore``):
 * sent as a turn of its own once the running turn ends, or handed back to the
 * composer whenever sending it would no longer be what the user asked for.
 */
import { useEffect, useRef, type RefObject } from 'react'
import { haptic, outcomeHapticFeedback } from '@/lib/haptics'
import { pauseSessionGoal } from '@/api/client'
import { useAgentStore, type PendingMessage } from '@/stores/useAgentStore'
import { useHeldMessagesStore, type HeldMessage } from '@/stores/useHeldMessagesStore'
import { useToastStore } from '@/stores/useToastStore'
import type { InputComposerHandle, SendDelivery } from '../InputComposer'

/** Send with the session's current model settings, as the composer does. */
function sendFromComposer(workspace: string, content: string, files?: File[], mentions?: string[]) {
  const current = useAgentStore.getState()
  return current.sendMessage(content, files, {
    workspace,
    model: current.sessionModel || null,
    thinkingLevel: current.sessionThinkingLevel || null,
    fastMode: current.sessionFastMode,
    mentions,
  })
}

/** What goes back into the composer: a held message or a called-off steer. */
type Returned = Pick<HeldMessage, 'content' | 'files' | 'mentions'>

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

export type HeldReleaseDecision =
  | { kind: 'wait' }
  | { kind: 'return_to_composer' }
  | { kind: 'send_next' }

export function decideHeldRelease(input: {
  hasTarget: boolean
  /** Idle by the loaded history, not merely by the working flag. */
  idle: boolean
  releasing: boolean
  turnFailed: boolean
  heldCount: number
  steerCount: number
}): HeldReleaseDecision {
  if (!input.hasTarget || !input.idle || input.releasing) return { kind: 'wait' }
  if (input.turnFailed) return input.heldCount === 0 && input.steerCount === 0 ? { kind: 'wait' } : { kind: 'return_to_composer' }
  return input.heldCount === 0 ? { kind: 'wait' } : { kind: 'send_next' }
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
 * Cancel this client's unread steers for ``sessionId``. Returns the ones that
 * were still queued, oldest first; one the agent read first stays where it is.
 */
export async function callOffSteers(sessionId: string): Promise<Returned[]> {
  const { _pendingMessages: pending, removePendingMessage } = useAgentStore.getState()
  const steers = pending
    .filter((message) => message.sessionId === sessionId && canCallOff(message))
    .sort((a, b) => (a.submittedAt ?? 0) - (b.submittedAt ?? 0))
  const outcomes = await Promise.all(steers.map((message) => removePendingMessage(message.id)))
  return steers
    .filter((_, i) => outcomes[i] === 'cancelled')
    .map((message) => ({ content: message.content, ...(message.files?.length ? { files: message.files } : {}) }))
}

/**
 * Stop the running turn. Stopping also calls off what was lined up behind it:
 * unread steers, then held messages (the order they would have gone out in),
 * return to the composer rather than reaching the agent after the stop.
 */
export async function stopTurn(composer: InputComposerHandle | null): Promise<void> {
  const { sessionId, stopAgent } = useAgentStore.getState()
  if (!sessionId) return stopAgent()
  // Taken at once, so a turn that ends during the cancels cannot send them.
  const held = useHeldMessagesStore.getState().takeAll(sessionId)
  // Before the interrupt, which would release unread steers into history.
  const steers = await callOffSteers(sessionId)
  returnToComposer(composer, [...steers, ...held])
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
  if (plan.kind === 'hold') {
    useHeldMessagesStore.getState().hold({ sessionId: plan.sessionId, ...message })
    return
  }
  let calledOff: HeldMessage[] = []
  const stoppedForSend = plan.kind === 'stop_then_send'
  if (stoppedForSend) {
    // Stopping calls off held messages as any stop does, but they return to
    // the composer only after this send, so a failed send restores its own
    // draft first (``restoreLastSubmission`` yields to a non-empty composer).
    if (sessionId) calledOff = useHeldMessagesStore.getState().takeAll(sessionId)
    // The stop only adds context, so an active goal stays active.
    await useAgentStore.getState().stopAgent({ keepGoal: true })
  }
  const delivered = await sendFromComposer(workspace, message.content, message.files, message.mentions)
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

/** Sends held messages one turn at a time as the session goes idle. */
export function useReleaseHeldMessages({ workspace, sessionId, composerRef }: {
  workspace: string | null
  sessionId: string | null
  composerRef: RefObject<InputComposerHandle | null>
}) {
  const heldCount = useHeldMessagesStore((s) => (
    sessionId ? s.messages.filter((message) => message.sessionId === sessionId).length : 0
  ))
  const steerCount = useAgentStore((s) => (
    sessionId ? (s._pendingMessages ?? []).filter((message) => message.sessionId === sessionId).length : 0
  ))
  // A session switch clears the working flag before the server has said
  // whether that session's turn is still running; its loaded history is what
  // makes an idle flag trustworthy.
  const idle = useAgentStore((s) => !s.isAgentWorking && s._syncedThrough !== null)
  const turnFailed = useAgentStore((s) => (s.leadName ? s.agentStreams[s.leadName]?.status === 'error' : false))
  const releasingRef = useRef(false)

  useEffect(() => {
    const decision = decideHeldRelease({
      hasTarget: Boolean(workspace && sessionId),
      idle,
      releasing: releasingRef.current,
      turnFailed,
      heldCount,
      steerCount,
    })
    if (decision.kind === 'wait' || !workspace || !sessionId) return
    const store = useHeldMessagesStore.getState()
    // After a failure, steers go back first: the order they would have gone out in.
    if (decision.kind === 'return_to_composer') {
      releasingRef.current = true
      void callOffSteers(sessionId)
        .then((steers) => returnToComposer(composerRef.current, [...steers, ...useHeldMessagesStore.getState().takeAll(sessionId)]))
        .finally(() => { releasingRef.current = false })
      return
    }
    const next = store.takeNext(sessionId)
    if (!next) return
    releasingRef.current = true
    void sendFromComposer(workspace, next.content, next.files, next.mentions)
      .then((delivered) => {
        if (!delivered) {
          outcomeHapticFeedback('error')
          returnToComposer(composerRef.current, [next, ...useHeldMessagesStore.getState().takeAll(sessionId)])
        }
      })
      .finally(() => { releasingRef.current = false })
  }, [workspace, sessionId, idle, heldCount, steerCount, turnFailed, composerRef])
}
