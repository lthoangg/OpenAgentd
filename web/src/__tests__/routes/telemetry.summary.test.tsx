import { describe, expect, it, mock } from 'bun:test'
import { fireEvent, render, screen } from '@testing-library/react'
import { SummaryView } from '@/routes/telemetry/summary/SummaryView'
import { TracesSection } from '@/routes/telemetry/traces/TracesSection'
import type { ObservabilitySummary, TraceListItem } from '@/api/client'

const summary: ObservabilitySummary = {
  window_start: '2026-05-21T00:00:00Z',
  window_end: '2026-05-28T00:00:00Z',
  sample_ratio: 1,
  totals: {
    turns: 3,
    llm_calls: 4,
    tool_calls: 2,
    input_tokens: 1500,
    output_tokens: 300,
    cached_tokens: 375,
    cache_percent: 25,
    estimated_cost_usd: 0.0045,
    errors: 0,
  },
  latency_ms: {
    turn_p50: 100,
    turn_p95: 200,
    llm_p50: 50,
    llm_p95: 90,
  },
  daily_turns: [],
  by_model: [
    {
      provider: 'openai',
      model: 'gpt-test',
      provider_model: 'openai:gpt-test',
      calls: 4,
      input_tokens: 1500,
      output_tokens: 300,
      cached_tokens: 375,
      cache_percent: 25,
      estimated_cost_usd: 0.0045,
      p95_ms: 90,
    },
  ],
  cache_by_step: [
    {
      step: 'chat',
      provider: 'openai',
      model: 'gpt-test',
      provider_model: 'openai:gpt-test',
      calls: 3,
      input_tokens: 1200,
      cached_tokens: 275,
      miss_tokens: 925,
      cache_percent: 22.9,
      estimated_cost_usd: 0.004,
    },
    {
      step: 'title_generation',
      provider: 'openai',
      model: 'gpt-mini',
      provider_model: 'openai:gpt-mini',
      calls: 1,
      input_tokens: 300,
      cached_tokens: 100,
      miss_tokens: 200,
      cache_percent: 33.3,
      estimated_cost_usd: 0.0005,
    },
  ],
  by_tool: [{ tool: 'read', calls: 2, errors: 0, p95_ms: 20 }],
}

describe('SummaryView', () => {
  it('shows focused usage and provider:model metrics', () => {
    render(<SummaryView data={summary} />)

    expect(screen.getByText('Usage')).toBeTruthy()
    expect(screen.getAllByText('Provider:model').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Input').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Output').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Cache hit').length).toBeGreaterThan(0)
    expect(screen.getByText('Cache hit/miss')).toBeTruthy()
    expect(screen.getByText('Hit tokens')).toBeTruthy()
    expect(screen.getByText('Miss tokens')).toBeTruthy()
    expect(screen.getAllByText('Hit rate').length).toBeGreaterThan(0)
    expect(screen.getAllByText('25%').length).toBeGreaterThan(0)
    expect(screen.getByText('375')).toBeTruthy()
    expect(screen.getByText('1.1K')).toBeTruthy()
    expect(screen.getAllByText('$0.0045').length).toBeGreaterThan(0)
    expect(screen.getAllByText('openai:gpt-test').length).toBeGreaterThan(0)
    expect(screen.getByText('chat')).toBeTruthy()
    expect(screen.getByText('title_generation')).toBeTruthy()
    expect(screen.getByText('openai:gpt-mini')).toBeTruthy()
    expect(screen.getByText('925')).toBeTruthy()
    expect(screen.queryByText('Latency')).toBeNull()
    expect(screen.queryByText('By tool')).toBeNull()
  })
})

const trace: TraceListItem = {
  trace_id: '0x' + '1'.repeat(32),
  span_id: '0x' + 'a'.repeat(16),
  run_id: 'run-1',
  session_id: 'sess-a',
  agent_name: 'lead',
  provider: 'openai',
  model: 'gpt-test',
  provider_model: 'openai:gpt-test',
  start_ms: Date.now(),
  end_ms: Date.now() + 1000,
  duration_ms: 1000,
  input_tokens: 1000,
  output_tokens: 100,
  cached_tokens: 250,
  estimated_cost_usd: 0.001,
  llm_calls: 1,
  tool_calls: 0,
  error: false,
}

function query() {
  return {
    isLoading: false,
    isError: false,
    isFetching: false,
    error: null,
  }
}

describe('TracesSection', () => {
  it('renders a scrollable trace list and loads more near the bottom', () => {
    const onLoadMore = mock()
    render(
      <TracesSection
        query={query()}
        traces={[trace]}
        limit={25}
        total={60}
        hasNext
        onLoadMore={onLoadMore}
        onSelectTrace={() => {}}
      />,
    )

    expect(screen.getByText('Showing 1 of 60')).toBeTruthy()
    expect(screen.getByText('Scroll to load 25 more')).toBeTruthy()
    const scroller = screen.getByText('Scroll to load 25 more').parentElement
    expect(scroller).toBeTruthy()
    Object.defineProperty(scroller, 'scrollTop', { value: 100, configurable: true })
    Object.defineProperty(scroller, 'clientHeight', { value: 100, configurable: true })
    Object.defineProperty(scroller, 'scrollHeight', { value: 250, configurable: true })
    fireEvent.scroll(scroller!)
    expect(onLoadMore).toHaveBeenCalled()
  })

  it('opens a trace when the row is clicked', () => {
    const onSelectTrace = mock()
    render(
      <TracesSection
        query={query()}
        traces={[trace]}
        limit={25}
        total={1}
        hasNext={false}
        onLoadMore={() => {}}
        onSelectTrace={onSelectTrace}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: /Open trace/ }))
    expect(onSelectTrace).toHaveBeenCalledWith(trace.trace_id)
    expect(screen.getByText('openai:gpt-test')).toBeTruthy()
  })

  it('keeps trace rows keyboard-focusable and touch-sized before desktop compact sizing', () => {
    render(
      <TracesSection
        query={query()}
        traces={[trace]}
        limit={25}
        total={1}
        hasNext={false}
        onLoadMore={() => {}}
        onSelectTrace={() => {}}
      />,
    )

    const row = screen.getByRole('button', { name: /Open trace/ })
    expect(row.className).toContain('focus-visible:ring-2')
    expect(row.className).toContain('focus:bg-(--bg-key)/40')
    const affordance = row.querySelector('td:last-child span')
    expect(affordance?.className).toContain('h-7')
    expect(affordance?.className).toContain('w-7')
    expect(affordance?.className).toContain('md:h-6')
    expect(affordance?.className).toContain('md:w-6')
  })
})
