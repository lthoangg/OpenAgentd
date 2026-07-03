"""Observability endpoints — summary, trace list, and trace detail.

All three endpoints read OTEL span JSONL files via DuckDB (a core dependency).
"""

from __future__ import annotations

import re

from fastapi import APIRouter, HTTPException, Query, status

from app.api.schemas.observability import (
    ObservabilitySummaryResponse,
    TraceDetailResponse,
    TraceListItemResponse,
    TracesListResponse,
)
from app.services.observability_service import (
    count_traces,
    get_trace,
    list_traces,
    summarize,
)

router = APIRouter()


@router.get("/summary")
async def summary(
    days: int = Query(default=7, ge=1, le=90),
) -> ObservabilitySummaryResponse:
    """Return span-derived aggregates over the last ``days`` days."""
    return ObservabilitySummaryResponse.model_validate(summarize(days=days).to_dict())


@router.get("/traces")
async def traces(
    days: int = Query(default=7, ge=1, le=90),
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
) -> TracesListResponse:
    """Return a newest-first list of ``agent_run`` spans (one row per turn).

    Each item identifies a trace (``trace_id``) plus summary metrics; the UI
    uses ``trace_id`` to fetch the full span tree via ``GET /traces/{id}``.
    """
    items = list_traces(days=days, limit=limit, offset=offset)
    total = count_traces(days=days)
    return TracesListResponse(
        traces=[TraceListItemResponse.model_validate(t.to_dict()) for t in items],
        limit=limit,
        offset=offset,
        total=total,
        has_next=offset + limit < total,
    )


# OTel trace IDs are 128-bit hex strings, optionally prefixed with "0x".
# Reject anything that doesn't look like a hex ID before hitting DuckDB —
# the service layer uses parameterised queries so injection is already
# prevented, but a format check provides an early, explicit 422 for clearly
# malformed input.
_TRACE_ID_RE = re.compile(r"^(0x)?[0-9a-fA-F]{1,64}$")


@router.get("/traces/{trace_id}")
async def trace_detail(
    trace_id: str,
    days: int = Query(default=30, ge=1, le=90),
) -> TraceDetailResponse:
    """Return every span belonging to ``trace_id`` (start-time ordered).

    The ``days`` bound exists only to cap the JSONL scan — set it high when
    a trace is expected to be old.  Returns 404 if the trace is not found
    in the window (expired by retention or typo).
    """
    if not _TRACE_ID_RE.match(trace_id):
        raise HTTPException(
            status_code=422,
            detail="Invalid trace_id: expected a hex string.",
        )
    detail = get_trace(trace_id=trace_id, days=days)
    if detail is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"reason": "trace_not_found", "trace_id": trace_id},
        )
    return TraceDetailResponse.model_validate(detail.to_dict())
