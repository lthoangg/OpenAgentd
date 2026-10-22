/**
 * How a composer message reaches the agent while a turn runs, and the
 * lifecycle of one held for "Queue until done" (see ``useHeldMessagesStore``):
 * sent as a turn of its own once the running turn ends, or handed back to the
 * composer whenever sending it would no longer be what the user asked for.
 */
import { useEffect, useRef, type RefObject } from 'react'
import { haptic } from '@/lib/haptics'
import { useAgentStore, type PendingMessage } from '@/stores/useAgentStore'
import { useHeldMessagesStore, type HeldMessage } from '@/stores/useHeldMessagesStore'
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

/**
 * A queued steer this browser can hand back whole. Cancelling deletes its
 * uploads on the server, so one whose files were sent from another device
 * (or before a reload) stays queued and goes out with the next message.
 */
function canCallOff(message: PendingMessage): boolean {
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
  if (isAgentWorking && sessionId && delivery === 'after-turn') {
    useHeldMessagesStore.getState().hold({ sessionId, ...message })
    return
  }
  let calledOff: HeldMessage[] = []
  if (isAgentWorking && delivery === 'interrupt') {
    // Stopping calls off held messages as any stop does, but they return to
    // the composer only after this send, so a failed send restores its own
    // draft first (``restoreLastSubmission`` yields to a non-empty composer).
    if (sessionId) calledOff = useHeldMessagesStore.getState().takeAll(sessionId)
    await useAgentStore.getState().stopAgent()
  }
  const delivered = await sendFromComposer(workspace, message.content, message.files, message.mentions)
  // The composer cleared itself on submit; a send that never landed gets its
  // draft and attachments back instead of vanishing behind an error banner.
  if (!delivered) composer?.restoreLastSubmission()
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
    if (!workspace || !sessionId || !idle || releasingRef.current) return
    const store = useHeldMessagesStore.getState()
    // A follow-up was written for a turn that succeeded, and a steer for one
    // still running: after a failure both go back, steers first (the order
    // they would have gone out in), for the user to resend or rewrite.
    if (turnFailed) {
      if (heldCount === 0 && steerCount === 0) return
      releasingRef.current = true
      void callOffSteers(sessionId)
        .then((steers) => returnToComposer(composerRef.current, [...steers, ...useHeldMessagesStore.getState().takeAll(sessionId)]))
        .finally(() => { releasingRef.current = false })
      return
    }
    if (heldCount === 0) return
    const next = store.takeNext(sessionId)
    if (!next) return
    releasingRef.current = true
    void sendFromComposer(workspace, next.content, next.files, next.mentions)
      .then((delivered) => {
        if (!delivered) {
          returnToComposer(composerRef.current, [next, ...useHeldMessagesStore.getState().takeAll(sessionId)])
        }
      })
      .finally(() => { releasingRef.current = false })
  }, [workspace, sessionId, idle, heldCount, steerCount, turnFailed, composerRef])
}
