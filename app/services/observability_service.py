"""Aggregate OTEL span JSONL files into a UI-friendly summary.

Reads span files written by :mod:`app.core.otel` (hourly partitions under
``{STATE_DIR}/otel/spans/YYYY-MM-DD-HH.jsonl``) via DuckDB, which loads
JSONL with ``read_json`` in a single query.

Design
------
- No state; every call re-queries the files.  File count is small (24 / day ×
  retention), query is fast (< 50 ms on a week of data).
- Sampling-aware: if ``OTEL_SPAN_SAMPLE_RATIO < 1.0``, the endpoint attaches
  ``sample_ratio`` to the payload so the UI can render a banner.  Turn counts
  are **not** scaled up — callers must decide whether to multiply.
- Only ``agent_run`` spans count as a "turn"; ``chat``/``execute_tool`` spans
  count as LLM / tool calls respectively.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path

import duckdb
from loguru import logger


@dataclass(frozen=True)
class TraceListItem:
    """One row in the traces-list view — a single ``agent_run`` (turn).

    Identifies the turn (trace_id, run_id, session_id, agent), its timing,
    token usage, and a best-effort ``error`` flag (True when the span's OTel
    status is ``ERROR``).  The UI uses this shape to render a scrollable list.
    """

    trace_id: str
    span_id: str
    run_id: str | None
    session_id: str | None
    agent_name: str | None
    provider: str | None
    model: str | None
    provider_model: str | None
    start_ms: int  # UNIX epoch ms (so JS ``new Date(...)`` works directly)
    end_ms: int
    duration_ms: float
    input_tokens: int
    output_tokens: int
    cached_tokens: int
    estimated_cost_usd: float
    tool_calls: int  # number of execute_tool spans in this trace
    llm_calls: int  # number of chat spans in this trace
    error: bool

    def to_dict(self) -> dict:
        return {
            "trace_id": self.trace_id,
            "span_id": self.span_id,
            "run_id": self.run_id,
            "session_id": self.session_id,
            "agent_name": self.agent_name,
            "provider": self.provider,
            "model": self.model,
            "provider_model": self.provider_model,
            "start_ms": self.start_ms,
            "end_ms": self.end_ms,
            "duration_ms": self.duration_ms,
            "input_tokens": self.input_tokens,
            "output_tokens": self.output_tokens,
            "cached_tokens": self.cached_tokens,
            "estimated_cost_usd": self.estimated_cost_usd,
            "tool_calls": self.tool_calls,
            "llm_calls": self.llm_calls,
            "error": self.error,
        }


@dataclass(frozen=True)
class SpanDetail:
    """One span inside a trace — full attribute payload included.

    The waterfall view uses ``start_ms``/``end_ms`` for positioning.  The
    span-detail side panel renders every key of ``attributes`` as a
    key/value row (no filtering — operators need to see everything).
    """

    span_id: str
    parent_span_id: str | None
    trace_id: str
    name: str
    kind: str  # "INTERNAL" | "CLIENT" | ...
    start_ms: int
    end_ms: int
    duration_ms: float
    status: str  # "OK" | "ERROR" | "UNSET"
    attributes: dict

    def to_dict(self) -> dict:
        return {
            "span_id": self.span_id,
            "parent_span_id": self.parent_span_id,
            "trace_id": self.trace_id,
            "name": self.name,
            "kind": self.kind,
            "start_ms": self.start_ms,
            "end_ms": self.end_ms,
            "duration_ms": self.duration_ms,
            "status": self.status,
            "attributes": self.attributes,
        }


@dataclass(frozen=True)
class TraceDetail:
    """All spans in a single trace, ordered by ``start_ms`` ascending."""

    trace_id: str
    spans: list[SpanDetail]

    def to_dict(self) -> dict:
        return {
            "trace_id": self.trace_id,
            "spans": [s.to_dict() for s in self.spans],
        }


@dataclass(frozen=True)
class ObservabilitySummary:
    """Serialisable aggregate for the observability page."""

    window_start: datetime
    window_end: datetime
    sample_ratio: float

    # Totals
    total_turns: int
    total_llm_calls: int
    total_tool_calls: int
    total_input_tokens: int
    total_output_tokens: int
    total_cached_tokens: int
    total_estimated_cost_usd: float
    total_errors: int

    # Latency (ms)
    turn_p50_ms: float
    turn_p95_ms: float
    llm_p50_ms: float
    llm_p95_ms: float

    # Per-day buckets
    daily_turns: list[dict]  # [{"day": "2026-04-17", "turns": 12, "errors": 1}, ...]

    # Per-model + per-tool breakdowns
    by_model: list[dict]  # [{"model": "gpt-4o", "calls": 40, "input_tokens": …}]
    cache_by_step: list[dict]
    by_tool: list[dict]  # [{"tool": "read", "calls": 12, "errors": 0}]

    def to_dict(self) -> dict:
        return {
            "window_start": self.window_start.isoformat(),
            "window_end": self.window_end.isoformat(),
            "sample_ratio": self.sample_ratio,
            "totals": {
                "turns": self.total_turns,
                "llm_calls": self.total_llm_calls,
                "tool_calls": self.total_tool_calls,
                "input_tokens": self.total_input_tokens,
                "output_tokens": self.total_output_tokens,
                "cached_tokens": self.total_cached_tokens,
                "cache_percent": _percent(
                    self.total_cached_tokens, self.total_input_tokens
                ),
                "estimated_cost_usd": self.total_estimated_cost_usd,
                "errors": self.total_errors,
            },
            "latency_ms": {
                "turn_p50": self.turn_p50_ms,
                "turn_p95": self.turn_p95_ms,
                "llm_p50": self.llm_p50_ms,
                "llm_p95": self.llm_p95_ms,
            },
            "daily_turns": self.daily_turns,
            "by_model": self.by_model,
            "cache_by_step": self.cache_by_step,
            "by_tool": self.by_tool,
        }


# ── Helpers ───────────────────────────────────────────────────────────────────


def _spans_dir() -> Path:
    from app.core.config import settings

    return Path(settings.OPENAGENTD_STATE_DIR) / "otel" / "spans"


def _sample_ratio() -> float:
    """Mirror of :func:`app.core.otel._sample_ratio` — kept local to avoid
    importing the OTel SDK from this module's transitive graph at import time.
    """
    raw = os.getenv("OTEL_SPAN_SAMPLE_RATIO", "1.0")
    try:
        v = float(raw)
    except ValueError:
        return 1.0
    return max(0.0, min(1.0, v))


def _empty_summary(
    window_start: datetime, window_end: datetime
) -> ObservabilitySummary:
    return ObservabilitySummary(
        window_start=window_start,
        window_end=window_end,
        sample_ratio=_sample_ratio(),
        total_turns=0,
        total_llm_calls=0,
        total_tool_calls=0,
        total_input_tokens=0,
        total_output_tokens=0,
        total_cached_tokens=0,
        total_estimated_cost_usd=0.0,
        total_errors=0,
        turn_p50_ms=0.0,
        turn_p95_ms=0.0,
        llm_p50_ms=0.0,
        llm_p95_ms=0.0,
        daily_turns=[],
        by_model=[],
        cache_by_step=[],
        by_tool=[],
    )


def _candidate_files(window_start: datetime) -> list[Path]:
    """Return sorted JSONL files that *might* contain spans inside the window.

    File names are ``YYYY-MM-DD-HH.jsonl`` — a lexicographic stem compare
    against the window-start key is sufficient pre-filtering; DuckDB still
    filters by ``end_time`` to drop any older rows inside a straddling file.
    """
    spans_dir = _spans_dir()
    if not spans_dir.is_dir():
        logger.debug("observability_spans_dir_missing path={}", spans_dir)
        return []
    cutoff_key = window_start.strftime("%Y-%m-%d-%H")
    return sorted(p for p in spans_dir.glob("*.jsonl") if p.stem >= cutoff_key)


def _percent(part: int | float, total: int | float) -> float:
    if total <= 0:
        return 0.0
    return round(float(part) / float(total) * 100, 1)


def _create_spans_window_view(
    con,  # noqa: ANN001 — duckdb.DuckDBPyConnection
    files: list[Path],
    window_start: datetime,
    window_end: datetime,
) -> None:
    """Create ``spans`` and ``spans_window`` temp views over ``files``.

    Shared by all query entry points.  ``spans_window`` is filtered to
    ``end_time BETWEEN window_start AND window_end`` (nanosecond epoch).
    """
    escaped = ", ".join("'" + str(f).replace("'", "''") + "'" for f in files)
    con.execute(
        f"CREATE TEMP VIEW spans AS "
        f"SELECT * FROM read_json([{escaped}], union_by_name=true)"
    )
    start_ns = int(window_start.timestamp() * 1_000_000_000)
    end_ns = int(window_end.timestamp() * 1_000_000_000)
    con.execute(
        f"""
        CREATE TEMP VIEW spans_window AS
        SELECT * FROM spans
        WHERE end_time IS NOT NULL
          AND end_time BETWEEN {start_ns} AND {end_ns}
        """
    )


# ── Main entry point ──────────────────────────────────────────────────────────


def summarize(days: int = 7) -> ObservabilitySummary:
    """Aggregate span JSONL files over the last ``days`` days.

    Args:
        days: Look-back window in days (1–90).
    """
    days = max(1, min(90, days))
    now = datetime.now(timezone.utc)
    window_start = now - timedelta(days=days)

    files = _candidate_files(window_start)
    if not files:
        return _empty_summary(window_start, now)

    con = duckdb.connect(":memory:")
    try:
        _create_spans_window_view(con, files, window_start, now)
        return _run_queries(con, window_start, now)
    finally:
        con.close()


# ── DuckDB queries ────────────────────────────────────────────────────────────


def _run_queries(
    con,  # noqa: ANN001 — duckdb.DuckDBPyConnection
    window_start: datetime,
    window_end: datetime,
) -> ObservabilitySummary:
    # ── Totals + latencies ───────────────────────────────────────────────
    totals_row = con.execute(
        """
        SELECT
            count_if(name LIKE 'agent_run%') AS turns,
            count_if(name LIKE 'chat%')      AS llm_calls,
            count_if(name LIKE 'execute_tool%') AS tool_calls,
            count_if(status = 'ERROR')       AS errors,
            coalesce(sum(CASE WHEN name NOT LIKE 'agent_run%' THEN try_cast(attributes['gen_ai.usage.input_tokens'] AS BIGINT) END), 0)  AS input_tokens,
            coalesce(sum(CASE WHEN name NOT LIKE 'agent_run%' THEN try_cast(attributes['gen_ai.usage.output_tokens'] AS BIGINT) END), 0) AS output_tokens,
            coalesce(sum(CASE WHEN name NOT LIKE 'agent_run%' THEN try_cast(attributes['gen_ai.usage.cache_read.input_tokens'] AS BIGINT) END), 0) AS cached_tokens,
            coalesce(sum(CASE WHEN name NOT LIKE 'agent_run%' THEN try_cast(attributes['gen_ai.usage.estimated_cost_usd'] AS DOUBLE) END), 0.0) AS estimated_cost_usd,
            coalesce(quantile_cont(CASE WHEN name LIKE 'agent_run%' THEN duration_ms END, 0.5), 0.0) AS turn_p50,
            coalesce(quantile_cont(CASE WHEN name LIKE 'agent_run%' THEN duration_ms END, 0.95), 0.0) AS turn_p95,
            coalesce(quantile_cont(CASE WHEN name LIKE 'chat%'      THEN duration_ms END, 0.5), 0.0) AS llm_p50,
            coalesce(quantile_cont(CASE WHEN name LIKE 'chat%'      THEN duration_ms END, 0.95), 0.0) AS llm_p95
        FROM spans_window
        """
    ).fetchone()

    if totals_row is None:
        return _empty_summary(window_start, window_end)

    (
        turns,
        llm_calls,
        tool_calls,
        errors,
        in_tokens,
        out_tokens,
        cached_tokens,
        estimated_cost_usd,
        turn_p50,
        turn_p95,
        llm_p50,
        llm_p95,
    ) = totals_row

    # ── Daily turns ──────────────────────────────────────────────────────
    daily_rows = con.execute(
        """
        SELECT
            strftime(make_timestamp(end_time // 1000), '%Y-%m-%d') AS day,
            count(*) AS turns,
            count_if(status = 'ERROR') AS errors
        FROM spans_window
        WHERE name LIKE 'agent_run%'
        GROUP BY day
        ORDER BY day
        """
    ).fetchall()
    daily_turns = [
        {"day": day, "turns": int(turns), "errors": int(errs)}
        for day, turns, errs in daily_rows
    ]

    # ── By model (on chat spans) ─────────────────────────────────────────
    model_rows = con.execute(
        """
        SELECT
            coalesce(attributes['gen_ai.provider.name'], 'unknown') AS provider,
            coalesce(attributes['gen_ai.request.model'], 'unknown') AS model,
            count(*) AS calls,
            coalesce(sum(try_cast(attributes['gen_ai.usage.input_tokens']  AS BIGINT)), 0) AS input_tokens,
            coalesce(sum(try_cast(attributes['gen_ai.usage.output_tokens'] AS BIGINT)), 0) AS output_tokens,
            coalesce(sum(try_cast(attributes['gen_ai.usage.cache_read.input_tokens'] AS BIGINT)), 0) AS cached_tokens,
            coalesce(sum(try_cast(attributes['gen_ai.usage.estimated_cost_usd'] AS DOUBLE)), 0.0) AS estimated_cost_usd,
            coalesce(quantile_cont(duration_ms, 0.95), 0.0) AS p95_ms
        FROM spans_window
        WHERE name NOT LIKE 'agent_run%'
          AND (
            attributes['gen_ai.usage.input_tokens'] IS NOT NULL
            OR attributes['gen_ai.usage.output_tokens'] IS NOT NULL
          )
        GROUP BY provider, model
        ORDER BY estimated_cost_usd DESC, calls DESC
        """
    ).fetchall()
    by_model = [
        {
            "provider": provider,
            "model": m,
            "provider_model": f"{provider}:{m}",
            "calls": int(c),
            "input_tokens": int(it),
            "output_tokens": int(ot),
            "cached_tokens": int(ct),
            "cache_percent": _percent(int(ct), int(it)),
            "estimated_cost_usd": round(float(cost), 8),
            "p95_ms": round(float(p95), 1),
        }
        for provider, m, c, it, ot, ct, cost, p95 in model_rows
    ]

    cache_step_rows = con.execute(
        """
        SELECT
            coalesce(
              attributes['gen_ai.operation.name'],
              CASE
                WHEN name LIKE 'summarization%' THEN 'summarization'
                WHEN name LIKE 'title_generation%' THEN 'title_generation'
                WHEN name LIKE 'chat%' THEN 'chat'
                ELSE name
              END
            ) AS step,
            coalesce(attributes['gen_ai.provider.name'], 'unknown') AS provider,
            coalesce(attributes['gen_ai.request.model'], 'unknown') AS model,
            count(*) AS calls,
            coalesce(sum(try_cast(attributes['gen_ai.usage.input_tokens'] AS BIGINT)), 0) AS input_tokens,
            coalesce(sum(try_cast(attributes['gen_ai.usage.cache_read.input_tokens'] AS BIGINT)), 0) AS cached_tokens,
            coalesce(sum(try_cast(attributes['gen_ai.usage.estimated_cost_usd'] AS DOUBLE)), 0.0) AS estimated_cost_usd
        FROM spans_window
        WHERE name NOT LIKE 'agent_run%'
          AND (
            attributes['gen_ai.usage.input_tokens'] IS NOT NULL
            OR attributes['gen_ai.usage.cache_read.input_tokens'] IS NOT NULL
          )
        GROUP BY step, provider, model
        ORDER BY estimated_cost_usd DESC, input_tokens DESC
        """
    ).fetchall()
    cache_by_step = [
        {
            "step": step,
            "provider": provider,
            "model": model,
            "provider_model": f"{provider}:{model}",
            "calls": int(calls),
            "input_tokens": int(input_tokens),
            "cached_tokens": int(cached_tokens),
            "miss_tokens": max(int(input_tokens) - int(cached_tokens), 0),
            "cache_percent": _percent(int(cached_tokens), int(input_tokens)),
            "estimated_cost_usd": round(float(cost), 8),
        }
        for step, provider, model, calls, input_tokens, cached_tokens, cost in cache_step_rows
    ]

    # ── By tool ──────────────────────────────────────────────────────────
    tool_rows = con.execute(
        """
        SELECT
            coalesce(attributes['gen_ai.tool.name'], 'unknown') AS tool,
            count(*) AS calls,
            count_if(status = 'ERROR') AS errors,
            coalesce(quantile_cont(duration_ms, 0.95), 0.0) AS p95_ms
        FROM spans_window
        WHERE name LIKE 'execute_tool%'
        GROUP BY tool
        ORDER BY calls DESC
        """
    ).fetchall()
    by_tool = [
        {
            "tool": t,
            "calls": int(c),
            "errors": int(e),
            "p95_ms": round(float(p95), 1),
        }
        for t, c, e, p95 in tool_rows
    ]

    return ObservabilitySummary(
        window_start=window_start,
        window_end=window_end,
        sample_ratio=_sample_ratio(),
        total_turns=int(turns),
        total_llm_calls=int(llm_calls),
        total_tool_calls=int(tool_calls),
        total_input_tokens=int(in_tokens),
        total_output_tokens=int(out_tokens),
        total_cached_tokens=int(cached_tokens),
        total_estimated_cost_usd=round(float(estimated_cost_usd), 8),
        total_errors=int(errors),
        turn_p50_ms=round(float(turn_p50), 1),
        turn_p95_ms=round(float(turn_p95), 1),
        llm_p50_ms=round(float(llm_p50), 1),
        llm_p95_ms=round(float(llm_p95), 1),
        daily_turns=daily_turns,
        by_model=by_model,
        cache_by_step=cache_by_step,
        by_tool=by_tool,
    )


# ── Trace list + detail ───────────────────────────────────────────────────────


def list_traces_with_count(
    days: int = 7,
    limit: int = 50,
    offset: int = 0,
) -> tuple[list[TraceListItem], int]:
    """Return ``agent_run`` spans (one per turn) in the window.

    Each row is a user-facing "turn" — ordered newest-first by ``end_time``.
    Child counts (``llm_calls``, ``tool_calls``) come from a self-join on
    ``trace_id``; this means team turns (where multiple ``agent_run`` spans
    share a trace) will see the *same* global counts for every row of that
    trace.  That's intentional — the UI treats each ``agent_run`` as a row
    that drills into the full trace.

    Args:
        days: Look-back window in days (1–90).
        limit: Max rows (1–200).
        offset: Skip this many rows for pagination.
    """
    days = max(1, min(90, days))
    limit = max(1, min(200, limit))
    offset = max(0, offset)
    now = datetime.now(timezone.utc)
    window_start = now - timedelta(days=days)

    files = _candidate_files(window_start)
    if not files:
        return [], 0

    con = duckdb.connect(":memory:")
    try:
        _create_spans_window_view(con, files, window_start, now)
        rows = con.execute(
            """
            WITH
              runs AS (
                SELECT *
                FROM spans_window
                WHERE name LIKE 'agent_run%'
              ),
              counts AS (
                SELECT
                  trace_id,
                  count_if(name LIKE 'chat%')         AS llm_calls,
                  count_if(name LIKE 'execute_tool%') AS tool_calls,
                  coalesce(sum(CASE WHEN name NOT LIKE 'agent_run%' THEN try_cast(attributes['gen_ai.usage.input_tokens'] AS BIGINT) END), 0) AS input_tokens,
                  coalesce(sum(CASE WHEN name NOT LIKE 'agent_run%' THEN try_cast(attributes['gen_ai.usage.output_tokens'] AS BIGINT) END), 0) AS output_tokens,
                  coalesce(sum(CASE WHEN name NOT LIKE 'agent_run%' THEN try_cast(attributes['gen_ai.usage.cache_read.input_tokens'] AS BIGINT) END), 0) AS cached_tokens,
                  coalesce(sum(CASE WHEN name NOT LIKE 'agent_run%' THEN try_cast(attributes['gen_ai.usage.estimated_cost_usd'] AS DOUBLE) END), 0.0) AS estimated_cost_usd
                FROM spans_window
                GROUP BY trace_id
              )
            SELECT
              runs.trace_id,
              runs.span_id,
              runs.attributes['run_id']                  AS run_id,
              runs.attributes['gen_ai.conversation.id']  AS session_id,
              runs.attributes['gen_ai.agent.name']       AS agent_name,
              runs.attributes['gen_ai.provider.name']    AS provider,
              runs.attributes['gen_ai.request.model']    AS model,
              runs.start_time // 1000000                 AS start_ms,
              runs.end_time   // 1000000                 AS end_ms,
              runs.duration_ms                           AS duration_ms,
              coalesce(counts.input_tokens, 0) AS in_tok,
              coalesce(counts.output_tokens, 0) AS out_tok,
              coalesce(counts.cached_tokens, 0) AS cached_tokens,
              coalesce(counts.estimated_cost_usd, 0.0) AS estimated_cost_usd,
              coalesce(counts.llm_calls,  0) AS llm_calls,
              coalesce(counts.tool_calls, 0) AS tool_calls,
              (runs.status = 'ERROR')        AS error,
              count(*) OVER ()               AS total
            FROM runs LEFT JOIN counts USING (trace_id)
            ORDER BY runs.end_time DESC
            LIMIT ? OFFSET ?
            """,
            [limit, offset],
        ).fetchall()
        if rows:
            total = int(rows[0][-1])
        else:
            total_row = con.execute(
                "SELECT count(*) FROM spans_window WHERE name LIKE 'agent_run%'"
            ).fetchone()
            total = int(total_row[0]) if total_row is not None else 0
    finally:
        con.close()

    return [
        TraceListItem(
            trace_id=str(trace_id),
            span_id=str(span_id),
            run_id=str(run_id) if run_id is not None else None,
            session_id=str(session_id) if session_id is not None else None,
            agent_name=str(agent_name) if agent_name is not None else None,
            provider=str(provider) if provider is not None else None,
            model=str(model) if model is not None else None,
            provider_model=(
                f"{provider}:{model}"
                if provider is not None and model is not None
                else None
            ),
            start_ms=int(start_ms),
            end_ms=int(end_ms),
            duration_ms=round(float(duration_ms), 1),
            input_tokens=int(in_tok),
            output_tokens=int(out_tok),
            cached_tokens=int(cached_tokens),
            estimated_cost_usd=round(float(estimated_cost_usd), 8),
            llm_calls=int(llm_calls),
            tool_calls=int(tool_calls),
            error=bool(error),
        )
        for (
            trace_id,
            span_id,
            run_id,
            session_id,
            agent_name,
            provider,
            model,
            start_ms,
            end_ms,
            duration_ms,
            in_tok,
            out_tok,
            cached_tokens,
            estimated_cost_usd,
            llm_calls,
            tool_calls,
            error,
        ) in (row[:-1] for row in rows)
    ], total


def list_traces(
    days: int = 7,
    limit: int = 50,
    offset: int = 0,
) -> list[TraceListItem]:
    """Return a paginated trace list without its total count."""
    return list_traces_with_count(days=days, limit=limit, offset=offset)[0]


def count_traces(days: int = 7) -> int:
    """Return total agent-run rows in the window for trace pagination."""
    days = max(1, min(90, days))
    now = datetime.now(timezone.utc)
    window_start = now - timedelta(days=days)

    files = _candidate_files(window_start)
    if not files:
        return 0

    con = duckdb.connect(":memory:")
    try:
        _create_spans_window_view(con, files, window_start, now)
        row = con.execute(
            """
            SELECT count(*)
            FROM spans_window
            WHERE name LIKE 'agent_run%'
            """
        ).fetchone()
    finally:
        con.close()
    return int(row[0]) if row is not None else 0


def get_trace(trace_id: str, days: int = 30) -> TraceDetail | None:
    """Return all spans with ``trace_id``, ordered by ``start_time`` asc.

    Returns ``None`` when the trace is not found in the window (e.g. expired
    by retention, outside lookback, or id typo).  The window defaults to 30
    days to tolerate long-lived bookmarks.

    Args:
        trace_id: Hex string with or without the ``0x`` prefix (OTel writes
            JSONL with ``0x``; the UI passes whatever it has).
        days: Look-back window in days (1–90).
    """
    days = max(1, min(90, days))
    now = datetime.now(timezone.utc)
    window_start = now - timedelta(days=days)

    # Normalise: accept both "0xabcd…" and "abcd…" but query with the prefix
    # form because that's what the exporter writes.
    tid = trace_id.lower()
    if not tid.startswith("0x"):
        tid = "0x" + tid

    files = _candidate_files(window_start)
    if not files:
        return None

    con = duckdb.connect(":memory:")
    try:
        _create_spans_window_view(con, files, window_start, now)
        rows = con.execute(
            """
            SELECT
              span_id,
              parent_id,
              trace_id,
              name,
              kind,
              start_time // 1000000 AS start_ms,
              end_time   // 1000000 AS end_ms,
              duration_ms,
              status,
              attributes
            FROM spans_window
            WHERE trace_id = ?
            ORDER BY start_time ASC
            """,
            [tid],
        ).fetchall()
    finally:
        con.close()

    if not rows:
        return None

    spans: list[SpanDetail] = []
    for (
        span_id,
        parent_id,
        tr_id,
        name,
        kind,
        start_ms,
        end_ms,
        duration_ms,
        status,
        attributes,
    ) in rows:
        spans.append(
            SpanDetail(
                span_id=str(span_id),
                parent_span_id=str(parent_id) if parent_id is not None else None,
                trace_id=str(tr_id),
                name=str(name),
                kind=str(kind) if kind is not None else "INTERNAL",
                start_ms=int(start_ms),
                end_ms=int(end_ms),
                duration_ms=round(float(duration_ms), 1),
                status=str(status) if status is not None else "UNSET",
                # DuckDB's ``read_json`` returns STRUCT / MAP for nested
                # objects.  Coerce to a plain dict with str keys so FastAPI
                # can serialise it cleanly.  Non-dict values (should not
                # happen in practice) round-trip as empty.
                #
                # ``union_by_name=true`` above unions the attribute schema
                # across span types — so every row carries every key seen
                # anywhere in the window, with ``None`` where the span
                # didn't set it.  We strip the Nones here so the UI only
                # renders keys the span actually emitted.
                attributes=(
                    {k: v for k, v in attributes.items() if v is not None}
                    if isinstance(attributes, dict)
                    else {}
                ),
            )
        )

    return TraceDetail(trace_id=spans[0].trace_id, spans=spans)
