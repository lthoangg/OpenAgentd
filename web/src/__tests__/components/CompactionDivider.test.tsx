/**
 * Tests for ``CompactionDivider``.
 *
 * Covers:
 *  - Label text for each state (compacting / compacted / error)
 *  - Animated ellipsis present only while compacting
 *  - Summary body collapsed by default; the label toggles it
 *  - Summary body rendered (once expanded) when non-empty and state != error
 *  - Summary body hidden when empty, whitespace-only, or error
 *  - ``isStreaming`` forwarded to ``MarkdownBlock`` so that streaming
 *    content actually displays during the compacting phase (regression for
 *    the bug where summarization streaming content did not show properly)
 */

import { describe, it, expect, afterEach, mock } from 'bun:test'
import { act, render, screen, cleanup, fireEvent } from '@testing-library/react'
import { useFakeTimers } from '../fake-timers'
import { CompactionDivider } from '@/components/CompactionDivider'

afterEach(cleanup)

/** Open the collapsed summary body. */
const expand = () => fireEvent.click(screen.getByRole('button', { expanded: false }))

// ---------------------------------------------------------------------------
// Mock MarkdownBlock so we can:
//   1. keep the full Markdown pipeline out of unit tests
//   2. assert which props are forwarded (especially isStreaming)
// ---------------------------------------------------------------------------

let lastMarkdownProps: Record<string, unknown> = {}

mock.module('@/utils/markdown', () => ({
  MarkdownBlock: (props: Record<string, unknown>) => {
    lastMarkdownProps = props
    return <div data-testid="markdown">{String(props.content ?? '')}</div>
  },
}))

// ---------------------------------------------------------------------------

describe('CompactionDivider — labels', () => {
  it('shows "Summarizing earlier messages…" label while compacting', () => {
    render(<CompactionDivider state="compacting" />)
    expect(screen.getByRole('region', { name: 'Summarizing earlier messages…' })).toBeTruthy()
  })

  it('shows "Earlier messages summarized" label after completion', () => {
    render(<CompactionDivider state="compacted" />)
    expect(screen.getByRole('region', { name: 'Earlier messages summarized' })).toBeTruthy()
  })

  it('shows the failure label on error regardless of state', () => {
    render(<CompactionDivider state="compacted" error />)
    expect(screen.getByRole('region', { name: "Couldn't summarize earlier messages" })).toBeTruthy()
  })

  it('shows the failure label when state is compacting but error is set', () => {
    render(<CompactionDivider state="compacting" error />)
    expect(screen.getByRole('region', { name: "Couldn't summarize earlier messages" })).toBeTruthy()
  })
})

// ---------------------------------------------------------------------------

describe('CompactionDivider — animated ellipsis', () => {
  it('says it is working with a static "…", never pulsing text', () => {
    const { container } = render(<CompactionDivider state="compacting" />)
    expect(container.querySelector('.animate-pulse')).toBeNull()
    expect(screen.getByRole('status').textContent).toBe('Summarizing earlier messages…')
  })

  it('does not render the animated "…" span once compacted', () => {
    const { container } = render(<CompactionDivider state="compacted" />)
    expect(container.querySelector('.animate-pulse')).toBeNull()
  })

  it('does not render the animated "…" on error', () => {
    const { container } = render(<CompactionDivider state="compacting" error />)
    expect(container.querySelector('.animate-pulse')).toBeNull()
  })
})

// ---------------------------------------------------------------------------

describe('CompactionDivider — collapse', () => {
  it('collapses the summary body by default', () => {
    render(<CompactionDivider state="compacted" summary="Hidden summary" />)
    expect(screen.queryByTestId('markdown')).toBeNull()
    expect(screen.getByRole('button', { name: /Earlier messages summarized/ }).getAttribute('aria-expanded')).toBe('false')
  })

  it('toggles the summary body from the label', () => {
    render(<CompactionDivider state="compacted" summary="Toggled summary" />)
    const toggle = screen.getByRole('button', { name: /Earlier messages summarized/ })
    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByText('Toggled summary')).toBeTruthy()
    expect(toggle.getAttribute('aria-controls')).toBe(screen.getByTestId('markdown').parentElement?.id ?? null)
    const timers = useFakeTimers()
    try {
      fireEvent.click(toggle)
      expect(toggle.getAttribute('aria-expanded')).toBe('false')
      act(() => timers.tick(300))
      expect(screen.queryByTestId('markdown')).toBeNull()
    } finally {
      timers.restore()
    }
  })

  it('collapses while compacting too, and can be opened to watch the stream', () => {
    render(<CompactionDivider state="compacting" summary="Streaming…" />)
    expect(screen.queryByTestId('markdown')).toBeNull()
    expand()
    expect(screen.getByText('Streaming…')).toBeTruthy()
  })

  it('stays open when compacting finishes', () => {
    const { rerender } = render(<CompactionDivider state="compacting" summary="Partial" />)
    expand()
    rerender(<CompactionDivider state="compacted" summary="Final" />)
    expect(screen.getByText('Final')).toBeTruthy()
    expect(screen.getByRole('button', { name: /Earlier messages summarized/ }).getAttribute('aria-expanded')).toBe('true')
  })

  it('has no toggle without a body', () => {
    for (const props of [{ summary: '' }, { summary: '   ' }, {}, { error: true, summary: 'x' }]) {
      const { unmount } = render(<CompactionDivider state="compacted" {...props} />)
      expect(screen.queryByRole('button')).toBeNull()
      unmount()
    }
  })

  it('pins the open divider to the top of the transcript while the summary scrolls under it', () => {
    render(<CompactionDivider state="compacted" summary="Long summary" />)
    const toggle = screen.getByRole('button', { name: /Earlier messages summarized/ })
    const header = toggle.parentElement as HTMLElement
    expect(header.className).not.toContain('sticky')

    fireEvent.click(toggle)

    expect(header.className).toContain('sticky')
  })

  it('closes from a Collapse row at the end of the summary, handing focus back to the divider', () => {
    render(<CompactionDivider state="compacted" summary="Long summary" />)
    expect(screen.queryByRole('button', { name: 'Collapse' })).toBeNull()
    const toggle = screen.getByRole('button', { name: /Earlier messages summarized/ })
    fireEvent.click(toggle)

    fireEvent.click(screen.getByRole('button', { name: 'Collapse' }))

    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(document.activeElement).toBe(toggle)
  })
})

// ---------------------------------------------------------------------------

describe('CompactionDivider — summary body', () => {
  it('renders the summary body when non-empty and state is compacted', () => {
    render(<CompactionDivider state="compacted" summary="Context was summarised here." />)
    expand()
    expect(screen.getByTestId('markdown')).toBeTruthy()
    expect(screen.getByText('Context was summarised here.')).toBeTruthy()
  })

  it('renders the summary body while compacting (streaming phase)', () => {
    render(<CompactionDivider state="compacting" summary="Partial summary so far…" />)
    expand()
    expect(screen.getByTestId('markdown')).toBeTruthy()
    expect(screen.getByText('Partial summary so far…')).toBeTruthy()
  })

  it('hides the summary body when summary is empty string', () => {
    render(<CompactionDivider state="compacted" summary="" />)
    expect(screen.queryByTestId('markdown')).toBeNull()
  })

  it('hides the summary body when summary is whitespace only', () => {
    render(<CompactionDivider state="compacted" summary="   " />)
    expect(screen.queryByTestId('markdown')).toBeNull()
  })

  it('hides the summary body when summary is undefined', () => {
    render(<CompactionDivider state="compacted" />)
    expect(screen.queryByTestId('markdown')).toBeNull()
  })

  it('hides the summary body on error even when summary is non-empty', () => {
    render(<CompactionDivider state="compacted" error summary="Should not appear" />)
    expect(screen.queryByTestId('markdown')).toBeNull()
  })

  it('trims leading/trailing whitespace from summary before rendering', () => {
    render(<CompactionDivider state="compacted" summary="  trimmed content  " />)
    expand()
    // The mock renders props.content — it must receive the trimmed value
    expect(screen.getByTestId('markdown').textContent).toBe('trimmed content')
  })
})

// ---------------------------------------------------------------------------
// Regression: isStreaming must be forwarded to MarkdownBlock so that
// the smooth-stream hook activates during the compacting phase and the
// summary content actually renders as it arrives via SSE deltas.
// ---------------------------------------------------------------------------

describe('CompactionDivider — isStreaming forwarding (regression)', () => {
  it('defaults isStreaming=true when state is compacting and isStreaming prop is omitted', () => {
    // Root cause of the original bug: no isStreaming was passed so the smooth-
    // stream hook never activated and streaming content did not render live.
    // Now CompactionDivider defaults to state === 'compacting' when the prop
    // is absent.
    lastMarkdownProps = {}
    render(<CompactionDivider state="compacting" summary="Streaming text" />)
    expand()
    expect(screen.getByTestId('markdown')).toBeTruthy()
    expect(lastMarkdownProps.isStreaming).toBe(true)
  })

  it('defaults isStreaming=false when state is compacted and isStreaming prop is omitted', () => {
    lastMarkdownProps = {}
    render(<CompactionDivider state="compacted" summary="Final summary" />)
    expand()
    expect(screen.getByTestId('markdown')).toBeTruthy()
    expect(lastMarkdownProps.isStreaming).toBe(false)
  })

  it('respects an explicit isStreaming=false override even when state is compacting', () => {
    // Cold-replay scenario: content already complete but block still shows as compacting.
    lastMarkdownProps = {}
    render(<CompactionDivider state="compacting" summary="Already done" isStreaming={false} />)
    expand()
    expect(lastMarkdownProps.isStreaming).toBe(false)
  })

  it('respects an explicit isStreaming=true override even when state is compacted', () => {
    lastMarkdownProps = {}
    render(<CompactionDivider state="compacted" summary="Still streaming" isStreaming={true} />)
    expand()
    expect(lastMarkdownProps.isStreaming).toBe(true)
  })

  it('does not render MarkdownBlock at all on error (no isStreaming concern)', () => {
    lastMarkdownProps = {}
    render(<CompactionDivider state="compacting" error summary="Irrelevant" />)
    expect(screen.queryByTestId('markdown')).toBeNull()
    // lastMarkdownProps untouched — MarkdownBlock was never called
    expect(Object.keys(lastMarkdownProps)).toHaveLength(0)
  })

  it('forwards the sessionId to MarkdownBlock', () => {
    lastMarkdownProps = {}
    render(<CompactionDivider state="compacted" summary="Some text" sessionId="sess-abc" />)
    expand()
    expect(lastMarkdownProps.sessionId).toBe('sess-abc')
  })

  it('passes untrimmed summary to MarkdownBlock during active streaming to preserve smooth typewriter animation', () => {
    lastMarkdownProps = {}
    render(<CompactionDivider state="compacting" summary="Streaming text with trailing space " isStreaming={true} />)
    expand()
    expect(lastMarkdownProps.content).toBe('Streaming text with trailing space ')
    expect(lastMarkdownProps.isStreaming).toBe(true)
  })
})
