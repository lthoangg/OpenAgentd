/**
 * Tests for ``CompactionDivider``.
 *
 * Covers:
 *  - Label text for each state (compacting / compacted / error)
 *  - Animated ellipsis present only while compacting
 *  - Summary body rendered when non-empty and state != error
 *  - Summary body hidden when empty, whitespace-only, or error
 *  - ``isStreaming`` forwarded to ``LazyMarkdownBlock`` so that streaming
 *    content actually displays during the compacting phase (regression for
 *    the bug where summarization streaming content did not show properly)
 */

import { describe, it, expect, afterEach, mock } from 'bun:test'
import { render, screen, cleanup } from '@testing-library/react'
import { CompactionDivider } from '@/components/CompactionDivider'

afterEach(cleanup)

// ---------------------------------------------------------------------------
// Mock LazyMarkdownBlock so we can:
//   1. avoid Suspense / lazy-import complexity in unit tests
//   2. assert which props are forwarded (especially isStreaming)
// ---------------------------------------------------------------------------

let lastLazyProps: Record<string, unknown> = {}

mock.module('@/utils/LazyMarkdownBlock', () => ({
  LazyMarkdownBlock: (props: Record<string, unknown>) => {
    lastLazyProps = props
    return <div data-testid="lazy-markdown">{String(props.content ?? '')}</div>
  },
}))

// ---------------------------------------------------------------------------

describe('CompactionDivider — labels', () => {
  it('shows "Session compacting" label while compacting', () => {
    render(<CompactionDivider state="compacting" />)
    expect(screen.getByRole('region', { name: 'Session compacting' })).toBeTruthy()
  })

  it('shows "Session compacted" label after completion', () => {
    render(<CompactionDivider state="compacted" />)
    expect(screen.getByRole('region', { name: 'Session compacted' })).toBeTruthy()
  })

  it('shows "Compaction failed" label on error regardless of state', () => {
    render(<CompactionDivider state="compacted" error />)
    expect(screen.getByRole('region', { name: 'Compaction failed' })).toBeTruthy()
  })

  it('shows "Compaction failed" when state is compacting but error is set', () => {
    render(<CompactionDivider state="compacting" error />)
    expect(screen.getByRole('region', { name: 'Compaction failed' })).toBeTruthy()
  })
})

// ---------------------------------------------------------------------------

describe('CompactionDivider — animated ellipsis', () => {
  it('renders the animated "…" span while compacting', () => {
    const { container } = render(<CompactionDivider state="compacting" />)
    const pulse = container.querySelector('.animate-pulse')
    expect(pulse).toBeTruthy()
    expect(pulse?.textContent).toBe('…')
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

describe('CompactionDivider — summary body', () => {
  it('renders the summary body when non-empty and state is compacted', () => {
    render(<CompactionDivider state="compacted" summary="Context was summarised here." />)
    expect(screen.getByTestId('lazy-markdown')).toBeTruthy()
    expect(screen.getByText('Context was summarised here.')).toBeTruthy()
  })

  it('renders the summary body while compacting (streaming phase)', () => {
    render(<CompactionDivider state="compacting" summary="Partial summary so far…" />)
    expect(screen.getByTestId('lazy-markdown')).toBeTruthy()
    expect(screen.getByText('Partial summary so far…')).toBeTruthy()
  })

  it('hides the summary body when summary is empty string', () => {
    render(<CompactionDivider state="compacted" summary="" />)
    expect(screen.queryByTestId('lazy-markdown')).toBeNull()
  })

  it('hides the summary body when summary is whitespace only', () => {
    render(<CompactionDivider state="compacted" summary="   " />)
    expect(screen.queryByTestId('lazy-markdown')).toBeNull()
  })

  it('hides the summary body when summary is undefined', () => {
    render(<CompactionDivider state="compacted" />)
    expect(screen.queryByTestId('lazy-markdown')).toBeNull()
  })

  it('hides the summary body on error even when summary is non-empty', () => {
    render(<CompactionDivider state="compacted" error summary="Should not appear" />)
    expect(screen.queryByTestId('lazy-markdown')).toBeNull()
  })

  it('trims leading/trailing whitespace from summary before rendering', () => {
    render(<CompactionDivider state="compacted" summary="  trimmed content  " />)
    // The mock renders props.content — it must receive the trimmed value
    expect(screen.getByTestId('lazy-markdown').textContent).toBe('trimmed content')
  })
})

// ---------------------------------------------------------------------------
// Regression: isStreaming must be forwarded to LazyMarkdownBlock so that
// the smooth-stream hook activates during the compacting phase and the
// summary content actually renders as it arrives via SSE deltas.
// ---------------------------------------------------------------------------

describe('CompactionDivider — isStreaming forwarding (regression)', () => {
  it('defaults isStreaming=true when state is compacting and isStreaming prop is omitted', () => {
    // Root cause of the original bug: no isStreaming was passed so the smooth-
    // stream hook never activated and streaming content did not render live.
    // Now CompactionDivider defaults to state === 'compacting' when the prop
    // is absent.
    lastLazyProps = {}
    render(<CompactionDivider state="compacting" summary="Streaming text" />)
    expect(screen.getByTestId('lazy-markdown')).toBeTruthy()
    expect(lastLazyProps.isStreaming).toBe(true)
  })

  it('defaults isStreaming=false when state is compacted and isStreaming prop is omitted', () => {
    lastLazyProps = {}
    render(<CompactionDivider state="compacted" summary="Final summary" />)
    expect(screen.getByTestId('lazy-markdown')).toBeTruthy()
    expect(lastLazyProps.isStreaming).toBe(false)
  })

  it('respects an explicit isStreaming=false override even when state is compacting', () => {
    // Cold-replay scenario: content already complete but block still shows as compacting.
    lastLazyProps = {}
    render(<CompactionDivider state="compacting" summary="Already done" isStreaming={false} />)
    expect(lastLazyProps.isStreaming).toBe(false)
  })

  it('respects an explicit isStreaming=true override even when state is compacted', () => {
    lastLazyProps = {}
    render(<CompactionDivider state="compacted" summary="Still streaming" isStreaming={true} />)
    expect(lastLazyProps.isStreaming).toBe(true)
  })

  it('does not render LazyMarkdownBlock at all on error (no isStreaming concern)', () => {
    lastLazyProps = {}
    render(<CompactionDivider state="compacting" error summary="Irrelevant" />)
    expect(screen.queryByTestId('lazy-markdown')).toBeNull()
    // lastLazyProps untouched — LazyMarkdownBlock was never called
    expect(Object.keys(lastLazyProps)).toHaveLength(0)
  })

  it('forwards the sessionId to LazyMarkdownBlock', () => {
    lastLazyProps = {}
    render(<CompactionDivider state="compacted" summary="Some text" sessionId="sess-abc" />)
    expect(lastLazyProps.sessionId).toBe('sess-abc')
  })
})
