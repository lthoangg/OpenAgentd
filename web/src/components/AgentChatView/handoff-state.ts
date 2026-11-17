import { defineMachine } from '@/lib/machine'
import type { ComposerHandoff } from '../composer/Composer'

/**
 * Where the chat is relative to a new-session draft (``useDraftHandoff``).
 *
 * - ``drafting``: the new-session screen is up.
 * - ``playing``: the first message just carried the draft into its chat;
 *   the composer glides from ``snapshot`` (``null`` cross-fades).
 * - ``chat``: a session is open and nothing is playing.
 */
export type HandoffState =
  | { kind: 'drafting' }
  | { kind: 'playing'; snapshot: ComposerHandoff | null }
  | { kind: 'chat' }

export type HandoffEvent =
  /** The draft ended. ``play``: by its first message, with motion allowed. */
  | { type: 'leave'; play: boolean; snapshot: ComposerHandoff | null }
  /** A draft opened. */
  | { type: 'enter' }
  /** The hand-off has played out (``HANDOFF_ACTIVE_MS``). */
  | { type: 'settle' }

export const DRAFTING: HandoffState = { kind: 'drafting' }
export const IN_CHAT: HandoffState = { kind: 'chat' }

export const handoffMachine = defineMachine<HandoffState, HandoffEvent>('draft handoff', {
  drafting: {
    leave: (_, e) => (e.play ? { kind: 'playing', snapshot: e.snapshot } : IN_CHAT),
  },
  playing: {
    settle: () => IN_CHAT,
    // A new draft before the motion ends: the draft is what shows now.
    enter: () => DRAFTING,
  },
  chat: {
    enter: () => DRAFTING,
  },
})

export const handoffStep = (s: HandoffState, e: HandoffEvent): HandoffState => handoffMachine.transition(s, e)
