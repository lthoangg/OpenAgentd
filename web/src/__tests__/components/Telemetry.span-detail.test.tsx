import { afterEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'

afterEach(cleanup)

mock.module('lucide-react', () => new Proxy({}, { get: () => () => null }))

import { SpanDetailPanel, groupAttributes } from '@/components/Telemetry/SpanDetailPanel'
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
  it('renders estimated model-call cost as a "Spend (est.)" row, not a card', () => {
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

    const label = screen.getByText('Spend (est.)')
    expect(label.closest('dt')).toBeTruthy()
    expect(screen.getByText('$0.00135')).toBeTruthy()
    expect(screen.queryByText('Estimated cost')).toBeNull()
    expect(screen.queryByText('Based on registry pricing and provider usage tokens.')).toBeNull()
  })

  it('omits the spend row when cost is absent', () => {
    render(
      <SpanDetailPanel
        span={span({ 'gen_ai.usage.input_tokens': 1000 })}
        onClose={() => {}}
      />,
    )

    expect(screen.queryByText('Spend (est.)')).toBeNull()
  })

  it('shows how fast a model call started and streamed', () => {
    render(
      <SpanDetailPanel
        span={span({
          'gen_ai.response.time_to_first_chunk': 0.8234,
          'openagentd.response.output_tokens_per_second': 61.7,
        })}
        onClose={() => {}}
      />,
    )

    expect(screen.getByText('First token (TTFT)')).toBeTruthy()
    expect(screen.queryByText('First token')).toBeNull()
    expect(screen.getByText('823 ms')).toBeTruthy()
    expect(screen.getByText('Output speed')).toBeTruthy()
    expect(screen.getByText('62 tok/s')).toBeTruthy()
  })

  it('omits speed rows for spans without them', () => {
    render(<SpanDetailPanel span={span({ 'gen_ai.usage.input_tokens': 1000 })} onClose={() => {}} />)
    expect(screen.queryByText('First token (TTFT)')).toBeNull()
    expect(screen.queryByText('Output speed')).toBeNull()
  })

  it('lists only attributes the span set', () => {
    render(
      <SpanDetailPanel
        span={span({ 'gen_ai.request.model': 'gpt-test', 'gen_ai.response.model': null })}
        onClose={() => {}}
      />,
    )

    expect(screen.getByText('gen_ai.request.model')).toBeTruthy()
    expect(screen.queryByText('gen_ai.response.model')).toBeNull()
  })

  it('heads the panel with a type chip, the raw name, a status chip and a close button', () => {
    const onClose = mock(() => {})
    render(<SpanDetailPanel span={span({})} onClose={onClose} />)

    const panel = screen.getByRole('complementary', { name: 'Span detail' })
    const header = within(panel).getByRole('heading', { name: 'chat gpt-test' })
    expect(header.className).toContain('font-mono')
    const chips = Array.from(panel.querySelectorAll('[data-slot="chip"]'))
    expect(chips[0].textContent).toBe('llm')
    // The raw status string, not a translated word
    expect(chips.map((chip) => chip.textContent)).toContain('OK')
    fireEvent.click(within(panel).getByRole('button', { name: 'Close span detail' }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('shows where the span starts in the trace once the trace start is known', () => {
    const { unmount } = render(<SpanDetailPanel span={span({})} onClose={() => {}} />)
    expect(screen.queryByText('Starts at')).toBeNull()
    unmount()

    render(<SpanDetailPanel span={{ ...span({}), start_ms: 1_700_000_002_500 }} traceStartMs={1_700_000_000_000} onClose={() => {}} />)
    expect(screen.getByText('Starts at')).toBeTruthy()
    expect(screen.getByText('+2.50 s')).toBeTruthy()
    expect(screen.getByText('Duration')).toBeTruthy()
    expect(screen.getByText('Started')).toBeTruthy()
  })

  it('says why a failed span failed', () => {
    render(
      <SpanDetailPanel
        span={{ ...span({ 'error.type': 'RateLimitError' }), status: 'ERROR' }}
        onClose={() => {}}
      />,
    )
    const note = screen.getByRole('note')
    expect(note.textContent).toBe('This span failed: RateLimitError')
    expect(screen.getByText('ERROR').closest('[data-slot="chip"]')?.getAttribute('data-tone')).toBe('error')
  })

  it('lists token counts under a Tokens section with plain labels', () => {
    render(
      <SpanDetailPanel
        span={span({
          'gen_ai.usage.input_tokens': 1000,
          'gen_ai.usage.output_tokens': 100,
          'gen_ai.usage.cache_read.input_tokens': 800,
          'gen_ai.usage.cache_creation.input_tokens': 50,
          'gen_ai.usage.reasoning_tokens': 20,
          'gen_ai.usage.tool_use_tokens': 7,
        })}
        onClose={() => {}}
      />,
    )
    expect(screen.getByRole('heading', { name: 'Tokens' })).toBeTruthy()
    for (const label of ['Input', 'Output', 'From cache', 'Written to cache', 'Reasoning', 'Tool use']) {
      expect(screen.getByText(label).tagName).toBe('DT')
    }
    expect(screen.getByText('1,000')).toBeTruthy()
  })

  it('groups attributes by namespace, each row with a copy button, plus a collapsed span group', () => {
    render(
      <SpanDetailPanel
        span={span({
          'gen_ai.request.model': 'gpt-test',
          'gen_ai.usage.input_tokens': 5,
          'openagentd.step': 2,
          loose: 'x',
        })}
        onClose={() => {}}
      />,
    )

    const genAi = screen.getByRole('heading', { name: /^gen_ai\.\*/ })
    expect(genAi.textContent).toBe('gen_ai.*2')
    expect(screen.getByRole('heading', { name: /^openagentd\.\*/ }).textContent).toBe('openagentd.*1')
    expect(screen.getByRole('heading', { name: /^Other/ }).textContent).toBe('Other1')
    expect(screen.getByRole('button', { name: 'Copy gen_ai.request.model' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Copy loose' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Copy as JSON' })).toBeTruthy()
    expect(screen.getByText('Attributes').textContent).toContain('Attributes')

    // Bookkeeping sits in a collapsed group at the end
    const details = screen.getByText('Span · kind, ids').closest('details')
    expect(details).toBeTruthy()
    expect(details?.hasAttribute('open')).toBe(false)
    for (const key of ['kind', 'span_id', 'parent_span_id', 'trace_id']) {
      expect(within(details as HTMLElement).getByText(key)).toBeTruthy()
    }
    expect(within(details as HTMLElement).getByText('none (root span)')).toBeTruthy()
  })

  it('says so when the span set no attributes', () => {
    render(<SpanDetailPanel span={span({})} onClose={() => {}} />)
    expect(screen.getByText('This span set no attributes.')).toBeTruthy()
  })
})

describe('groupAttributes', () => {
  it('groups by the first key segment, known namespaces first, loose keys last, nulls dropped', () => {
    const groups = groupAttributes({
      loose: 'x',
      'zeta.b': 1,
      'tool.name': 'read',
      'gen_ai.usage.output_tokens': 3,
      'gen_ai.request.model': 'm',
      'alpha.a': true,
      'gen_ai.response.model': null,
      nested: { a: 1 },
    })

    expect(groups.map((g) => g.ns)).toEqual(['gen_ai', 'tool', 'alpha', 'zeta', ''])
    expect(groups[0].rows).toEqual([
      ['gen_ai.request.model', 'm'],
      ['gen_ai.usage.output_tokens', '3'],
    ])
    expect(groups.find((g) => g.ns === 'alpha')?.rows).toEqual([['alpha.a', 'true']])
    // Keys with no dot share one group; nested objects collapse to JSON
    expect(groups.at(-1)?.rows).toEqual([['loose', 'x'], ['nested', '{"a":1}']])
  })
})
