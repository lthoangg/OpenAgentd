import { afterEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { SpanDetail } from '@/api/client'

afterEach(cleanup)

mock.module('lucide-react', () => new Proxy({}, { get: () => () => null }))

import { Waterfall, spanSummary } from '@/components/Telemetry/Waterfall'
import { categorizeSpan } from '@/utils/traceTree'

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
    expect(row.tagName).toBe('BUTTON')
    expect(row.className).toMatch(/(^| )min-h-9( |$)/)
    expect(row.className).toContain('md:min-h-7')
    expect(row.className).toContain('hover:bg-(--bg-key)/40')
    expect(row.className).toContain('focus-visible:ring-2')
    expect(row.getAttribute('aria-pressed')).toBe('false')
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

  it('renders the column header strip: Span, a time ruler of five ticks, and Duration', () => {
    render(
      <Waterfall
        spans={[span()]}
        selectedSpanId={null}
        onSelectSpan={() => {}}
      />,
    )

    const spanHeader = screen.getByText('Span')
    const headerRow = spanHeader.parentElement
    expect(headerRow?.className).toContain('grid')
    expect(screen.getByText('Duration')).toBeTruthy()
    // No "Timeline" caption any more: the ruler itself is labelled
    expect(screen.queryByText('Timeline')).toBeNull()
    const ruler = screen.getByLabelText('Time from trace start, 0 to 1.0 s')
    const ticks = Array.from(ruler.children).map((tick) => tick.textContent)
    expect(ticks).toHaveLength(5)
    expect(ticks[0]).toBe('0 s')
    expect(ticks[4]).toBe('1.0 s')
  })

  it('shows the span count and total duration above the table', () => {
    render(
      <Waterfall
        spans={[span(), span({ span_id: 'span-2', name: 'chat gpt-test', duration_ms: 500 })]}
        selectedSpanId={null}
        onSelectSpan={() => {}}
      />,
    )

    expect(screen.getByText(/^2 spans · trace duration/)).toBeTruthy()
    expect(screen.queryByText(/Total/)).toBeNull()
    const line = screen.getByText(/^2 spans · trace duration/)
    expect(line.querySelector('span')?.textContent).toBe('1.0 s')
    expect(line.querySelector('span')?.className).toContain('font-mono')
  })

  it('counts a single span in the singular', () => {
    render(<Waterfall spans={[span()]} selectedSpanId={null} onSelectSpan={() => {}} />)
    expect(screen.getByText(/^1 span · trace duration/)).toBeTruthy()
  })

  it('lists the span types present in a legend, adding an error chip only for failures', () => {
    const { unmount } = render(
      <Waterfall
        spans={[span(), span({ span_id: 'span-2', name: 'chat gpt-test', duration_ms: 500 })]}
        selectedSpanId={null}
        onSelectSpan={() => {}}
      />,
    )
    const legend = screen.getByRole('list', { name: 'Span types' })
    expect(Array.from(legend.querySelectorAll('li')).map((li) => li.textContent)).toEqual(['llm', 'span'])
    unmount()

    render(
      <Waterfall
        spans={[
          span({ name: 'agent_run lead' }),
          span({ span_id: 'span-2', name: 'execute_tool read', status: 'ERROR' }),
        ]}
        selectedSpanId={null}
        onSelectSpan={() => {}}
      />,
    )
    const withError = screen.getByRole('list', { name: 'Span types' })
    const items = Array.from(withError.querySelectorAll('li'))
    expect(items.map((li) => li.textContent)).toEqual(['agent', 'tool', 'span'])
    expect(items.at(-1)?.querySelector('[data-slot="chip"]')?.getAttribute('data-tone')).toBe('error')
  })

  it('shows a type chip, the raw name and a summary on each row', () => {
    render(
      <Waterfall
        spans={[
          span({ name: 'agent_run', attributes: { 'gen_ai.agent.name': 'lead' } }),
          span({
            span_id: 'span-2',
            parent_span_id: 'span-1',
            name: 'chat gpt-test',
            attributes: { 'gen_ai.response.model': 'openai:gpt-test', 'gen_ai.usage.output_tokens': 268 },
          }),
          span({ span_id: 'span-3', parent_span_id: 'span-1', name: 'execute_tool read', status: 'ERROR', attributes: { 'error.type': 'ENOENT' } }),
        ]}
        selectedSpanId={null}
        onSelectSpan={() => {}}
      />,
    )

    const agentRow = screen.getByRole('button', { name: /^agent_run,/ })
    expect(agentRow.querySelector('[data-slot="chip"]')?.textContent).toBe('agent')
    expect(within(agentRow).getByText('agent_run').className).toContain('font-mono')
    expect(within(agentRow).getByText('lead')).toBeTruthy()

    const llmRow = screen.getByRole('button', { name: /chat gpt-test/ })
    expect(llmRow.querySelector('[data-slot="chip"]')?.textContent).toBe('llm')
    // The model is already in the raw name (`chat gpt-test`), so only the tokens are added
    expect(within(llmRow).getByText('out 268')).toBeTruthy()

    const failedRow = screen.getByRole('button', { name: /execute_tool read/ })
    expect(failedRow.querySelector('[data-slot="chip"]')?.getAttribute('data-tone')).toBe('error')
    expect(within(failedRow).getByText('ENOENT').className).toContain('text-(--color-error)')
    expect(failedRow.getAttribute('aria-label')).toContain('error')
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
    expect(row.getAttribute('aria-pressed')).toBe('true')
    expect(row.classList.contains('bg-(--bg-key)')).toBe(true)
  })

  it('does not highlight rows that are not selected', () => {
    render(
      <Waterfall
        spans={[span(), span({ span_id: 'span-2', name: 'chat gpt-test' })]}
        selectedSpanId="span-1"
        onSelectSpan={() => {}}
      />,
    )

    const other = screen.getByRole('button', { name: /chat gpt-test/ })
    expect(other.getAttribute('aria-pressed')).toBe('false')
    expect(other.classList.contains('bg-(--bg-key)')).toBe(false)
  })
})

describe('spanSummary', () => {
  const summary = (overrides: Partial<SpanDetail>) => {
    const s = span(overrides)
    return spanSummary(s, categorizeSpan(s.name))
  }

  it('says the agent name for an agent run', () => {
    expect(summary({ name: 'agent_run', attributes: { 'gen_ai.agent.name': 'lead' } })).toBe('lead')
    expect(summary({ name: 'agent_run' })).toBeNull()
  })

  it('does not repeat what the raw span name already says', () => {
    expect(summary({ name: 'agent_run lead', attributes: { 'gen_ai.agent.name': 'lead' } })).toBeNull()
    expect(summary({ name: 'chat gpt-5', attributes: { 'gen_ai.request.model': 'openai:gpt-5', 'gen_ai.usage.output_tokens': 7 } })).toBe('out 7')
  })

  it('says the short model and output tokens for a model call', () => {
    expect(summary({ name: 'chat x', attributes: { 'gen_ai.request.model': 'openai:gpt-5', 'gen_ai.usage.output_tokens': 1234 } })).toBe('gpt-5 · out 1,234')
    // The response model wins over the requested one
    expect(summary({ name: 'chat x', attributes: { 'gen_ai.request.model': 'openai:gpt-5', 'gen_ai.response.model': 'openai:gpt-5-mini' } })).toBe('gpt-5-mini')
    expect(summary({ name: 'chat x' })).toBeNull()
  })

  it('says the verdict and model for a goal check', () => {
    expect(summary({ name: 'goal_check', attributes: { 'goal_check.met': true, 'gen_ai.request.model': 'openai:gpt-5' } })).toBe('met · gpt-5')
    expect(summary({ name: 'goal_check', attributes: { 'goal_check.met': false } })).toBe('not yet')
  })

  it('says the model for summarization and title spans', () => {
    expect(summary({ name: 'summarization', attributes: { 'gen_ai.request.model': 'openai:gpt-5' } })).toBe('gpt-5')
    expect(summary({ name: 'title_generation', attributes: { 'gen_ai.request.model': 'openai:gpt-5' } })).toBe('gpt-5')
  })

  it('says the error type for a failed span, or "failed" when it has none', () => {
    expect(summary({ name: 'chat x', status: 'ERROR', attributes: { 'error.type': 'RateLimitError' } })).toBe('RateLimitError')
    expect(summary({ name: 'execute_tool read', status: 'ERROR' })).toBe('failed')
  })

  it('has nothing to add for tool and other spans', () => {
    expect(summary({ name: 'execute_tool read' })).toBeNull()
    expect(summary({ name: 'some.random.span' })).toBeNull()
  })
})
