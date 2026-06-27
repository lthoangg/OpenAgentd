import { describe, expect, it, mock } from 'bun:test'
import { fireEvent, render, screen } from '@testing-library/react'
import type { SpanDetail } from '@/api/client'
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
})
