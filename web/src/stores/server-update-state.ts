import { defineMachine } from '@/lib/machine'

/** One server update from this client (``useServerUpdateStore``). */
export type ServerUpdatePhase =
  | { kind: 'idle' }
  /** Asking the server to start; nothing is running yet. */
  | { kind: 'starting' }
  | { kind: 'updating'; from: string; target: string }
  | { kind: 'done'; from: string; to: string }
  | { kind: 'failed'; message: string; log?: string }

export type ServerUpdateEvent =
  | { type: 'start' }
  /** The server took the request. */
  | { type: 'accepted'; from: string; target: string }
  /** It answers on the new version. */
  | { type: 'finished'; to: string }
  | { type: 'failed'; message: string; log?: string }
  | { type: 'reset' }

export const UPDATE_IDLE: ServerUpdatePhase = { kind: 'idle' }
const start = (): ServerUpdatePhase => ({ kind: 'starting' })
const failed = (_: ServerUpdatePhase, e: Extract<ServerUpdateEvent, { type: 'failed' }>): ServerUpdatePhase =>
  e.log === undefined ? { kind: 'failed', message: e.message } : { kind: 'failed', message: e.message, log: e.log }
const reset = (): ServerUpdatePhase => UPDATE_IDLE

export const serverUpdateMachine = defineMachine<ServerUpdatePhase, ServerUpdateEvent>('server update', {
  idle: { start, reset },
  // No second start while one runs: the button is busy, and start() checks ``can``.
  starting: {
    accepted: (_, e) => ({ kind: 'updating', from: e.from, target: e.target }),
    failed,
    reset,
  },
  updating: {
    finished: (s, e) => ({ kind: 'done', from: s.from, to: e.to }),
    failed,
    reset,
  },
  done: { start, reset },
  failed: { start, reset },
})
