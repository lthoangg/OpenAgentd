/**
 * TelemetryView — the overlay body. Drives the real query hooks and API
 * client against MSW so filters are asserted on the requests the view makes,
 * not on hook arguments.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { setupServer } from '@/__tests__/msw'
import type { ObservabilitySummary, SpanDetail, TraceListItem } from '@/api/client'

mock.module('lucide-react', () => new Proxy({}, { get: () => () => null }))

import { TelemetryView } from '@/components/Telemetry/TelemetryView'
import { useTelemetryStore } from '@/stores/useTelemetryStore'

const API = 'http://localhost/api/observability'
const server = setupServer()
let originalFetch: typeof fetch | undefined
let summaryRequests: URLSearchParams[] = []
let traceRequests: URLSearchParams[] = []

function summaryFixture(overrides: Partial<ObservabilitySummary> = {}): ObservabilitySummary {
  return {
    window_start: '2026-05-21T00:00:00Z',
    window_end: '2026-05-27T12:00:00Z',
    sample_ratio: 1,
    totals: {
      turns: 6,
      llm_calls: 9,
      tool_calls: 14,
      input_tokens: 42_000,
      output_tokens: 3_100,
      cached_tokens: 21_000,
      cache_write_tokens: 0,
      cache_percent: 50,
      estimated_cost_usd: 0.4213,
      errors: 1,
    },
    latency_ms: { turn_p50: 8200, turn_p95: 31_000, llm_p50: 2100, llm_p95: 6400, ttft_p50: 850, ttft_p95: 3200 },
    output_tps: { p50: 62.4, p5: 21 },
    daily_turns: [
      { day: '2026-05-22', turns: 2, errors: 0, estimated_cost_usd: 0.12 },
      { day: '2026-05-26', turns: 4, errors: 1, estimated_cost_usd: 0.3013 },
    ],
    by_model: [
      { provider: 'openai', model: 'gpt-5', provider_model: 'openai:gpt-5', calls: 7, input_tokens: 40_000, output_tokens: 3000, cached_tokens: 20_000, cache_write_tokens: 0, cache_percent: 50, estimated_cost_usd: 0.4, p95_ms: 6000, ttft_p50_ms: 1400, output_tps_p50: 48 },
      { provider: 'openai', model: 'gpt-5-mini', provider_model: 'openai:gpt-5-mini', calls: 2, input_tokens: 2000, output_tokens: 100, cached_tokens: 1000, cache_write_tokens: 0, cache_percent: 50, estimated_cost_usd: 0.0213, p95_ms: 900 },
    ],
    cache_by_step: [],
    by_tool: Array.from({ length: 10 }, (_, i) => ({ tool: `tool_${i}`, calls: 20 - i, errors: i === 0 ? 2 : 0, p95_ms: 100 + i })),
    by_workspace: [
      { workspace: '/w/site', turns: 4, errors: 1, input_tokens: 30_000, output_tokens: 2000, estimated_cost_usd: 0.3 },
      { workspace: '/w/api', turns: 1, errors: 0, input_tokens: 10_000, output_tokens: 1000, estimated_cost_usd: 0.1 },
      { workspace: null, turns: 1, errors: 0, input_tokens: 2000, output_tokens: 100, estimated_cost_usd: 0.0213 },
    ],
    facets: { workspaces: ['/w/site', '/w/api'], models: ['openai:gpt-5'] },
    by_session: [
      sessionRow({ session_id: 'sess-1', title: 'Fix login redirect', workspace: '/w/site', turns: 4, errors: 1, cache_percent: 52, estimated_cost_usd: 0.3 }),
      sessionRow({ session_id: 'sess-2', title: null, deleted: true, workspace: '/w/api', turns: 2, estimated_cost_usd: 0.1213 }),
    ],
    ...overrides,
  }
}

function sessionRow(overrides: Partial<NonNullable<ObservabilitySummary['by_session']>[number]>): NonNullable<ObservabilitySummary['by_session']>[number] {
  return {
    session_id: 'sess-x',
    workspace: null,
    model: 'openai:gpt-5',
    agent_name: 'lead',
    turns: 1,
    errors: 0,
    input_tokens: 1000,
    output_tokens: 100,
    cached_tokens: 500,
    cache_percent: 50,
    estimated_cost_usd: 0.01,
    last_active_ms: Date.now() - 2 * 3_600_000,
    title: 'Untitled',
    parent_session_id: null,
    deleted: false,
    ...overrides,
  }
}

const EMPTY_TOTALS = { ...summaryFixture().totals, turns: 0, llm_calls: 0, tool_calls: 0, estimated_cost_usd: 0 }

function turn(overrides: Partial<TraceListItem> = {}): TraceListItem {
  return {
    trace_id: 'trace-1',
    span_id: 'span-1',
    run_id: 'run-1',
    session_id: 'sess-1',
    agent_name: 'lead',
    workspace: '/w/site',
    provider: 'openai',
    model: 'gpt-5',
    provider_model: 'openai:gpt-5',
    start_ms: Date.now() - 60_000,
    end_ms: Date.now() - 50_000,
    duration_ms: 10_000,
    input_tokens: 12_000,
    output_tokens: 800,
    cached_tokens: 6000,
    estimated_cost_usd: 0.08,
    llm_calls: 2,
    tool_calls: 3,
    error: false,
    ...overrides,
  }
}

const TRACE_SPANS: SpanDetail[] = [
  {
    span_id: 'run',
    parent_span_id: null,
    trace_id: 'trace-1',
    name: 'agent_run lead',
    kind: 'INTERNAL',
    start_ms: 1_700_000_000_000,
    end_ms: 1_700_000_010_000,
    duration_ms: 10_000,
    status: 'OK',
    attributes: {
      'gen_ai.agent.name': 'lead',
      'gen_ai.provider.name': 'openai',
      'gen_ai.request.model': 'gpt-5',
      'gen_ai.conversation.id': 'sess-1',
      'openagentd.workspace': '/w/site',
    },
  },
  {
    span_id: 'chat-1',
    parent_span_id: 'run',
    trace_id: 'trace-1',
    name: 'chat gpt-5',
    kind: 'CLIENT',
    start_ms: 1_700_000_000_100,
    end_ms: 1_700_000_004_000,
    duration_ms: 3900,
    status: 'OK',
    attributes: { 'gen_ai.usage.input_tokens': 12_000, 'gen_ai.usage.output_tokens': 800, 'gen_ai.usage.estimated_cost_usd': 0.08 },
  },
]

function useHandlers({
  summary = () => summaryFixture(),
  turns = [turn(), turn({ trace_id: 'trace-2', span_id: 'span-2', error: true, workspace: '/w/api' })],
  trace = TRACE_SPANS as SpanDetail[] | null,
}: {
  summary?: (params: URLSearchParams) => ObservabilitySummary
  turns?: TraceListItem[]
  trace?: SpanDetail[] | null
} = {}) {
  server.use(
    http.get(`${API}/summary`, ({ request }) => {
      const params = new URL(request.url).searchParams
      summaryRequests.push(params)
      return HttpResponse.json(summary(params))
    }),
    http.get(`${API}/traces`, ({ request }) => {
      const params = new URL(request.url).searchParams
      traceRequests.push(params)
      return HttpResponse.json({ traces: turns, limit: 25, offset: 0, total: turns.length, has_next: false })
    }),
    http.get(`${API}/traces/:id`, ({ params }) =>
      trace ? HttpResponse.json({ trace_id: params.id, spans: trace }) : new HttpResponse(null, { status: 404 }),
    ),
  )
}

function renderView(props: Parameters<typeof TelemetryView>[0] = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <TelemetryView {...props} />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  server.listen({ onUnhandledFrame: 'error' })
  originalFetch = globalThis.fetch
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    if (typeof input === 'string' && input.startsWith('/')) {
      return originalFetch?.(`http://localhost${input}`, init) ?? Promise.reject(new Error('fetch unavailable'))
    }
    return originalFetch?.(input, init) ?? Promise.reject(new Error('fetch unavailable'))
  }) as typeof fetch
  summaryRequests = []
  traceRequests = []
  useTelemetryStore.setState({ days: 7, workspace: null, model: null, session: null, errorsOnly: false, traceId: null })
})

afterEach(() => {
  cleanup()
  server.resetHandlers()
  if (originalFetch) globalThis.fetch = originalFetch
  originalFetch = undefined
  server.close()
  localStorage.removeItem('oa.telemetry.v1')
})

describe('TelemetryView overview', () => {
  it('shows spend, the breakdowns, and recent turns', async () => {
    useHandlers()
    renderView()

    const overview = await screen.findByLabelText('Overview')
    expect(within(overview).getByText('$0.42')).toBeTruthy()
    expect(within(overview).getByText('1 failed')).toBeTruthy()
    expect(screen.getByText('Activity')).toBeTruthy()
    expect(screen.getByText('Workspaces')).toBeTruthy()
    expect(screen.getByText('Not recorded')).toBeTruthy()
    expect(screen.getByText('Workspace unknown: older telemetry from a deleted session, or work outside a session')).toBeTruthy()
    expect(screen.getByText('Models')).toBeTruthy()
    expect(await screen.findAllByRole('button', { name: /^Open turn from/ })).toHaveLength(2)
    expect(screen.getByRole('button', { name: /failed$/ })).toBeTruthy()
  })

  it('shows time to first token and output speed, overall and per model', async () => {
    useHandlers()
    renderView()

    const overview = await screen.findByLabelText('Overview')
    expect(within(overview).getByText('First token')).toBeTruthy()
    expect(within(overview).getByText('850 ms')).toBeTruthy()
    expect(within(overview).getByText('p95 3.2 s')).toBeTruthy()
    expect(within(overview).getByText('Output speed')).toBeTruthy()
    expect(within(overview).getByText('62 tok/s')).toBeTruthy()
    expect(within(overview).getByText('5% under 21 tok/s')).toBeTruthy()

    const gpt = screen.getByRole('button', { name: /show only turns on this model/ })
    const mini = screen.getByText('gpt-5-mini').closest('div') as HTMLElement
    expect(within(gpt).getByText('TTFT 1.4 s')).toBeTruthy()
    expect(within(gpt).getByText('48 tok/s')).toBeTruthy()
    // Not measured for this model: no empty cells.
    expect(within(mini).queryByText(/tok\/s/)).toBeNull()
  })

  it('clicking a workspace narrows every request and hides the redundant card', async () => {
    useHandlers()
    const user = userEvent.setup()
    renderView()

    const rows = await screen.findAllByRole('button', { name: /show only this workspace/ })
    // The unrecorded bucket is not a filter target.
    expect(rows).toHaveLength(2)
    await user.click(rows.find((row) => row.textContent?.includes('/w/site'))!)

    expect(useTelemetryStore.getState().workspace).toBe('/w/site')
    await waitFor(() => expect(summaryRequests.at(-1)?.get('workspace')).toBe('/w/site'))
    await waitFor(() => expect(traceRequests.at(-1)?.get('workspace')).toBe('/w/site'))
    await waitFor(() => expect(screen.queryByText('Workspaces')).toBeNull())
    expect(screen.queryByRole('columnheader', { name: 'Workspace' })).toBeNull()
  })

  it('model rows filter only when the backend can filter by that model', async () => {
    useHandlers()
    const user = userEvent.setup()
    renderView()

    const modelRows = await screen.findAllByRole('button', { name: /show only turns on this model/ })
    expect(modelRows).toHaveLength(1)
    await user.click(modelRows[0])
    await waitFor(() => expect(summaryRequests.at(-1)?.get('model')).toBe('openai:gpt-5'))
  })

  it('changing the range refetches that window; 24h drops the daily chart', async () => {
    useHandlers()
    const user = userEvent.setup()
    renderView()
    await screen.findByText('Activity')

    await user.click(screen.getByRole('radio', { name: '30d' }))
    await waitFor(() => expect(summaryRequests.at(-1)?.get('days')).toBe('30'))

    await user.click(screen.getByRole('radio', { name: '24h' }))
    await waitFor(() => expect(summaryRequests.at(-1)?.get('days')).toBe('1'))
    await waitFor(() => expect(screen.queryByText('Activity')).toBeNull())
  })

  it('"Failed only" asks the backend for failed turns', async () => {
    useHandlers()
    const user = userEvent.setup()
    renderView()

    await user.click(await screen.findByRole('switch', { name: 'Failed turns only' }))
    await waitFor(() => expect(traceRequests.at(-1)?.get('status')).toBe('error'))
    expect(summaryRequests.every((p) => !p.has('status'))).toBe(true)
  })

  it('previews eight tools and expands to all', async () => {
    useHandlers()
    const user = userEvent.setup()
    renderView()

    await screen.findByText('tool_0')
    expect(screen.queryByText('tool_9')).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Show all 10 tools' }))
    expect(screen.getByText('tool_9')).toBeTruthy()
  })

  it('hides pickers and the workspace card on backends without filters', async () => {
    useHandlers({ summary: () => summaryFixture({ facets: undefined, by_workspace: undefined }) })
    renderView()

    await screen.findByText('Models')
    expect(screen.queryByLabelText('Workspace')).toBeNull()
    expect(screen.queryByLabelText('Model')).toBeNull()
    expect(screen.queryByText('Workspaces')).toBeNull()
  })

  it('explains an empty window', async () => {
    useHandlers({ summary: () => summaryFixture({ totals: EMPTY_TOTALS, by_workspace: [], by_session: [], by_model: [], by_tool: [] }), turns: [] })
    renderView()
    expect(await screen.findByText('No telemetry yet')).toBeTruthy()
  })

  it('offers to clear filters that match nothing', async () => {
    useTelemetryStore.setState({ workspace: '/w/site' })
    useHandlers({
      summary: (params) => (params.has('workspace') ? summaryFixture({ totals: EMPTY_TOTALS }) : summaryFixture()),
      turns: [],
    })
    const user = userEvent.setup()
    renderView()

    await screen.findByText('No turns match these filters')
    const clear = screen.getAllByRole('button', { name: 'Clear filters' })
    await user.click(clear.at(-1)!)
    expect(useTelemetryStore.getState().workspace).toBeNull()
    await screen.findByText('Workspaces')
  })
})

describe('TelemetryView sessions', () => {
  it('lists sessions by spend and narrows everything to the chosen one', async () => {
    useHandlers({
      summary: (params) => (params.get('session') === 'sess-1'
        ? summaryFixture({ by_session: [sessionRow({ session_id: 'sess-1', title: 'Fix login redirect', workspace: '/w/site', turns: 4, estimated_cost_usd: 0.3 })] })
        : summaryFixture()),
    })
    const onOpenSession = mock(() => {})
    const user = userEvent.setup()
    renderView({ onOpenSession: onOpenSession as (sessionId: string) => void })

    const rows = await screen.findAllByRole('button', { name: /show only this session/ })
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringContaining('Fix login redirect'),
      expect.stringContaining('Deleted session'),
    ])
    expect(rows[0].textContent).toContain('52% cached')

    await user.click(rows[0])
    expect(useTelemetryStore.getState().session).toBe('sess-1')
    await waitFor(() => expect(summaryRequests.at(-1)?.get('session')).toBe('sess-1'))
    await waitFor(() => expect(traceRequests.at(-1)?.get('session')).toBe('sess-1'))

    // The per-session view: a heading, no workspace or session breakdowns.
    expect(await screen.findByRole('heading', { name: 'Fix login redirect' })).toBeTruthy()
    expect(screen.queryByText('Sessions')).toBeNull()
    expect(screen.queryByText('Workspaces')).toBeNull()
    expect(screen.queryByRole('columnheader', { name: 'Workspace' })).toBeNull()

    await user.click(screen.getByRole('button', { name: 'Open session' }))
    expect(onOpenSession).toHaveBeenCalledWith('sess-1')

    await user.click(screen.getByRole('button', { name: 'Remove session filter' }))
    expect(useTelemetryStore.getState().session).toBeNull()
    await screen.findByText('Sessions')
  })

  it('lists a sub-agent session under the session that started it', async () => {
    useHandlers({
      summary: () => summaryFixture({
        by_session: [
          sessionRow({ session_id: 'sess-1', title: 'Fix login redirect', estimated_cost_usd: 0.3 }),
          sessionRow({ session_id: 'sess-3', title: 'Write docs', estimated_cost_usd: 0.2 }),
          sessionRow({ session_id: 'sess-1-explorer', title: null, parent_session_id: 'sess-1', agent_name: 'explorer', estimated_cost_usd: 0.1 }),
        ],
      }),
    })
    renderView()

    const rows = await screen.findAllByRole('button', { name: /show only this session/ })
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringContaining('Fix login redirect'),
      expect.stringContaining('explorer sub-agent'),
      expect.stringContaining('Write docs'),
    ])
  })

  it('counts a session’s sub-agents in its view and says which agent ran each turn', async () => {
    useTelemetryStore.setState({ session: 'sess-1' })
    useHandlers({
      summary: () => summaryFixture({
        by_session: [
          sessionRow({ session_id: 'sess-1', title: 'Fix login redirect', estimated_cost_usd: 0.3 }),
          sessionRow({ session_id: 'sess-1-explorer', title: null, parent_session_id: 'sess-1', agent_name: 'explorer', estimated_cost_usd: 0.1 }),
        ],
      }),
      turns: [turn(), turn({ trace_id: 'trace-2', span_id: 'span-2', session_id: 'sess-1-explorer', agent_name: 'explorer' })],
    })
    const user = userEvent.setup()
    renderView()

    expect(await screen.findByRole('heading', { name: 'Fix login redirect' })).toBeTruthy()
    expect(screen.getByText('Totals include 1 sub-agent session.')).toBeTruthy()
    // The session itself is listed for comparison, not as a shortcut to itself.
    const shortcuts = screen.getAllByRole('button', { name: /show only this session/ })
    expect(shortcuts.map((row) => row.textContent)).toEqual([expect.stringContaining('explorer sub-agent')])
    expect(await screen.findByRole('columnheader', { name: 'Agent' })).toBeTruthy()
    expect(screen.getByRole('cell', { name: 'explorer' })).toBeTruthy()

    await user.click(shortcuts[0])
    expect(useTelemetryStore.getState().session).toBe('sess-1-explorer')
  })

  it('offers no way into a deleted session', async () => {
    useTelemetryStore.setState({ session: 'sess-2' })
    useHandlers({ summary: () => summaryFixture({ by_session: [sessionRow({ session_id: 'sess-2', title: null, deleted: true })] }) })
    renderView({ onOpenSession: () => {} })

    expect(await screen.findByRole('heading', { name: 'Deleted session' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Open session' })).toBeNull()
  })

  it('does not offer to open a session it has no row for (no turns in range, or already purged)', async () => {
    useTelemetryStore.setState({ session: 'sess-unknown-0001' })
    useHandlers({ summary: () => summaryFixture({ by_session: [] }) })
    renderView({ onOpenSession: () => {} })

    expect(await screen.findByRole('heading', { name: /^Session / })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Open session' })).toBeNull()
  })
})

describe('TelemetryView trace', () => {
  it('makes the daily chart one tab stop whose days are reachable with the arrow keys', async () => {
    useHandlers()
    renderView()

    const chart = await screen.findByRole('list', { name: 'Spend per day' })
    const days = within(chart).getAllByRole('listitem')
    expect(days.filter((day) => day.tabIndex === 0)).toHaveLength(1)
    const last = days[days.length - 1]
    expect(last.tabIndex).toBe(0)

    last.focus()
    fireEvent.keyDown(chart, { key: 'ArrowLeft' })
    expect(document.activeElement).toBe(days[days.length - 2])
    expect(days[days.length - 2].tabIndex).toBe(0)
    fireEvent.keyDown(chart, { key: 'Home' })
    expect(document.activeElement).toBe(days[0])
    fireEvent.keyDown(chart, { key: 'End' })
    expect(document.activeElement).toBe(last)
  })

  it('keeps recent turns as table rows, each opened by a real button in its first cell', async () => {
    useHandlers()
    renderView()

    const [open] = await screen.findAllByRole('button', { name: /^Open turn from/ })
    expect(open.tagName).toBe('BUTTON')
    expect(open.closest('td')).not.toBeNull()
    expect(document.querySelector('tr[role="button"]')).toBeNull()
  })

  it('opens a turn with its facts and a way back to the session', async () => {
    useHandlers()
    const onOpenSession = mock(() => {})
    const user = userEvent.setup()
    renderView({ onOpenSession: onOpenSession as (sessionId: string) => void })

    const [first] = await screen.findAllByRole('button', { name: /^Open turn from/ })
    await user.click(first)
    expect(useTelemetryStore.getState().traceId).toBe('trace-1')

    const facts = await screen.findByLabelText('Turn summary')
    expect(within(facts).getByText('site')).toBeTruthy()
    expect(within(facts).getByText('gpt-5')).toBeTruthy()
    expect(within(facts).getByText('Completed')).toBeTruthy()
    expect(within(facts).getByText('$0.08')).toBeTruthy()
    expect(screen.getByText('2 spans')).toBeTruthy()

    await user.click(screen.getByRole('button', { name: 'Open session' }))
    expect(onOpenSession).toHaveBeenCalledWith('sess-1')
  })

  it('says so when the trace is gone', async () => {
    useHandlers({ trace: null })
    useTelemetryStore.setState({ traceId: 'expired' })
    renderView()
    expect(await screen.findByText('Trace not found')).toBeTruthy()
  })
})
