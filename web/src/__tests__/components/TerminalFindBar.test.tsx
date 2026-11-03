import '@testing-library/jest-dom'
import { afterEach, describe, expect, it, mock } from 'bun:test'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ComponentProps } from 'react'

import { TerminalFindBar } from '@/components/Terminal/TerminalFindBar'
import { formatMatchStatus, type TerminalSearch } from '@/components/Terminal/terminal-search'

type ResultListener = (event: { resultIndex: number; resultCount: number }) => void

function fakeSearch() {
  let listener: ResultListener | null = null
  const calls: Array<{ kind: string; term?: string; options?: Record<string, unknown> }> = []
  const search: TerminalSearch = {
    findNext: (term, options) => { calls.push({ kind: 'next', term, options: options as Record<string, unknown> }); return true },
    findPrevious: (term, options) => { calls.push({ kind: 'prev', term, options: options as Record<string, unknown> }); return true },
    clearDecorations: () => { calls.push({ kind: 'clear' }) },
    onDidChangeResults: (cb) => {
      listener = cb
      return { dispose: () => { listener = null } }
    },
  }
  return { search, calls, emit: (resultIndex: number, resultCount: number) => act(() => listener?.({ resultIndex, resultCount })) }
}

function setup(overrides: Partial<ComponentProps<typeof TerminalFindBar>> = {}) {
  const fake = fakeSearch()
  const onClose = mock(() => {})
  render(<TerminalFindBar search={fake.search} theme="dark" onClose={onClose} {...overrides} />)
  return { ...fake, onClose, input: screen.getByRole('searchbox', { name: 'Find in terminal' }) as HTMLInputElement }
}

afterEach(cleanup)

describe('formatMatchStatus', () => {
  it('reads "3 of 12"', () => {
    expect(formatMatchStatus('x', 2, 12)).toBe('3 of 12')
  })
  it('says when nothing matches and stays blank for an empty query', () => {
    expect(formatMatchStatus('x', -1, 0)).toBe('No results')
    expect(formatMatchStatus('', -1, 0)).toBe('')
  })
  it('shows the count with a plus when xterm stops counting', () => {
    expect(formatMatchStatus('x', -1, 1000)).toBe('1000+')
  })
})

describe('TerminalFindBar', () => {
  it('is a labelled search landmark with a focused input', () => {
    const { input } = setup()
    expect(screen.getByRole('search', { name: 'Find in terminal' })).toBeInTheDocument()
    expect(document.activeElement).toBe(input)
  })

  it('searches as you type, with match decorations so the count is reported', () => {
    const { input, calls } = setup()
    fireEvent.change(input, { target: { value: 'error' } })
    const call = calls.at(-1)!
    expect(call).toMatchObject({ kind: 'next', term: 'error' })
    expect(call.options).toMatchObject({ caseSensitive: false, incremental: true })
    expect((call.options!.decorations as Record<string, string>).matchOverviewRuler).toMatch(/^#[0-9a-f]{6}$/i)
  })

  it('shows "3 of 12" from the search results', () => {
    const { input, emit } = setup()
    fireEvent.change(input, { target: { value: 'error' } })
    emit(2, 12)
    expect(screen.getByRole('status')).toHaveTextContent('3 of 12')
    emit(-1, 0)
    expect(screen.getByRole('status')).toHaveTextContent('No results')
  })

  it('steps with Enter and Shift+Enter', () => {
    const { input, calls } = setup()
    fireEvent.change(input, { target: { value: 'x' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(calls.at(-1)).toMatchObject({ kind: 'next', term: 'x' })
    expect(calls.at(-1)!.options).toMatchObject({ incremental: false })
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true })
    expect(calls.at(-1)).toMatchObject({ kind: 'prev', term: 'x' })
  })

  it('steps with the next and previous buttons', () => {
    const { input, calls } = setup()
    fireEvent.change(input, { target: { value: 'x' } })
    fireEvent.click(screen.getByRole('button', { name: /Previous match/ }))
    expect(calls.at(-1)).toMatchObject({ kind: 'prev' })
    fireEvent.click(screen.getByRole('button', { name: /Next match/ }))
    expect(calls.at(-1)).toMatchObject({ kind: 'next' })
  })

  it('toggles case sensitivity and searches again', () => {
    const { input, calls } = setup()
    fireEvent.change(input, { target: { value: 'Err' } })
    const toggle = screen.getByRole('button', { name: 'Match case' })
    expect(toggle).toHaveAttribute('aria-pressed', 'false')
    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-pressed', 'true')
    expect(calls.at(-1)!.options).toMatchObject({ caseSensitive: true })
  })

  it('closes on Escape and on the close button, clearing the highlights', () => {
    const { input, onClose, calls } = setup()
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: 'Close find' }))
    expect(onClose).toHaveBeenCalledTimes(2)
    cleanup()
    expect(calls.some((call) => call.kind === 'clear')).toBe(true)
  })

  it('clears highlights when the query is emptied', () => {
    const { input, calls } = setup()
    fireEvent.change(input, { target: { value: 'x' } })
    fireEvent.change(input, { target: { value: '' } })
    expect(calls.at(-1)).toMatchObject({ kind: 'clear' })
  })

  it('starts from a seed query and selects it for replacing', () => {
    const { input, calls } = setup({ initialQuery: 'boom' })
    expect(input.value).toBe('boom')
    expect(calls.some((call) => call.kind === 'next' && call.term === 'boom')).toBe(true)
  })
})
