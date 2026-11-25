/** A background command's end report: what its row says and shows. */
import { describe, expect, it } from 'bun:test'

import { commandExit, commandOutcome, commandOutput } from '@/utils/command-report'

const extra = (over: Record<string, unknown> = {}) => ({
  from_agent: 'shell',
  command_exit: { number: 3, command: 'make verify-v3', description: '', end: 'exited', succeeded: false, exit_code: 101, signal: null, ran_seconds: 372, lines: 1203, shown_lines: 40, log_path: '/a/commands/3.log', ...over },
})

describe('commandExit', () => {
  it('reads the command and how it ended from the row', () => {
    expect(commandExit(extra())).toEqual({ number: 3, command: 'make verify-v3', description: '', end: 'exited', succeeded: false, exitCode: 101, ranSeconds: 372, lines: 1203, shownLines: 40, logPath: '/a/commands/3.log' })
  })

  it('is null for any other row', () => {
    expect(commandExit({ from_agent: 'explorer#1' })).toBeNull()
    expect(commandExit({ from_agent: 'shell', commands_cut_off: [1] })).toBeNull()
    expect(commandExit(undefined)).toBeNull()
  })
})

describe('commandOutcome', () => {
  const outcome = (over: Record<string, unknown>) => commandOutcome(commandExit(extra(over))!)

  it('shows the exit code as a terminal does, coloured by outcome', () => {
    expect(outcome({})).toEqual({ text: 'exit 101', tone: 'error' })
    expect(outcome({ succeeded: true, exit_code: 0 })).toEqual({ text: 'exit 0', tone: 'ok' })
  })

  it('says so when the command did not end by itself', () => {
    expect(outcome({ end: 'timed_out', exit_code: null })).toEqual({ text: 'timed out', tone: 'error' })
    expect(outcome({ end: 'stopped_by_user', exit_code: null })).toEqual({ text: 'stopped', tone: 'neutral' })
    // Ended by a signal: no exit code to show.
    expect(outcome({ exit_code: null, signal: 9 })).toEqual({ text: 'failed', tone: 'error' })
  })
})

describe('commandOutput', () => {
  it('is the report without the three lines the agent reads first', () => {
    const report = '[Background command 3 failed: exit code 101 after 6m 12s]\nmake verify-v3\nLast 2 of 1,203 lines (full output: /a/commands/3.log):\ntest a ... FAILED\n1 failed'
    expect(commandOutput(report)).toBe('test a ... FAILED\n1 failed')
    expect(commandOutput('[Background command 3 succeeded after 2s]\ntrue\nNo output.')).toBe('')
  })
})
