/**
 * useDraftHandoff — the moment the first message carries a new-session
 * draft into its chat.
 *
 * The send ends the draft at once (the store adds the message
 * optimistically), so the new-session screen and the centered composer
 * unmount in the same render the chat mounts. This hook marks that render
 * as a hand-off so the chat can play it as one motion: the composer glides
 * from the snapshot ``capture`` took on submit, the hero fades out over the
 * chat, and the transcript fades in.
 *
 * Leaving a draft any other way (opening a session, so the route has a
 * session id) is not a hand-off, and neither is anything under reduced
 * motion.
 */
import { useCallback, useEffect, useReducer, useRef } from 'react'
import type { ComposerHandoff } from '../composer/Composer'
import { DRAFTING, IN_CHAT, handoffStep } from './handoff-state'

/** How long the hand-off state lasts: the 400ms glide plus a little slack. */
export const HANDOFF_ACTIVE_MS = 450
/**
 * A snapshot older than this is not from the send that ended the draft
 * (a ``/btw`` or a slash command sent from the draft also captures one).
 */
const SNAPSHOT_MAX_AGE_MS = 5_000

export interface DraftHandoff {
  /** Called by the inline composer just before each submit. */
  capture: (snapshot: ComposerHandoff) => void
  /** The hand-off is playing. */
  active: boolean
  /** Where the composer glides from; ``null`` cross-fades without a glide. */
  snapshot: ComposerHandoff | null
}

export function useDraftHandoff({ isDraft, sessionId, reducedMotion }: {
  isDraft: boolean
  /** The route's session id: set when the draft is left by navigation. */
  sessionId?: string
  reducedMotion: boolean
}): DraftHandoff {
  const pendingRef = useRef<{ snapshot: ComposerHandoff; at: number } | null>(null)
  const capture = useCallback((snapshot: ComposerHandoff) => {
    pendingRef.current = { snapshot, at: Date.now() }
  }, [])

  // Derived during render, not in an effect: the first render of the chat
  // must already know it is a hand-off, or it paints one frame unanimated.
  // The state says whether this was a draft, so there is nothing else to keep in step.
  const [handoffState, send] = useReducer(handoffStep, isDraft ? DRAFTING : IN_CHAT)
  if ((handoffState.kind === 'drafting') !== isDraft) {
    if (isDraft) send({ type: 'enter' })
    else {
      const pending = pendingRef.current
      const fresh = pending !== null && Date.now() - pending.at <= SNAPSHOT_MAX_AGE_MS
      send({ type: 'leave', play: !sessionId && !reducedMotion, snapshot: fresh ? pending.snapshot : null })
    }
  }

  // Any way out of the draft spends the snapshot.
  useEffect(() => {
    if (!isDraft) pendingRef.current = null
  }, [isDraft])

  useEffect(() => {
    if (handoffState.kind !== 'playing') return
    const timer = setTimeout(() => send({ type: 'settle' }), HANDOFF_ACTIVE_MS)
    return () => clearTimeout(timer)
  }, [handoffState])

  return {
    capture,
    active: handoffState.kind === 'playing',
    snapshot: handoffState.kind === 'playing' ? handoffState.snapshot : null,
  }
}
