/**
 * Tests for ``Thinking`` reasoning trace renderer.
 *
 * Focus: ``splitSections`` correctness for the multi-``**Header**`` reasoning
 * format produced by OpenAI's ``/responses`` API.
 */

import { describe, expect, it } from 'bun:test'
import { render } from '@testing-library/react'
import { Thinking } from '@/components/Thinking'
import { splitSections } from '@/utils/thinking'

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
  it('renders each section header as a separate styled run', () => {
    const text = '**One**\n\nfirst.\n\n**Two**\n\nsecond.'
    const { container, getByText } = render(<Thinking content={text} />)

    expect(getByText('One')).toBeTruthy()
    expect(getByText('Two')).toBeTruthy()
    expect(getByText('first.')).toBeTruthy()
    expect(getByText('second.')).toBeTruthy()
    // No raw asterisks should leak into the rendered text.
    expect(container.textContent).not.toContain('**')
  })

  it('collapses double newlines in thinking content to a single newline for display', () => {
    const text = 'Line one.\n\nLine two.\n\n\nLine three.'
    const { container } = render(<Thinking content={text} />)

    expect(container.textContent).toContain('Line one.\nLine two.\nLine three.')
    expect(container.textContent).not.toContain('\n\n')
  })
})
