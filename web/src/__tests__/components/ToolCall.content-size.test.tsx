/**
 * Tool content is read, not glanced at: arguments, commands, live output and
 * result bodies are at least 12px (`text-xs`). `text-meta` stays for metadata
 * (a status word, a count, a duration).
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

import { ToolCall } from '@/components/ToolCall'
import { ToolResult } from '@/components/ToolResult'

afterEach(cleanup)

/** The size class of the nearest element that sets one around `node`. */
function sizeClass(node: HTMLElement): string {
  const sized = node.closest<HTMLElement>('[class*="text-xs"], [class*="text-meta"], [class*="text-sm"]')
  return sized?.className ?? ''
}

function expectContentSize(node: HTMLElement) {
  const classes = sizeClass(node)
  expect(classes).toContain('text-xs')
  expect(classes).not.toContain('text-meta')
}

describe('tool content is at least 12px', () => {
  it('reads live output and arguments at text-xs', () => {
    render(<ToolCall name="custom_tool" args={JSON.stringify({ path: 'a.py' })} liveOutput={'building…\nstep 2'} />)
    fireEvent.click(screen.getAllByRole('button')[0])
    expectContentSize(screen.getByText(/building…/))
    expectContentSize(screen.getByText(/"path": "a\.py"/))
  })

  it('reads a shell command and its output at text-xs', () => {
    render(<ToolCall name="shell" args={JSON.stringify({ command: 'echo hi' })} done={false} liveOutput="hi from the shell" />)
    fireEvent.click(screen.getAllByRole('button')[0])
    expectContentSize(screen.getByText(/hi from the shell/))
  })

  it('reads shell, file-list, file and generic result bodies at text-xs, with the status word and the count meta', () => {
    const shell = render(<ToolResult toolName="shell" result={'[Succeeded]\n\nbuilt in 2s'} />)
    expectContentSize(screen.getByText(/built in 2s/))
    // The outcome is a status word: meta.
    expect(screen.getByText('[Succeeded]').className).toContain('text-meta')
    shell.unmount()

    const list = render(<ToolResult toolName="glob" result={'src/a.ts\nsrc/b.ts'} />)
    expectContentSize(screen.getByText('src/a.ts'))
    // The count is metadata: it keeps the meta size on desktop.
    expect(screen.getByText('2 entries').className).toContain('md:text-meta')
    list.unmount()

    const read = render(<ToolResult toolName="read" result={'const answer = 42'} />)
    expectContentSize(screen.getByText(/const answer = 42/))
    read.unmount()

    render(<ToolResult toolName="web_fetch" result={JSON.stringify({ status: 'ok' })} />)
    expectContentSize(screen.getByText(/"status": "ok"/))
  })

  it('reads background-process output, listings, status bodies and errors at text-xs', () => {
    const output = render(<ToolResult toolName="bg" result={'PID 7 output:\nserver listening'} />)
    expectContentSize(screen.getByText(/server listening/))
    output.unmount()

    const list = render(
      <ToolResult toolName="bg" result={'PID     | Status  | Command\n--------|---------|--------\n7       | running | bun run dev'} />,
    )
    expectContentSize(screen.getByText('bun run dev'))
    list.unmount()

    const status = render(<ToolResult toolName="bg" result={'PID 7: running\nCommand: bun run dev\nBuffered lines: 3'} />)
    expectContentSize(screen.getByText('bun run dev'))
    status.unmount()

    const body = render(<ToolResult toolName="bg" result={'PID 7: still running after 2s\nno new output yet'} />)
    expectContentSize(screen.getByText('no new output yet'))
    body.unmount()

    render(<ToolResult toolName="bg" result={'Error: PID 9 not found. Known PIDs: 7'} />)
    expectContentSize(screen.getByText(/PID 9 not found/))
  })

  it('reads todo notes and outcomes, LSP rows and source excerpts at text-xs', () => {
    const board = [
      'claimed task_1',
      '[task_1] [in_progress] (high) claimed=executor#1 Write the haiku',
      '    instructions: Create haiku.txt first.',
      '    result: Created haiku.txt.',
    ].join('\n')
    const todo = render(<ToolResult toolName="todo" result={board} />)
    expectContentSize(screen.getByText(/Create haiku\.txt first\./))
    expectContentSize(screen.getByText(/Created haiku\.txt\./))
    expectContentSize(screen.getByText(/claimed "Write the haiku"/))
    todo.unmount()

    const empty = render(<ToolResult toolName="todo" result="No todos." />)
    expectContentSize(screen.getByText('No todos.'))
    empty.unmount()

    const lsp = render(<ToolResult toolName="lsp" operation="find_references" result={'app/main.py:12:5 | print(answer())'} />)
    expectContentSize(screen.getByText('print(answer())'))
    expectContentSize(screen.getByText('app/main.py'))
    lsp.unmount()

    render(<ToolResult toolName="lsp" operation="find_references" result="No results." />)
    expectContentSize(screen.getByText('No references found.'))
  })

  it('reads diagnostics and the scheduled-task table at text-xs', () => {
    const diagnostics = render(
      <ToolResult toolName="write" result={'Wrote a.py\n\n[LSP Diagnostics]\n- a.py:1:1: error: Expected expression (pyright)'} />,
    )
    expectContentSize(screen.getByText('Expected expression'))
    diagnostics.unmount()

    const rows = render(
      <ToolResult toolName="schedule" result={'Scheduled tasks (1):\nslug=nightly|name=Nightly|schedule=cron 0 0|status=enabled|runs=3'} />,
    )
    expect(rows.container.querySelector('table')?.className).toContain('text-xs')
    expect(rows.container.querySelector('table')?.className).not.toContain('text-meta')
  })
})
