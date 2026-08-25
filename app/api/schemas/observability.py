"""Response/request models for observability endpoints."""

from __future__ import annotations

from pydantic import BaseModel


class ObservabilitySummaryTotals(BaseModel):
    turns: int
    llm_calls: int
    tool_calls: int
    input_tokens: int
    output_tokens: int
    cached_tokens: int
    cache_write_tokens: int
    cache_percent: float
    estimated_cost_usd: float
    errors: int


class ObservabilitySummaryLatency(BaseModel):
    turn_p50: float
    turn_p95: float
    llm_p50: float
    llm_p95: float


class ObservabilitySummaryResponse(BaseModel):
    window_start: str
    window_end: str
    sample_ratio: float
    totals: ObservabilitySummaryTotals
    latency_ms: ObservabilitySummaryLatency
    daily_turns: list[dict]
    by_model: list[dict]
    cache_by_step: list[dict]
    by_tool: list[dict]


class TraceListItemResponse(BaseModel):
    trace_id: str
    span_id: str
    run_id: str | None = None
    session_id: str | None = None
    agent_name: str | None = None
    provider: str | None = None
    model: str | None = None
    provider_model: str | None = None
    start_ms: int
    end_ms: int
    duration_ms: float
    input_tokens: int
    output_tokens: int
    cached_tokens: int
    estimated_cost_usd: float
    tool_calls: int
    llm_calls: int
    error: bool


class TracesListResponse(BaseModel):
    traces: list[TraceListItemResponse]
    limit: int
    offset: int
    total: int
    has_next: bool


class SpanDetailResponse(BaseModel):
    span_id: str
    parent_span_id: str | None = None
    trace_id: str
    name: str
    kind: str
    start_ms: int
    end_ms: int
    duration_ms: float
    status: str
    attributes: dict


class TraceDetailResponse(BaseModel):
    trace_id: str
    spans: list[SpanDetailResponse]
