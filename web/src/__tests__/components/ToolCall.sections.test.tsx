/**
 * The sections of an open tool row (arguments, terminal, output, result):
 * real buttons that close the row, each with a visible-at-rest Copy control
 * named "Copy" + what it copies, and a brief "Copied" state.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'

import { ToolCall } from '@/components/ToolCall'
import { TOOL_CHIP_CLASS } from '@/components/ToolCall/chipStyles'
import { useFakeTimers } from '../fake-timers'

let refuse = false
const writeText = mock(async (..._args: unknown[]) => {
  if (refuse) throw new Error('denied')
})

beforeEach(() => {
  refuse = false
  writeText.mockClear()
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true, writable: true })
})
afterEach(cleanup)

const ARGS = JSON.stringify({ path: 'src/main.py', offset: 10 })
const open = (name = /^Expand custom_tool details$/) => fireEvent.click(screen.getByRole('button', { name }))

describe('tool section headers', () => {
  it('are buttons that close the row, exposing aria-expanded and aria-controls', () => {
    render(<ToolCall name="custom_tool" args={ARGS} done result="some result" />)
    const row = screen.getByRole('button', { name: 'Expand custom_tool details' })
    expect(row.getAttribute('aria-controls')).toBeNull()
    open()

    const details = screen.getByRole('button', { name: 'Collapse custom_tool details' }).getAttribute('aria-controls')
    expect(details).toBeTruthy()
    const argsHeader = screen.getByRole('button', { name: 'Collapse arguments' })
    const resultHeader = screen.getByRole('button', { name: 'Collapse result' })
    for (const header of [argsHeader, resultHeader]) {
      expect(header.tagName).toBe('BUTTON')
      expect(header.getAttribute('type')).toBe('button')
      expect(header.getAttribute('aria-expanded')).toBe('true')
      expect(header.getAttribute('aria-controls')).toBe(details)
    }
    expect(document.getElementById(details!)).toBeTruthy()

    fireEvent.click(resultHeader)
    expect(screen.getByRole('button', { name: 'Expand custom_tool details' }).getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByRole('button', { name: 'Collapse result' })).toBeNull()
  })

  it('keep Copy beside the toggle, never inside it', () => {
    render(<ToolCall name="custom_tool" args={ARGS} done result="some result" />)
    open()
    const header = screen.getByRole('button', { name: 'Collapse arguments' })
    expect(within(header).queryByRole('button')).toBeNull()
    expect(header.parentElement?.contains(screen.getByRole('button', { name: 'Copy arguments' }))).toBe(true)
  })

  it('give the live output section its own Copy output control', async () => {
    render(<ToolCall name="custom_tool" args={ARGS} liveOutput={'line 1\nline 2'} />)
    open()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Copy output' })) })
    expect(writeText).toHaveBeenCalledWith('line 1\nline 2')
  })
})

describe('tool Copy controls', () => {
  it('are visible at rest, muted, 24px (36px on touch), and not hover-only', () => {
    render(<ToolCall name="custom_tool" args={ARGS} done result="some result" />)
    open()
    for (const name of ['Copy arguments', 'Copy result']) {
      const button = screen.getByRole('button', { name })
      expect(button.className).toContain('size-6')
      expect(button.className).toContain('pointer-coarse:size-9')
      expect(button.className).toContain('text-(--color-text-muted)')
      expect(button.className).not.toContain('opacity-0')
      expect(button.className).not.toContain('group-hover')
      expect(button.getAttribute('title')).toBe(name)
    }
  })

  it('copy the section, then read "Copied" with a check for screen readers', async () => {
    render(<ToolCall name="custom_tool" args={ARGS} done result="some result" />)
    open()
    const button = screen.getByRole('button', { name: 'Copy result' })
    const header = button.closest('div')!
    expect(header.querySelector('[aria-live="polite"]')?.textContent).toBe('')

    await act(async () => { fireEvent.click(button) })
    expect(writeText).toHaveBeenCalledWith('some result')
    // The name stays; the announcement and the icon change.
    expect(screen.getByRole('button', { name: 'Copy result' }).querySelector('svg.lucide-check')).toBeTruthy()
    expect(header.querySelector('[aria-live="polite"]')?.textContent).toBe('Copied')
  })

  it('stay quiet when the clipboard refuses', async () => {
    refuse = true
    render(<ToolCall name="custom_tool" args={ARGS} done result="some result" />)
    open()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Copy result' })) })
    expect(document.querySelector('[aria-live="polite"]:not(:empty)')).toBeNull()
  })

  it('go back to Copy after a moment', async () => {
    const timers = useFakeTimers()
    try {
      render(<ToolCall name="custom_tool" args={ARGS} done result="some result" />)
      open()
      const header = screen.getByRole('button', { name: 'Copy result' }).closest('div')!
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Copy result' })) })
      expect(header.querySelector('[aria-live="polite"]')?.textContent).toBe('Copied')
      act(() => timers.tick(1600))
      expect(header.querySelector('[aria-live="polite"]')?.textContent).toBe('')
      expect(screen.getByRole('button', { name: 'Copy result' }).querySelector('svg.lucide-copy')).toBeTruthy()
    } finally {
      timers.restore()
    }
  })

  it('name a shell terminal by what it copies', () => {
    const args = JSON.stringify({ command: 'npm test' })
    const { rerender } = render(<ToolCall name="shell" args={args} done={false} />)
    open(/^Expand shell details$/)
    expect(screen.getByRole('button', { name: 'Copy command' })).toBeTruthy()

    rerender(<ToolCall name="shell" args={args} done result={'[Succeeded]\n\nall passed\n'} />)
    expect(screen.getByRole('button', { name: 'Copy command and output' })).toBeTruthy()
  })
})

describe('tool action chips', () => {
  it('are 36px on touch without changing the desktop chip', () => {
    expect(TOOL_CHIP_CLASS).toContain('pointer-coarse:min-h-9')
    expect(TOOL_CHIP_CLASS).not.toMatch(/(?<![\w-])border(?![\w-])/)
  })
})
