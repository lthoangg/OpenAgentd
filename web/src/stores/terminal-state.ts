import { defineMachine } from '@/lib/machine'

/**
 * Why a session is `exited`: the shell exited, was closed for idling, is gone
 * from the server (`lost`), or another window took it over (`elsewhere` —
 * the shell still runs; Reconnect takes it back).
 */
export type TerminalClosedReason = 'exit' | 'idle' | 'lost' | 'elsewhere'

/**
 * One terminal tab's link to its shell (``useTerminalStore``). Why it ended
 * and what failed are data of ``exited`` and ``error``, so neither outlives
 * the state it explains.
 */
export type TerminalShell =
  | { kind: 'connecting' }
  | { kind: 'connected' }
  | { kind: 'exited'; reason: TerminalClosedReason }
  | { kind: 'error'; message: string }

export type TerminalSessionStatus = TerminalShell['kind']

export type TerminalShellEvent =
  /** A connect or reattach is under way. */
  | { type: 'connect' }
  /** The socket is open. */
  | { type: 'attached' }
  | { type: 'exited'; reason: TerminalClosedReason }
  | { type: 'failed'; message: string }

export const SHELL_CONNECTING: TerminalShell = { kind: 'connecting' }
const CONNECTED: TerminalShell = { kind: 'connected' }
const exited = (_: TerminalShell, e: Extract<TerminalShellEvent, { type: 'exited' }>): TerminalShell => ({ kind: 'exited', reason: e.reason })
const failed = (_: TerminalShell, e: Extract<TerminalShellEvent, { type: 'failed' }>): TerminalShell => ({ kind: 'error', message: e.message })

export const terminalShellMachine = defineMachine<TerminalShell, TerminalShellEvent>('terminal shell', {
  connecting: {
    // The next automatic reattach after a failed one.
    connect: (s) => s,
    attached: () => CONNECTED,
    // The shell is gone, or another window has it.
    exited,
    failed,
  },
  connected: {
    // The socket dropped and the shell lives on: reattach.
    connect: () => SHELL_CONNECTING,
    exited,
    failed,
  },
  // Only Reconnect leaves an ended or failed shell.
  exited: { connect: () => SHELL_CONNECTING },
  error: { connect: () => SHELL_CONNECTING },
})

interface HasShell {
  shellState: TerminalShell
}

export const closedReasonOf = (meta: HasShell | undefined): TerminalClosedReason | undefined =>
  meta?.shellState.kind === 'exited' ? meta.shellState.reason : undefined
export const shellErrorOf = (meta: HasShell | undefined): string | undefined =>
  meta?.shellState.kind === 'error' ? meta.shellState.message : undefined
/** Running or on its way: it holds (or is about to hold) a shell. */
export const isShellLive = (shell: TerminalShell): boolean => shell.kind === 'connected' || shell.kind === 'connecting'
