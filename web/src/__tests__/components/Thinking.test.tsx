/**
 * Tests for ``Thinking`` reasoning trace renderer.
 *
 * Focus: ``splitSections`` correctness for the multi-``**Header**`` reasoning
 * format produced by OpenAI's ``/responses`` API.
 */

import { afterEach, describe, expect, it } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

import { Thinking } from '@/components/Thinking'
import { splitSections } from '@/utils/thinking'

afterEach(cleanup)

describe('splitSections', () => {
  it('returns a single empty-header section for plain text', () => {
    const sections = splitSections('Just thinking out loud.')
    expect(sections).toEqual([
      { header: null, body: 'Just thinking out loud.' },
    ])
  })

  it('parses a single bold header followed by a body', () => {
    const text = '**Planning**\n\nFirst I need to enumerate options.'
    expect(splitSections(text)).toEqual([
      { header: 'Planning', body: 'First I need to enumerate options.' },
    ])
  })

  it('parses multiple bold headers with separate bodies', () => {
    const text =
      '**Planning**\n\nFirst body.\n\n**Refining**\n\nSecond body.\n\n**Wrap-up**\n\nThird body.'
    expect(splitSections(text)).toEqual([
      { header: 'Planning', body: 'First body.' },
      { header: 'Refining', body: 'Second body.' },
      { header: 'Wrap-up', body: 'Third body.' },
    ])
  })

  it('handles a leading prose paragraph before the first header', () => {
    const text = 'Some prelude.\n\n**Section**\n\nBody.'
    expect(splitSections(text)).toEqual([
      { header: null, body: 'Some prelude.' },
      { header: 'Section', body: 'Body.' },
    ])
  })

  it('does not split inline bold text inside a section body', () => {
    const text = '**Planning**\n\nConsider **only** these cases.'
    const result = splitSections(text)
    expect(result).toHaveLength(1)
    expect(result[0]).toEqual({
      header: 'Planning',
      body: 'Consider **only** these cases.',
    })
  })

  it('handles a header with no body (streaming mid-section)', () => {
    expect(splitSections('**Just-started section**')).toEqual([
      { header: 'Just-started section', body: '' },
    ])
  })

  it('handles empty input', () => {
    expect(splitSections('')).toEqual([])
  })
})

describe('Thinking', () => {
  const TRACE = '**Planning**\n\nRead the config first.\n\n**Checking**\n\nThen run the tests.'

  it('renders each section header as a separate styled run', () => {
    const text = '**One**\n\nfirst.\n\n**Two**\n\nsecond.'
    const { container, getByText } = render(<Thinking content={text} isStreaming />)

    expect(getByText('One')).toBeTruthy()
    expect(getByText('Two')).toBeTruthy()
    expect(getByText('first.')).toBeTruthy()
    expect(getByText('second.')).toBeTruthy()
    // No raw asterisks should leak into the rendered text.
    expect(container.textContent).not.toContain('**')
  })

  it('preserves double newlines in thinking content as-is', () => {
    const text = 'Line one.\n\nLine two.\n\n\nLine three.'
    const { container } = render(<Thinking content={text} isStreaming />)

    expect(container.textContent).toContain('Line one.\n\nLine two.\n\n\nLine three.')
  })

  it('folds a finished trace behind a "Thought for" row that opens it', () => {
    render(<Thinking content={TRACE} durationMs={12_000} />)

    const row = screen.getByRole('button', { name: /Thought for 12.0 s/ })
    expect(row.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByText('Read the config first.')).toBeNull()

    fireEvent.click(row)

    expect(row.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByText('Read the config first.')).toBeTruthy()
  })

  it('says "Thought" when the server did not record how long', () => {
    render(<Thinking content={TRACE} />)

    expect(screen.getByRole('button', { name: 'Thought' })).toBeTruthy()
  })

  it('shows a streaming trace in full under a "Thinking…" row, with no toggle', () => {
    render(<Thinking content={TRACE} isStreaming />)

    expect(screen.getByText('Thinking…')).toBeTruthy()
    expect(screen.getByText('Read the config first.')).toBeTruthy()
    expect(screen.getByText('Then run the tests.')).toBeTruthy()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('renders nothing for a whitespace-only trace', () => {
    const { container } = render(<Thinking content={'  \n '} />)

    expect(container.innerHTML).toBe('')
  })
})
