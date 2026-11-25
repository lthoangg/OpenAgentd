/**
 * A background command's end report in the transcript: the command, how it
 * ended, how long it ran, and the end of its output.
 */
import { afterEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, render, screen } from '@testing-library/react'

import type { ContentBlock } from '@/api/types'
import { AgentView } from '@/components/AgentView'

mock.module('lucide-react', () => new Proxy({}, { get: () => () => null }))

afterEach(cleanup)

const exit = (over: Record<string, unknown> = {}) => ({
  number: 3, command: 'make verify-v3', description: '', end: 'exited', succeeded: false, exit_code: 101, signal: null, ran_seconds: 372, lines: 1203, shown_lines: 2, log_path: '/a/commands/3.log', ...over,
})
const report = (over: Record<string, unknown> = {}, output = 'test a ... FAILED\n1 failed'): ContentBlock => ({
  id: 'r1',
  type: 'user',
  content: `[Background command 3 failed: exit code 101 after 6m 12s]\nmake verify-v3\nLast 2 of 1,203 lines (full output: /a/commands/3.log):\n${output}`,
  extra: { from_agent: 'shell', command_exit: exit(over) },
})

function renderReport(block: ContentBlock) {
  render(<AgentView blocks={[{ id: 'u1', type: 'user', content: 'Run the check.' }, { id: 'a1', type: 'text', content: 'Started.' }, block]} currentBlocks={[]} isWorking={false} />)
  return document.querySelector('[data-command-report]') as HTMLElement
}

describe('a background command report', () => {
  it('names the command, its exit code and how long it ran, then the end of its output', () => {
    const el = renderReport(report())
    expect(el.querySelector('[data-command-report-head]')?.textContent).toBe('Commandmake verify-v3exit 101· 6m 12s')
    expect(screen.getByText('exit 101').className).toContain('text-(--color-error)')
    expect(el.querySelector('pre')?.textContent).toBe('test a ... FAILED\n1 failed')
    expect(el.textContent).toContain('Last 2 of 1,203 lines')
    // What the agent reads first is not repeated to the person.
    expect(el.textContent).not.toContain('[Background command 3')
    expect(screen.queryByText('Report from')).toBeNull()
  })

  it('shows a passing command in the success tone, by its description when it has one', () => {
    const el = renderReport(report({ succeeded: true, exit_code: 0, description: 'Run the backend check', lines: 2 }))
    expect(el.querySelector('[data-command-report-head]')?.textContent).toBe('CommandRun the backend checkexit 0· 6m 12s')
    expect(screen.getByText('exit 0').className).toContain('text-(--accent-green-text)')
    // Everything it printed is shown: no "last N of M" caption.
    expect(el.textContent).not.toContain('Last 2 of')
  })

  it('says so when the command printed nothing', () => {
    const block = report({ lines: 0, shown_lines: 0 }, '')
    block.content = '[Background command 3 failed: exit code 101 after 6m 12s]\nmake verify-v3\nNo output.'
    const el = renderReport(block)
    expect(el.querySelector('pre')).toBeNull()
    expect(el.textContent).toContain('No output')
  })
})
