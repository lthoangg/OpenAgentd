import { describe, expect, it } from 'bun:test'
import { IllegalTransition } from '@/lib/machine'
import {
  SHELL_CONNECTING,
  closedReasonOf,
  shellErrorOf,
  terminalShellMachine,
  type TerminalShell,
  type TerminalShellEvent,
} from '@/stores/terminal-state'

const STATES: TerminalShell[] = [
  SHELL_CONNECTING,
  { kind: 'connected' },
  { kind: 'exited', reason: 'exit' },
  { kind: 'error', message: 'boom' },
]
const EVENTS: TerminalShellEvent[] = [
  { type: 'connect' },
  { type: 'attached' },
  { type: 'exited', reason: 'lost' },
  { type: 'failed', message: 'no' },
]

describe('terminal shell', () => {
  it('lists exactly these moves', () => {
    expect(terminalShellMachine.moves()).toEqual([
      ['connecting', 'connect'],
      ['connecting', 'attached'],
      ['connecting', 'exited'],
      ['connecting', 'failed'],
      ['connected', 'connect'],
      ['connected', 'exited'],
      ['connected', 'failed'],
      ['exited', 'connect'],
      ['error', 'connect'],
    ])
  })

  it('rejects every move the table does not list', () => {
    const listed = new Set(terminalShellMachine.moves().map(([s, e]) => `${s}/${e}`))
    for (const state of STATES) {
      for (const event of EVENTS) {
        if (listed.has(`${state.kind}/${event.type}`)) continue
        expect(() => terminalShellMachine.transition(state, event)).toThrow(IllegalTransition)
      }
    }
  })

  it('keeps why it ended and what failed only while it is ended or failed', () => {
    const ended = terminalShellMachine.transition({ kind: 'connected' }, { type: 'exited', reason: 'elsewhere' })
    expect(closedReasonOf({ shellState: ended })).toBe('elsewhere')
    const again = terminalShellMachine.transition(ended, { type: 'connect' })
    expect(closedReasonOf({ shellState: again })).toBeUndefined()
    const failed = terminalShellMachine.transition(again, { type: 'failed', message: 'boom' })
    expect(shellErrorOf({ shellState: failed })).toBe('boom')
    expect(shellErrorOf({ shellState: terminalShellMachine.transition(failed, { type: 'connect' }) })).toBeUndefined()
  })
})
