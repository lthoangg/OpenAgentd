import { describe, expect, it } from 'bun:test'
import { render, screen } from '@testing-library/react'
import { SpanDetailPanel } from '@/routes/telemetry/waterfall/SpanDetailPanel'
import type { SpanDetail } from '@/api/client'

function span(attributes: Record<string, unknown>): SpanDetail {
  return {
    span_id: 'span-1234567890abcdef',
    parent_span_id: null,
    trace_id: 'trace-1',
    name: 'chat gpt-test',
    kind: 'INTERNAL',
    start_ms: 1_700_000_000_000,
    end_ms: 1_700_000_001_000,
    duration_ms: 1000,
    status: 'OK',
    attributes,
  }
}

describe('SpanDetailPanel', () => {
  it('renders estimated model-call cost as a dedicated card', () => {
    render(
      <SpanDetailPanel
        span={span({
          'gen_ai.usage.input_tokens': 1000,
          'gen_ai.usage.output_tokens': 100,
          'gen_ai.usage.estimated_cost_usd': 0.00135,
        })}
        onClose={() => {}}
      />,
    )

    expect(screen.getByText('Estimated cost')).toBeTruthy()
    expect(screen.getByText('$0.00135')).toBeTruthy()
    expect(
      screen.getByText('Based on registry pricing and provider usage tokens.'),
    ).toBeTruthy()
  })

  it('omits the estimated cost card when cost is absent', () => {
    render(
      <SpanDetailPanel
        span={span({ 'gen_ai.usage.input_tokens': 1000 })}
        onClose={() => {}}
      />,
    )

    expect(screen.queryByText('Estimated cost')).toBeNull()
  })

  it('keeps close action large enough for touch before desktop compact sizing', () => {
    render(
      <SpanDetailPanel
        span={span({ 'gen_ai.usage.input_tokens': 1000 })}
        onClose={() => {}}
      />,
    )

    const closeButton = screen.getByLabelText('Close span detail')
    expect(closeButton.className).toContain('h-7')
    expect(closeButton.className).toContain('w-7')
    expect(closeButton.className).toContain('items-center')
    expect(closeButton.className).toContain('rounded-sm')
  })
})
