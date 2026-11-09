/**
 * Decisions for one session stream link (`connectStream`).
 *
 * Authority: the link's own closure in `connectStream` owns its abort
 * controller, held frames, delta buffer and silence timer; the store owns
 * `isConnected`, `_abortController` and the reconnect counters. Every
 * callback is checked against its identity (session id, generation, and
 * controller). A superseded input never applies to the replacement view.
 *
 * `isConnected` stays optimistic: it turns true when a link is opened (before
 * any frame arrives) and false when the link closes, fails or is aborted from
 * outside. A replacement keeps it true. These functions decide; the caller
 * performs the store writes in the same order as before.
 */

/** Why an input from a link is not applied. */
export type StaleLinkReason =
  /** A newer link for the same session aborted this one. */
  | 'superseded'
  /** The store moved to another session (or reloaded this one as new). */
  | 'session_changed'
  /** The page is going away; errors are expected and not shown. */
  | 'unloading'

export type Ignored = { kind: 'ignore'; reason: StaleLinkReason }

/** Where a link's frames go: queued behind a history read, or applied. */
export type AttachPhase =
  | { kind: 'holding'; frames: Array<() => void> }
  | { kind: 'delivering' }

export type FrameDecision = { kind: 'apply' } | Ignored

export function decideFrame(input: {
  aborted: boolean
  sameSession: boolean
  unloading: boolean
  type: string
}): FrameDecision {
  // A read already in flight can resolve in the tick its link was replaced.
  if (input.aborted) return { kind: 'ignore', reason: 'superseded' }
  if (input.unloading && input.type === 'error') return { kind: 'ignore', reason: 'unloading' }
  if (!input.sameSession) return { kind: 'ignore', reason: 'session_changed' }
  return { kind: 'apply' }
}

export type StreamErrorDecision =
  | Ignored
  /** A network drop: reconnect after the back-off delay. */
  | { kind: 'back_off' }
  /** Nothing is running: just stop calling it connected. */
  | { kind: 'detach' }
  /** A failure while work runs: show it and stop calling it connected. */
  | { kind: 'fail'; message: string }

export function decideStreamError(input: {
  sameSession: boolean
  aborted: boolean
  unloading: boolean
  transient: boolean
  working: boolean
  message: string
}): StreamErrorDecision {
  if (!input.sameSession) return { kind: 'ignore', reason: 'session_changed' }
  if (input.unloading) return { kind: 'ignore', reason: 'unloading' }
  if (input.aborted) return { kind: 'ignore', reason: 'superseded' }
  if (input.transient) return { kind: 'back_off' }
  if (!input.working) return { kind: 'detach' }
  return { kind: 'fail', message: input.message }
}

export type StreamEndDecision =
  | Ignored
  /** Closed mid-turn after delivering: reopen at once. */
  | { kind: 'reattach' }
  /** Closed mid-turn having delivered nothing: it would close again, so back off. */
  | { kind: 'back_off' }
  /** Closed with the session idle (or the page going away): the row is not running. */
  | { kind: 'idle' }

export function decideStreamEnd(input: {
  sameSession: boolean
  aborted: boolean
  working: boolean
  unloading: boolean
  receivedAnyEvent: boolean
}): StreamEndDecision {
  if (!input.sameSession) return { kind: 'ignore', reason: 'session_changed' }
  // A belated close of a replaced link must not open a second live link.
  if (input.aborted) return { kind: 'ignore', reason: 'superseded' }
  if (input.working && !input.unloading) return input.receivedAnyEvent ? { kind: 'reattach' } : { kind: 'back_off' }
  return { kind: 'idle' }
}

export type ReconnectTimerDecision =
  | { kind: 'reconnect' }
  | Ignored
  /** Something else reattached first. */
  | { kind: 'ignore'; reason: 'already_connected' }

export function decideReconnectTimer(input: {
  sameSession: boolean
  unloading: boolean
  connected: boolean
}): ReconnectTimerDecision {
  if (!input.sameSession) return { kind: 'ignore', reason: 'session_changed' }
  if (input.unloading) return { kind: 'ignore', reason: 'unloading' }
  if (input.connected) return { kind: 'ignore', reason: 'already_connected' }
  return { kind: 'reconnect' }
}

/** Quick retries for a brief Wi-Fi switch, then up to 30s while offline. */
export function reconnectDelay(attempts: number): number {
  return Math.min(30_000, 1_500 * 2 ** attempts)
}

export type SilenceDecision =
  | { kind: 'resync' }
  | Ignored
  /** Nothing should be talking: the turn ended, or the page is going away. */
  | { kind: 'ignore'; reason: 'not_expected' }

export function decideSilence(input: {
  current: boolean
  sameSession: boolean
  working: boolean
  unloading: boolean
}): SilenceDecision {
  if (!input.current) return { kind: 'ignore', reason: 'superseded' }
  if (!input.sameSession) return { kind: 'ignore', reason: 'session_changed' }
  if (!input.working || input.unloading) return { kind: 'ignore', reason: 'not_expected' }
  return { kind: 'resync' }
}

export type AbortDecision =
  /** Aborted from outside (a cleanup, a send): it no longer delivers. */
  | { kind: 'detach' }
  | { kind: 'ignore'; reason: 'superseded' }

export function decideAbort(input: { replaced: boolean; current: boolean }): AbortDecision {
  // A replacement lives on as the new link; an old link is not the store's.
  if (input.replaced || !input.current) return { kind: 'ignore', reason: 'superseded' }
  return { kind: 'detach' }
}
