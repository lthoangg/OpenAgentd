/**
 * The session's live link (``web/src/AGENTS.md`` → State machines): whether
 * this client has a feed of the session's stream open, and how many
 * reconnects in a row have not delivered a frame yet.
 *
 * ``open`` is optimistic: it starts when ``connectStream`` opens the link,
 * before the fetch attaches, and lasts until the link is closed, fails or
 * backs off. ``attempt`` drives the reconnect back-off and only a frame
 * resets it. The decisions about *what* to do when a link errors or ends
 * are the pure ``decide*`` functions in ``stream-connection.ts``; this is
 * the state they move. Per-link handles (the silence watch, the frames held
 * behind a history load) are effects that live with the link that started
 * them.
 */
import { defineMachine } from '@/lib/machine'
import type { AgentStore } from './types'

export type StreamLink =
  | { kind: 'closed'; attempt: number }
  | { kind: 'open'; attempt: number }
  /** A reconnect is scheduled (``_reconnectTimer``). */
  | { kind: 'backoff'; attempt: number }

export type LinkEvent =
  /** ``connectStream`` opened a link (a first attach, a reattach, the back-off timer). */
  | { type: 'open' }
  /** A link delivered a frame. */
  | { type: 'frame' }
  /** The link dropped while it should stay up: retry after a delay. */
  | { type: 'back_off' }
  /** The link ended for good (detached, failed, the turn ended, aborted). */
  | { type: 'close' }
  /** A switch to another session. */
  | { type: 'reset' }

export const LINK_CLOSED: StreamLink = { kind: 'closed', attempt: 0 }

const toOpen = (s: StreamLink): StreamLink => ({ kind: 'open', attempt: s.attempt })
const toBackoff = (s: StreamLink): StreamLink => ({ kind: 'backoff', attempt: s.attempt + 1 })
const toClosed = (s: StreamLink): StreamLink => ({ kind: 'closed', attempt: s.attempt })
const toReset = (): StreamLink => LINK_CLOSED
/** A frame proves the server reachable: the back-off starts over. */
const heard = (s: StreamLink): StreamLink => (s.attempt === 0 ? s : { ...s, attempt: 0 })

export const linkMachine = defineMachine<StreamLink, LinkEvent>('session link', {
  closed: {
    open: toOpen,
    frame: heard,
    back_off: toBackoff,
    close: (s) => s,
    reset: toReset,
  },
  open: {
    // A reattach over a link that still reads open.
    open: toOpen,
    frame: heard,
    back_off: toBackoff,
    close: toClosed,
    reset: toReset,
  },
  backoff: {
    open: toOpen,
    // The dropped link delivered one more frame before it went.
    frame: heard,
    back_off: toBackoff,
    close: toClosed,
    reset: toReset,
  },
})

/** A link is open (optimistically, from ``connectStream``). */
export function isLinkOpen(link: StreamLink): boolean {
  return link.kind === 'open'
}

/** A link for a store seed: open or closed, with ``attempt`` reconnects behind it. */
export function linkOf(open: boolean, attempt = 0): StreamLink {
  return { kind: open ? 'open' : 'closed', attempt }
}

export function applyLink(draft: Pick<AgentStore, 'streamLink'>, event: LinkEvent): void {
  draft.streamLink = linkMachine.transition(draft.streamLink, event)
}
