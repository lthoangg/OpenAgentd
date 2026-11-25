/** A shell result's status line: the exit code, or that a command was started. */
import { afterEach, describe, expect, it } from 'bun:test'
import { cleanup, render, screen } from '@testing-library/react'

import { ShellResult } from '@/components/ToolResult/ShellResult'

afterEach(cleanup)

describe('ShellResult', () => {
  it('shows the exit code coloured by outcome', () => {
    render(<ShellResult result={'[Failed — exit code 2]\n\nboom'} />)
    expect(screen.getByText('exit 2').className).toContain('text-(--color-error)')
  })

  it('shows a background command as started, in a neutral tone', () => {
    render(<ShellResult result={'[Started in the background: command 3]\nOutput: /a/commands/3.log'} />)
    const status = screen.getByText('started · command 3')
    expect(status.className).toContain('text-(--color-text-muted)')
    expect(status.className).not.toContain('text-(--color-error)')
    expect(screen.getByText('Output: /a/commands/3.log')).toBeTruthy()
  })
})
