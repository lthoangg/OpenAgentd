import { defineMachine } from '@/lib/machine'

/**
 * Whether the transcript keeps its end in view (``useAutoFollowScroll``).
 *
 * - ``following``: content that arrives is followed; the hook pins the end.
 * - ``reading``: the view is away from the end, moved there by the reader or
 *   by the app (a prompt jump, a return to where a session was left). The
 *   browser anchors the first block in view, and "Jump to latest" shows.
 * - ``settling``: a fold is closing in place while the end was followed. The
 *   view is the fold's until it lands, with no chip; then following resumes.
 *
 * The glide to the end, the fold's settle timer and the pending restore are
 * effects the hook runs around these moves, not states of their own.
 */
export type FollowMode = { kind: 'following' } | { kind: 'reading' } | { kind: 'settling' }

export type FollowEvent =
  /** The view is back on the end: the reader got there, a send, Jump to latest, a switch, a fold landed. */
  | { type: 'follow' }
  /** The view left the end: the reader scrolled up, or the app moved it. */
  | { type: 'leave' }
  /** A fold closes in place while the end is followed. */
  | { type: 'fold' }

export const FOLLOWING: FollowMode = { kind: 'following' }
const READING: FollowMode = { kind: 'reading' }
const SETTLING: FollowMode = { kind: 'settling' }

export const followMachine = defineMachine<FollowMode, FollowEvent>('transcript follow', {
  following: {
    follow: (s) => s,
    leave: () => READING,
    fold: () => SETTLING,
  },
  reading: {
    follow: () => FOLLOWING,
    leave: (s) => s,
    // No fold: a fold closing above a reader shifts the view and nothing else.
  },
  settling: {
    follow: () => FOLLOWING,
    // The reader scrolled up while the fold closed: the view is theirs.
    leave: () => READING,
  },
})

/** The end is kept in view. */
export const followsEnd = (mode: FollowMode): boolean => mode.kind === 'following'
