/**
 * OpenAgentd API client — observability group: /observability + traces.
 */

import { apiBaseUrl } from '../base-url'

export interface ObservabilitySummary {
  window_start: string
  window_end: string
  sample_ratio: number
  totals: {
    turns: number
    llm_calls: number
    tool_calls: number
    input_tokens: number
    output_tokens: number
    cached_tokens: number
    cache_percent: number
    estimated_cost_usd: number
    errors: number
  }
  latency_ms: {
    turn_p50: number
    turn_p95: number
    llm_p50: number
    llm_p95: number
  }
  daily_turns: Array<{ day: string; turns: number; errors: number }>
  by_model: Array<{
    provider: string
    model: string
    provider_model: string
    calls: number
    input_tokens: number
    output_tokens: number
    cached_tokens: number
    cache_percent: number
    estimated_cost_usd: number
    p95_ms: number
  }>
  cache_by_step: Array<{
    step: string
    provider: string
    model: string
    provider_model: string
    calls: number
    input_tokens: number
    cached_tokens: number
    miss_tokens: number
    cache_percent: number
    estimated_cost_usd: number
  }>
  by_tool: Array<{ tool: string; calls: number; errors: number; p95_ms: number }>
}

export async function getObservabilitySummary(days: number): Promise<ObservabilitySummary> {
  const res = await fetch(`${apiBaseUrl()}/observability/summary?days=${days}`)
  if (!res.ok) throw new Error(`GET /observability/summary failed: ${res.status}`)
  return res.json()
}

// ── /observability/traces ────────────────────────────────────────────────────

/** One turn in the traces-list view — shape mirrors backend `TraceListItem`. */
export interface TraceListItem {
  trace_id: string
  span_id: string
  run_id: string | null
  session_id: string | null
  agent_name: string | null
  provider: string | null
  model: string | null
  provider_model: string | null
  start_ms: number
  end_ms: number
  duration_ms: number
  input_tokens: number
  output_tokens: number
  cached_tokens: number
  estimated_cost_usd: number
  llm_calls: number
  tool_calls: number
  error: boolean
}

export interface TracesListResponse {
  traces: TraceListItem[]
  limit: number
  offset: number
  total: number
  has_next: boolean
}

/** One span inside a trace — shape mirrors backend `SpanDetail`. */
export interface SpanDetail {
  span_id: string
  parent_span_id: string | null
  trace_id: string
  name: string
  kind: string
  start_ms: number
  end_ms: number
  duration_ms: number
  status: string
  attributes: Record<string, unknown>
}

export interface TraceDetailResponse {
  trace_id: string
  spans: SpanDetail[]
}

export async function listTraces(
  days: number,
  limit = 50,
  offset = 0,
): Promise<TracesListResponse> {
  const res = await fetch(
    `${apiBaseUrl()}/observability/traces?days=${days}&limit=${limit}&offset=${offset}`,
  )
  if (!res.ok) throw new Error(`GET /observability/traces failed: ${res.status}`)
  return res.json()
}

/**
 * Fetch every span for a given trace id.  Returns `null` when the trace
 * was not found (404 — expired by retention or typo).
 */
export async function getTraceDetail(
  traceId: string,
  days = 30,
): Promise<TraceDetailResponse | null> {
  const res = await fetch(
    `${apiBaseUrl()}/observability/traces/${encodeURIComponent(traceId)}?days=${days}`,
  )
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`GET /observability/traces/:id failed: ${res.status}`)
  return res.json()
}
