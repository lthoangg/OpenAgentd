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

  it('keeps one blank line between paragraphs, however many the provider sent', () => {
    // Gemini joins its chunks with "\n\n\n\n"; kept as-is, pre-wrap drew
    // three empty lines between every paragraph.
    expect(splitSections('First thought.\n\n\n\nSecond thought.\n\n\n\n\nThird.')).toEqual([
      { header: null, body: 'First thought.\n\nSecond thought.\n\nThird.' },
    ])
    expect(splitSections('**Plan**\n\nA line.\n \n\t\nNext.')[0].body).toBe('A line.\n\nNext.')
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

  it('keeps paragraph breaks, with longer runs of blank lines cut to one', () => {
    const text = 'Line one.\n\nLine two.\n\n\nLine three.'
    const { container } = render(<Thinking content={text} isStreaming />)

    expect(container.textContent).toContain('Line one.\n\nLine two.\n\nLine three.')
  })

  it('shows a finished trace in full, with no "Thought for" row or toggle', () => {
    const { container } = render(<Thinking content={TRACE} durationMs={12_000} />)

    expect(screen.getByText('Read the config first.')).toBeTruthy()
    expect(screen.getByText('Then run the tests.')).toBeTruthy()
    expect(screen.queryByRole('button')).toBeNull()
    expect(container.textContent).not.toContain('Thought')
  })

  it('shows a streaming trace in full with no "Thinking…" label or toggle', () => {
    render(<Thinking content={TRACE} isStreaming />)

    expect(screen.queryByText('Thinking…')).toBeNull()
    expect(screen.getByText('Read the config first.')).toBeTruthy()
    expect(screen.getByText('Then run the tests.')).toBeTruthy()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('renders nothing for a whitespace-only trace', () => {
    const { container } = render(<Thinking content={'  \n '} />)

    expect(container.innerHTML).toBe('')
  })

  for (const isStreaming of [true, false]) {
    it(`renders the trace inline in mono, not italic or as a quote (streaming=${isStreaming})`, () => {
      const { container } = render(<Thinking content={TRACE} isStreaming={isStreaming} />)

      const trace = screen.getByText('Read the config first.').closest('[data-thinking-trace]')
      expect(trace?.className).toContain('font-mono')
      expect(trace?.className).not.toContain('italic')
      expect(container.querySelector('.border-l')).toBeNull()
      // Section headers are bold so they scan as titles.
      expect(screen.getByText('Planning').className).toContain('font-semibold')
    })
  }
})

describe('Thinking — a long trace', () => {
  const TRACE = '**Planning**\n\nRead the config first.\n\n**Checking**\n\nThen run the tests.'
  const proto = HTMLElement.prototype
  const realScrollHeight = Object.getOwnPropertyDescriptor(proto, 'scrollHeight')
  const realClientHeight = Object.getOwnPropertyDescriptor(proto, 'clientHeight')

  /** Lay the trace out taller than its box: the cap is cutting it. */
  function layOut(scrollHeight: number, clientHeight: number) {
    Object.defineProperty(proto, 'scrollHeight', {
      configurable: true,
      get(this: HTMLElement) { return this.hasAttribute('data-thinking-trace') ? scrollHeight : 0 },
    })
    Object.defineProperty(proto, 'clientHeight', {
      configurable: true,
      get(this: HTMLElement) { return this.hasAttribute('data-thinking-trace') ? clientHeight : 0 },
    })
  }
  afterEach(() => {
    for (const [key, real] of [['scrollHeight', realScrollHeight], ['clientHeight', realClientHeight]] as const) {
      if (real) Object.defineProperty(proto, key, real)
      else delete (proto as unknown as Record<string, unknown>)[key]
    }
  })

  it('caps the reasoning height and keeps its scrolling to itself', () => {
    render(<Thinking content={TRACE} />)

    const trace = screen.getByText('Read the config first.').closest('[data-thinking-trace]')
    expect(trace?.className).toContain('max-h-[min(24rem,50vh)]')
    expect(trace?.className).toContain('overflow-y-auto')
    expect(trace?.className).toContain('overscroll-contain')
  })

  it('offers no "Show full reasoning" while the trace fits its cap', () => {
    layOut(200, 200)
    render(<Thinking content={TRACE} />)

    expect(screen.queryByRole('button', { name: 'Show full reasoning' })).toBeNull()
    expect(screen.queryByRole('region', { name: 'Reasoning' })).toBeNull()
  })

  it('offers "Show full reasoning" once the cap cuts the trace, and lifts the cap with it', () => {
    layOut(900, 384)
    render(<Thinking content={TRACE} />)

    const trace = screen.getByText('Read the config first.').closest('[data-thinking-trace]') as HTMLElement
    // A box that scrolls can take keyboard focus.
    expect(screen.getByRole('region', { name: 'Reasoning' })).toBe(trace)
    expect(trace.tabIndex).toBe(0)

    const more = screen.getByRole('button', { name: 'Show full reasoning' })
    expect(more.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(more)

    expect(trace.className).not.toContain('max-h-')
    expect(trace.className).not.toContain('overflow-y-auto')
    const less = screen.getByRole('button', { name: 'Show less' })
    expect(less.getAttribute('aria-expanded')).toBe('true')

    // Uncapped, nothing overflows any more; the way back stays.
    layOut(900, 900)
    fireEvent.click(less)
    expect(trace.className).toContain('max-h-[min(24rem,50vh)]')
    expect(screen.getByRole('button', { name: 'Show full reasoning' })).toBeTruthy()
  })

  it('follows the newest line of a streaming trace unless the reader scrolled up in it', async () => {
    layOut(900, 384)
    const { rerender } = render(<Thinking content="First line." isStreaming />)
    const trace = document.querySelector('[data-thinking-trace]') as HTMLElement
    expect(trace.scrollTop).toBe(900)

    // The reader scrolls up in the box: new text leaves it where it is.
    trace.scrollTop = 100
    fireEvent.scroll(trace)
    rerender(<Thinking content="First line. And a second." isStreaming />)
    await screen.findByText('First line. And a second.')
    expect(trace.scrollTop).toBe(100)

    // Back at the end of the box: it follows again.
    trace.scrollTop = 520
    fireEvent.scroll(trace)
    rerender(<Thinking content="First line. And a second. And a third." isStreaming />)
    await screen.findByText('First line. And a second. And a third.')
    expect(trace.scrollTop).toBe(900)
  })
})
