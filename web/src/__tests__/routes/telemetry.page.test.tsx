/**
 * Integration tests for the top-level `/telemetry` page — verifies the
 * summary/trace-detail mode switch, day-range selector, load-more wiring,
 * and loading/error/not-found states without hitting the network (queries
 * are mocked at the `@/queries` module boundary).
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import type {
  ObservabilitySummary,
  SpanDetail,
  TraceListItem,
} from '@/api/client'

afterEach(cleanup)

// Suppress lucide SVG noise in Happy DOM.
mock.module('lucide-react', () => new Proxy({}, { get: () => () => null }))

mock.module('@tanstack/react-router', () => ({
  Link: ({ children, to, ...props }: { children: ReactNode; to: string }) => (
    <a href={to} {...props}>{children}</a>
  ),
}))

mock.module('@/hooks/use-platform', () => ({
  usePlatform: () => ({ isTauri: false, os: null, isMacOverlay: false }),
  getPlatform: () => ({ isTauri: false, os: null, isMacOverlay: false }),
}))

mock.module('@/hooks/use-tauri-drag', () => ({
  useTauriDrag: () => ({}),
}))

let isMobile = false
mock.module('@/hooks/use-mobile', () => ({
  useIsMobile: () => isMobile,
}))

const summaryFixture: ObservabilitySummary = {
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
    cache_write_tokens: 0,
    cache_percent: 25,
    estimated_cost_usd: 0.0045,
    errors: 0,
  },
  latency_ms: { turn_p50: 100, turn_p95: 200, llm_p50: 50, llm_p95: 90 },
  daily_turns: [],
  by_model: [],
  cache_by_step: [],
  by_tool: [],
}

const traceFixture: TraceListItem = {
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

const spanFixture: SpanDetail = {
  span_id: 'span-1',
  parent_span_id: null,
  trace_id: traceFixture.trace_id,
  name: 'agent.run',
  kind: 'INTERNAL',
  start_ms: 1_700_000_000_000,
  end_ms: 1_700_000_001_000,
  duration_ms: 1000,
  status: 'OK',
  attributes: {},
}

// Mutable per-test state read by the mocked query hooks below.
let summaryState: {
  data: ObservabilitySummary | undefined
  isLoading: boolean
  isError: boolean
  isFetching: boolean
  error: unknown
}
let tracesState: {
  data: { pages: Array<{ traces: TraceListItem[]; total: number }> } | undefined
  isLoading: boolean
  isError: boolean
  isFetching: boolean
  error: unknown
  hasNextPage: boolean
  isFetchingNextPage: boolean
}
let traceDetailState: {
  data: { trace_id: string; spans: SpanDetail[] } | undefined
  isLoading: boolean
  isError: boolean
  isFetching: boolean
  error: unknown
}

const summaryRefetch = mock(() => {})
const traceDetailRefetch = mock(() => {})
const fetchNextPage = mock(() => {})
const daysCalls: number[] = []
const traceDetailCalls: (string | null)[] = []

mock.module('@/queries', () => ({
  useObservabilitySummaryQuery: (days: number) => {
    daysCalls.push(days)
    return { ...summaryState, refetch: summaryRefetch }
  },
  useInfiniteTracesQuery: () => ({ ...tracesState, fetchNextPage }),
  useTraceDetailQuery: (traceId: string | null) => {
    traceDetailCalls.push(traceId)
    return { ...traceDetailState, refetch: traceDetailRefetch }
  },
}))

import { TelemetryPage } from '@/routes/telemetry'

function resetState() {
  isMobile = false
  summaryState = { data: summaryFixture, isLoading: false, isError: false, isFetching: false, error: null }
  tracesState = {
    data: { pages: [{ traces: [traceFixture], total: 1 }] },
    isLoading: false,
    isError: false,
    isFetching: false,
    error: null,
    hasNextPage: false,
    isFetchingNextPage: false,
  }
  traceDetailState = {
    data: { trace_id: traceFixture.trace_id, spans: [spanFixture] },
    isLoading: false,
    isError: false,
    isFetching: false,
    error: null,
  }
  summaryRefetch.mockClear()
  traceDetailRefetch.mockClear()
  fetchNextPage.mockClear()
  daysCalls.length = 0
  traceDetailCalls.length = 0
}

beforeEach(resetState)

describe('TelemetryPage — summary route', () => {
  it('renders the summary view and traces list by default', () => {
    render(<TelemetryPage />)

    expect(screen.getByText('Telemetry')).toBeTruthy()
    expect(screen.getByText('Usage')).toBeTruthy()
    expect(screen.getByText('Recent traces')).toBeTruthy()
    expect(screen.getByText('openai:gpt-test')).toBeTruthy()
  })

  it('defaults to the 7-day window and requests summary/traces for it', () => {
    render(<TelemetryPage />)

    expect(daysCalls).toContain(7)
    expect(screen.getByRole('button', { name: '7 d' }).className).toContain('bg-(--bg-key)')
  })

  it('switches the window and re-requests data for the newly selected range', () => {
    render(<TelemetryPage />)

    fireEvent.click(screen.getByRole('button', { name: '30 d' }))

    expect(daysCalls).toContain(30)
    expect(screen.getByRole('button', { name: '30 d' }).className).toContain('border-(--color-border-strong)')
    expect(screen.getByRole('button', { name: '7 d' }).className).not.toContain('border-(--color-border-strong)')
  })

  it('shows the loading state while the summary query is in flight', () => {
    summaryState.isLoading = true
    summaryState.data = undefined
    render(<TelemetryPage />)

    expect(screen.getByText('Loading span aggregates…')).toBeTruthy()
    expect(screen.queryByText('Usage')).toBeNull()
  })

  it('shows an error state with a working retry action when the summary query fails', () => {
    summaryState.isLoading = false
    summaryState.isError = true
    summaryState.data = undefined
    summaryState.error = new Error('backend unreachable')
    render(<TelemetryPage />)

    expect(screen.getByText('Could not load observability data')).toBeTruthy()
    expect(screen.getByText('Error: backend unreachable')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(summaryRefetch).toHaveBeenCalled()
  })

  it('requests the next page of traces exactly once when scrolled near the bottom', () => {
    tracesState.hasNextPage = true
    tracesState.data = { pages: [{ traces: [traceFixture], total: 60 }] }
    render(<TelemetryPage />)

    const scroller = screen.getByText('Scroll to load 25 more').parentElement!
    Object.defineProperty(scroller, 'scrollTop', { value: 100, configurable: true })
    Object.defineProperty(scroller, 'clientHeight', { value: 100, configurable: true })
    Object.defineProperty(scroller, 'scrollHeight', { value: 250, configurable: true })
    fireEvent.scroll(scroller)

    expect(fetchNextPage).toHaveBeenCalledTimes(1)
  })

  it('does not request another page when one is already in flight', () => {
    tracesState.hasNextPage = true
    tracesState.isFetchingNextPage = true
    tracesState.isFetching = true
    tracesState.data = { pages: [{ traces: [traceFixture], total: 60 }] }
    render(<TelemetryPage />)

    const scroller = screen.getByText('Loading more traces…').parentElement!
    Object.defineProperty(scroller, 'scrollTop', { value: 100, configurable: true })
    Object.defineProperty(scroller, 'clientHeight', { value: 100, configurable: true })
    Object.defineProperty(scroller, 'scrollHeight', { value: 250, configurable: true })
    fireEvent.scroll(scroller)

    expect(fetchNextPage).not.toHaveBeenCalled()
  })

  it('navigates into the trace detail route when a trace row is opened', () => {
    render(<TelemetryPage />)

    fireEvent.click(screen.getByRole('button', { name: /Open trace/ }))

    expect(screen.getByText(/Trace /)).toBeTruthy()
    expect(screen.getByRole('button', { name: /agent\.run/ })).toBeTruthy()
    expect(screen.queryByText('Recent traces')).toBeNull()
  })
})

describe('TelemetryPage — trace detail route', () => {
  function openTraceDetail() {
    render(<TelemetryPage />)
    fireEvent.click(screen.getByRole('button', { name: /Open trace/ }))
  }

  it('shows the waterfall for the selected trace and returns to the list on back', () => {
    openTraceDetail()

    expect(screen.getByText('1 span')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Back to list' }))

    expect(screen.getByText('Recent traces')).toBeTruthy()
    expect(screen.queryByText('1 span')).toBeNull()
  })

  it('opens the span detail panel (desktop) when a span row is selected', () => {
    openTraceDetail()

    fireEvent.click(screen.getByRole('button', { name: /agent\.run/ }))

    expect(screen.getByRole('heading', { name: 'agent.run' })).toBeTruthy()
    fireEvent.click(screen.getByLabelText('Close span detail'))
    expect(screen.queryByRole('heading', { name: 'agent.run' })).toBeNull()
  })

  it('renders the span detail panel full-width on mobile viewports', () => {
    isMobile = true
    openTraceDetail()

    fireEvent.click(screen.getByRole('button', { name: /agent\.run/ }))

    const heading = screen.getByRole('heading', { name: 'agent.run' })
    const overlay = heading.closest('aside')?.parentElement
    expect(overlay?.className).toContain('absolute')
    expect(overlay?.className).toContain('inset-0')
  })

  it('shows a loading state while the trace query is in flight', () => {
    traceDetailState.isLoading = true
    traceDetailState.data = undefined
    openTraceDetail()

    expect(screen.getByText('Loading trace…')).toBeTruthy()
  })

  it('shows an error state with a working retry action when the trace query fails', () => {
    traceDetailState.isLoading = false
    traceDetailState.isError = true
    traceDetailState.data = undefined
    traceDetailState.error = new Error('trace fetch failed')
    openTraceDetail()

    expect(screen.getByText('Could not load observability data')).toBeTruthy()
    expect(screen.getByText('Error: trace fetch failed')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(traceDetailRefetch).toHaveBeenCalled()
  })

  it('shows a not-found message when the trace has expired from the retention window', () => {
    traceDetailState.isLoading = false
    traceDetailState.data = undefined
    openTraceDetail()

    expect(screen.getByText('Trace not found')).toBeTruthy()
    expect(
      screen.getByText('This trace may have expired from the retention window.'),
    ).toBeTruthy()
  })

  it('requests span detail using the selected trace id', () => {
    openTraceDetail()

    expect(traceDetailCalls).toContain(traceFixture.trace_id)
  })
})
