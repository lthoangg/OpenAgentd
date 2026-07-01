import { afterEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { SpanDetail } from '@/api/client'

afterEach(cleanup)

mock.module('lucide-react', () => new Proxy({}, { get: () => () => null }))

import { Waterfall } from '@/routes/telemetry/waterfall/Waterfall'

function span(overrides: Partial<SpanDetail> = {}): SpanDetail {
  return {
    span_id: 'span-1',
    parent_span_id: null,
    trace_id: 'trace-1',
    name: 'agent.run',
    kind: 'INTERNAL',
    start_ms: 1_700_000_000_000,
    end_ms: 1_700_000_001_000,
    duration_ms: 1000,
    status: 'OK',
    attributes: {},
    ...overrides,
  }
}

describe('Waterfall', () => {
  it('keeps span rows keyboard-focusable and touch-sized before desktop compact sizing', () => {
    render(
      <Waterfall
        spans={[span()]}
        selectedSpanId={null}
        onSelectSpan={() => {}}
      />,
    )

    const row = screen.getByRole('button', { name: /agent\.run/ })
    expect(row.className).toMatch(/min-h-(10|11)/)
    expect(row.className).toContain('md:min-h-0')
    expect(row.className).toContain('focus:bg-(--bg-key)/40')
    expect(row.className).toContain('focus-visible:ring-2')
  })

  it('selects the span when clicked', () => {
    const onSelectSpan = mock()
    render(
      <Waterfall
        spans={[span()]}
        selectedSpanId={null}
        onSelectSpan={onSelectSpan}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: /agent\.run/ }))

    expect(onSelectSpan).toHaveBeenCalledWith('span-1')
  })

  it('renders the column header strip with the shared uppercase card styling', () => {
    render(
      <Waterfall
        spans={[span()]}
        selectedSpanId={null}
        onSelectSpan={() => {}}
      />,
    )

    const spanHeader = screen.getByText('Span')
    const headerRow = spanHeader.parentElement
    expect(headerRow?.className).toContain('uppercase')
    expect(headerRow?.className).toContain('tracking-wider')
    expect(screen.getByText('Timeline')).toBeTruthy()
    expect(screen.getByText('Duration')).toBeTruthy()
  })

  it('shows the span count and total duration above the table', () => {
    render(
      <Waterfall
        spans={[span(), span({ span_id: 'span-2', name: 'chat gpt-test', duration_ms: 500 })]}
        selectedSpanId={null}
        onSelectSpan={() => {}}
      />,
    )

    expect(screen.getByText('2 spans')).toBeTruthy()
    expect(screen.getByText(/Total/)).toBeTruthy()
  })

  it('renders an empty state when the trace has no spans', () => {
    render(
      <Waterfall
        spans={[]}
        selectedSpanId={null}
        onSelectSpan={() => {}}
      />,
    )

    expect(screen.getByText('This trace contains no spans.')).toBeTruthy()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('highlights the selected span row', () => {
    render(
      <Waterfall
        spans={[span()]}
        selectedSpanId="span-1"
        onSelectSpan={() => {}}
      />,
    )

    const row = screen.getByRole('button', { name: /agent\.run/ })
    expect(row.className).toContain('bg-(--bg-key)/50')
  })
})
