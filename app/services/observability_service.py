"""Aggregate OTEL span JSONL files into a UI-friendly summary.

Reads span files written by :mod:`app.core.otel` (hourly partitions under
``{STATE_DIR}/otel/spans/YYYY-MM-DD-HH.jsonl``) using fast JSON parsing
(orjson with standard library json fallback).

Design
------
- No state; every call re-queries the files. File count is small (24 / day ×
  retention), query is fast (< 50 ms on a week of data).
- Sampling-aware: if ``OTEL_SPAN_SAMPLE_RATIO < 1.0``, the endpoint attaches
  ``sample_ratio`` to the payload so the UI can render a banner. Turn counts
  are **not** scaled up — callers must decide whether to multiply.
- Only ``agent_run`` spans count as a "turn"; ``chat``/``execute_tool`` spans
  count as LLM / tool calls respectively.
"""

from __future__ import annotations

import os
from copy import deepcopy
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from functools import lru_cache
from pathlib import Path
from typing import Any

import orjson


from loguru import logger

_CACHE_BUCKET_SECONDS = 5
_CACHE_MAXSIZE = 64
FileSignatures = tuple[tuple[str, int, int], ...]


@dataclass(frozen=True)
class TraceListItem:
    """One row in the traces-list view — a single ``agent_run`` (turn).

    Identifies the turn (trace_id, run_id, session_id, agent), its timing,
    token usage, and a best-effort ``error`` flag (True when the span's OTel
    status is ``ERROR``). The UI uses this shape to render a scrollable list.
    """

    trace_id: str
    span_id: str
    run_id: str | None
    session_id: str | None
    agent_name: str | None
    provider: str | None
    model: str | None
    provider_model: str | None
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
    """One span inside a trace — full attribute payload included."""

    span_id: str
    parent_span_id: str | None
    trace_id: str
    name: str
    kind: str
    start_ms: int
    end_ms: int
    duration_ms: float
    status: str
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

    total_turns: int
    total_llm_calls: int
    total_tool_calls: int
    total_input_tokens: int
    total_output_tokens: int
    total_cached_tokens: int
    total_cache_write_tokens: int
    total_estimated_cost_usd: float
    total_errors: int

    turn_p50_ms: float
    turn_p95_ms: float
    llm_p50_ms: float
    llm_p95_ms: float

    daily_turns: list[dict]
    by_model: list[dict]
    cache_by_step: list[dict]
    by_tool: list[dict]

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
                "cache_write_tokens": self.total_cache_write_tokens,
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
        total_cache_write_tokens=0,
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
    spans_dir = _spans_dir()
    if not spans_dir.is_dir():
        logger.debug("observability_spans_dir_missing path={}", spans_dir)
        return []
    cutoff_key = window_start.strftime("%Y-%m-%d-%H")
    return sorted(p for p in spans_dir.glob("*.jsonl") if p.stem >= cutoff_key)


def _cache_context(days: int) -> tuple[int, str, FileSignatures]:
    now = datetime.now(timezone.utc)
    spans_dir = _spans_dir()
    files = _candidate_files(now - timedelta(days=days))
    signatures: list[tuple[str, int, int]] = []
    for path in files:
        try:
            stat = path.stat()
        except FileNotFoundError:
            continue
        signatures.append((str(path), stat.st_size, stat.st_mtime_ns))
    return (
        int(now.timestamp()) // _CACHE_BUCKET_SECONDS,
        str(spans_dir),
        tuple(signatures),
    )


def _signature_paths(signatures: FileSignatures) -> list[Path]:
    return [Path(path) for path, _size, _mtime_ns in signatures]


def _percent(part: int | float, total: int | float) -> float:
    if total <= 0:
        return 0.0
    return round(float(part) / float(total) * 100, 1)


def _safe_int(val: Any) -> int:
    if val is None:
        return 0
    try:
        return int(val)
    except (ValueError, TypeError):
        return 0


def _safe_float(val: Any) -> float:
    if val is None:
        return 0.0
    try:
        return float(val)
    except (ValueError, TypeError):
        return 0.0


def _quantile(values: list[float], q: float) -> float:
    if not values:
        return 0.0
    sorted_vals = sorted(values)
    n = len(sorted_vals)
    if n == 1:
        return float(sorted_vals[0])
    idx = (n - 1) * q
    i = int(idx)
    frac = idx - i
    if i + 1 < n:
        return float(sorted_vals[i] + frac * (sorted_vals[i + 1] - sorted_vals[i]))
    return float(sorted_vals[i])


def _load_spans_in_window(
    files: list[Path], window_start: datetime, window_end: datetime
) -> list[dict]:
    start_ns = int(window_start.timestamp() * 1_000_000_000)
    end_ns = int(window_end.timestamp() * 1_000_000_000)
    spans: list[dict] = []
    for path in files:
        try:
            with open(path, "rb") as fp:
                for line in fp:
                    if not line.strip():
                        continue
                    try:
                        s = orjson.loads(line)
                    except Exception:
                        continue
                    et = s.get("end_time")
                    if et is not None and start_ns <= et <= end_ns:
                        spans.append(s)
        except OSError:
            continue
    return spans


def _create_spans_window_view(
    files_or_spans: Any, window_start: datetime, window_end: datetime
) -> None:
    """Legacy test wrapper compatibility stub."""
    pass


# ── Main entry point ──────────────────────────────────────────────────────────


def summarize(days: int = 7) -> ObservabilitySummary:
    """Aggregate span JSONL files over the last ``days`` days."""
    days = max(1, min(90, days))
    bucket, spans_dir, signatures = _cache_context(days)
    return deepcopy(
        _summarize_cached(days, bucket, spans_dir, signatures, _sample_ratio())
    )


@lru_cache(maxsize=_CACHE_MAXSIZE)
def _summarize_cached(
    days: int,
    _bucket: int,
    _spans_dir: str,
    signatures: FileSignatures,
    _sample_ratio_key: float,
) -> ObservabilitySummary:
    now = datetime.now(timezone.utc)
    window_start = now - timedelta(days=days)
    files = _signature_paths(signatures)
    if not files:
        return _empty_summary(window_start, now)

    spans = _load_spans_in_window(files, window_start, now)
    return _run_queries(spans, window_start, now)


def _run_queries(
    spans: list[dict],
    window_start: datetime,
    window_end: datetime,
) -> ObservabilitySummary:

    if not spans:
        return _empty_summary(window_start, window_end)

    turns = 0
    llm_calls = 0
    tool_calls = 0
    errors = 0
    in_tokens = 0
    out_tokens = 0
    cached_tokens = 0
    cache_write_tokens = 0
    estimated_cost_usd = 0.0

    turn_durations: list[float] = []
    llm_durations: list[float] = []
    daily_map: dict[str, dict[str, int]] = {}
    model_map: dict[tuple[str, str], dict[str, Any]] = {}
    step_map: dict[tuple[str, str, str], dict[str, Any]] = {}
    tool_map: dict[str, dict[str, Any]] = {}

    for s in spans:
        name = str(s.get("name") or "")
        status = s.get("status")
        dur = _safe_float(s.get("duration_ms"))
        attrs = s.get("attributes") or {}

        is_run = name.startswith("agent_run")
        is_chat = name.startswith("chat")
        is_tool = name.startswith("execute_tool")
        is_error = status == "ERROR"

        if is_error:
            errors += 1

        if is_run:
            turns += 1
            turn_durations.append(dur)
            end_time = s.get("end_time")
            if end_time:
                day_str = datetime.fromtimestamp(
                    end_time / 1_000_000_000, tz=timezone.utc
                ).strftime("%Y-%m-%d")
                entry = daily_map.setdefault(day_str, {"turns": 0, "errors": 0})
                entry["turns"] += 1
                if is_error:
                    entry["errors"] += 1
        else:
            if is_chat:
                llm_calls += 1
                llm_durations.append(dur)
            elif is_tool:
                tool_calls += 1

            it = _safe_int(attrs.get("gen_ai.usage.input_tokens"))
            ot = _safe_int(attrs.get("gen_ai.usage.output_tokens"))
            ct = _safe_int(attrs.get("gen_ai.usage.cache_read.input_tokens"))
            cw = _safe_int(attrs.get("gen_ai.usage.cache_creation.input_tokens"))
            cost = _safe_float(attrs.get("gen_ai.usage.estimated_cost_usd"))

            in_tokens += it
            out_tokens += ot
            cached_tokens += ct
            cache_write_tokens += cw
            estimated_cost_usd += cost

            has_tokens = ("gen_ai.usage.input_tokens" in attrs) or (
                "gen_ai.usage.output_tokens" in attrs
            )
            if has_tokens:
                provider = str(attrs.get("gen_ai.provider.name") or "unknown")
                model = str(attrs.get("gen_ai.request.model") or "unknown")
                m_entry = model_map.setdefault(
                    (provider, model),
                    {
                        "calls": 0,
                        "in_tok": 0,
                        "out_tok": 0,
                        "cached_tok": 0,
                        "cache_write_tok": 0,
                        "cost": 0.0,
                        "durations": [],
                    },
                )
                m_entry["calls"] += 1
                m_entry["in_tok"] += it
                m_entry["out_tok"] += ot
                m_entry["cached_tok"] += ct
                m_entry["cache_write_tok"] += cw
                m_entry["cost"] += cost
                m_entry["durations"].append(dur)

            has_input_or_cache = ("gen_ai.usage.input_tokens" in attrs) or (
                "gen_ai.usage.cache_read.input_tokens" in attrs
            )
            if has_input_or_cache:
                op_name = attrs.get("gen_ai.operation.name")
                if op_name:
                    step = str(op_name)
                elif name.startswith("summarization"):
                    step = "summarization"
                elif name.startswith("title_generation"):
                    step = "title_generation"
                elif name.startswith("chat"):
                    step = "chat"
                else:
                    step = name
                provider = str(attrs.get("gen_ai.provider.name") or "unknown")
                model = str(attrs.get("gen_ai.request.model") or "unknown")
                s_entry = step_map.setdefault(
                    (step, provider, model),
                    {
                        "calls": 0,
                        "in_tok": 0,
                        "cached_tok": 0,
                        "cache_write_tok": 0,
                        "cost": 0.0,
                    },
                )
                s_entry["calls"] += 1
                s_entry["in_tok"] += it
                s_entry["cached_tok"] += ct
                s_entry["cache_write_tok"] += cw
                s_entry["cost"] += cost

        if is_tool:
            tool_name = str(attrs.get("gen_ai.tool.name") or "unknown")
            t_entry = tool_map.setdefault(
                tool_name, {"calls": 0, "errors": 0, "durations": []}
            )
            t_entry["calls"] += 1
            if is_error:
                t_entry["errors"] += 1
            t_entry["durations"].append(dur)

    daily_turns = [
        {"day": day, "turns": data["turns"], "errors": data["errors"]}
        for day, data in sorted(daily_map.items(), key=lambda x: x[0])
    ]

    by_model_list = [
        {
            "provider": provider,
            "model": m,
            "provider_model": f"{provider}:{m}",
            "calls": data["calls"],
            "input_tokens": data["in_tok"],
            "output_tokens": data["out_tok"],
            "cached_tokens": data["cached_tok"],
            "cache_write_tokens": data["cache_write_tok"],
            "cache_percent": _percent(data["cached_tok"], data["in_tok"]),
            "estimated_cost_usd": round(data["cost"], 8),
            "p95_ms": round(_quantile(data["durations"], 0.95), 1),
        }
        for (provider, m), data in sorted(
            model_map.items(),
            key=lambda x: (x[1]["cost"], x[1]["calls"]),
            reverse=True,
        )
    ]

    cache_by_step_list = [
        {
            "step": step,
            "provider": provider,
            "model": model,
            "provider_model": f"{provider}:{model}",
            "calls": data["calls"],
            "input_tokens": data["in_tok"],
            "cached_tokens": data["cached_tok"],
            "cache_write_tokens": data["cache_write_tok"],
            "miss_tokens": max(data["in_tok"] - data["cached_tok"], 0),
            "cache_percent": _percent(data["cached_tok"], data["in_tok"]),
            "estimated_cost_usd": round(data["cost"], 8),
        }
        for (step, provider, model), data in sorted(
            step_map.items(),
            key=lambda x: (x[1]["cost"], x[1]["in_tok"]),
            reverse=True,
        )
    ]

    by_tool_list = [
        {
            "tool": tool,
            "calls": data["calls"],
            "errors": data["errors"],
            "p95_ms": round(_quantile(data["durations"], 0.95), 1),
        }
        for tool, data in sorted(
            tool_map.items(), key=lambda x: x[1]["calls"], reverse=True
        )
    ]

    return ObservabilitySummary(
        window_start=window_start,
        window_end=window_end,
        sample_ratio=_sample_ratio(),
        total_turns=turns,
        total_llm_calls=llm_calls,
        total_tool_calls=tool_calls,
        total_input_tokens=in_tokens,
        total_output_tokens=out_tokens,
        total_cached_tokens=cached_tokens,
        total_cache_write_tokens=cache_write_tokens,
        total_estimated_cost_usd=round(estimated_cost_usd, 8),
        total_errors=errors,
        turn_p50_ms=round(_quantile(turn_durations, 0.5), 1),
        turn_p95_ms=round(_quantile(turn_durations, 0.95), 1),
        llm_p50_ms=round(_quantile(llm_durations, 0.5), 1),
        llm_p95_ms=round(_quantile(llm_durations, 0.95), 1),
        daily_turns=daily_turns,
        by_model=by_model_list,
        cache_by_step=cache_by_step_list,
        by_tool=by_tool_list,
    )


# ── Trace list + detail ───────────────────────────────────────────────────────


def list_traces_with_count(
    days: int = 7,
    limit: int = 50,
    offset: int = 0,
) -> tuple[list[TraceListItem], int]:
    days = max(1, min(90, days))
    limit = max(1, min(200, limit))
    offset = max(0, offset)
    bucket, spans_dir, signatures = _cache_context(days)
    items, total = _list_traces_with_count_cached(
        days, limit, offset, bucket, spans_dir, signatures
    )
    return list(items), total


@lru_cache(maxsize=_CACHE_MAXSIZE)
def _list_traces_with_count_cached(
    days: int,
    limit: int,
    offset: int,
    _bucket: int,
    _spans_dir: str,
    signatures: FileSignatures,
) -> tuple[list[TraceListItem], int]:
    now = datetime.now(timezone.utc)
    window_start = now - timedelta(days=days)

    files = _signature_paths(signatures)
    if not files:
        return [], 0

    spans = _load_spans_in_window(files, window_start, now)
    if not spans:
        return [], 0

    counts: dict[str, dict[str, Any]] = {}
    runs: list[dict] = []

    for s in spans:
        name = str(s.get("name") or "")
        tid = s.get("trace_id")
        if not tid:
            continue
        tid_str = str(tid)
        attrs = s.get("attributes") or {}

        c_entry = counts.setdefault(
            tid_str,
            {
                "llm_calls": 0,
                "tool_calls": 0,
                "input_tokens": 0,
                "output_tokens": 0,
                "cached_tokens": 0,
                "estimated_cost_usd": 0.0,
            },
        )

        if name.startswith("agent_run"):
            runs.append(s)
        else:
            if name.startswith("chat"):
                c_entry["llm_calls"] += 1
            elif name.startswith("execute_tool"):
                c_entry["tool_calls"] += 1

            c_entry["input_tokens"] += _safe_int(attrs.get("gen_ai.usage.input_tokens"))
            c_entry["output_tokens"] += _safe_int(
                attrs.get("gen_ai.usage.output_tokens")
            )
            c_entry["cached_tokens"] += _safe_int(
                attrs.get("gen_ai.usage.cache_read.input_tokens")
            )
            c_entry["estimated_cost_usd"] += _safe_float(
                attrs.get("gen_ai.usage.estimated_cost_usd")
            )

    runs.sort(key=lambda x: x.get("end_time") or 0, reverse=True)
    total_count = len(runs)

    page_runs = runs[offset : offset + limit]
    items: list[TraceListItem] = []

    for s in page_runs:
        tid_str = str(s.get("trace_id"))
        attrs = s.get("attributes") or {}
        c = counts.get(tid_str, {})

        provider = attrs.get("gen_ai.provider.name")
        model = attrs.get("gen_ai.request.model")
        provider_str = str(provider) if provider is not None else None
        model_str = str(model) if model is not None else None

        start_ns = s.get("start_time") or 0
        end_ns = s.get("end_time") or 0

        items.append(
            TraceListItem(
                trace_id=tid_str,
                span_id=str(s.get("span_id")),
                run_id=str(attrs.get("run_id"))
                if attrs.get("run_id") is not None
                else None,
                session_id=str(attrs.get("gen_ai.conversation.id"))
                if attrs.get("gen_ai.conversation.id") is not None
                else None,
                agent_name=str(attrs.get("gen_ai.agent.name"))
                if attrs.get("gen_ai.agent.name") is not None
                else None,
                provider=provider_str,
                model=model_str,
                provider_model=(
                    f"{provider_str}:{model_str}"
                    if provider_str is not None and model_str is not None
                    else None
                ),
                start_ms=int(start_ns // 1_000_000),
                end_ms=int(end_ns // 1_000_000),
                duration_ms=round(_safe_float(s.get("duration_ms")), 1),
                input_tokens=_safe_int(c.get("input_tokens")),
                output_tokens=_safe_int(c.get("output_tokens")),
                cached_tokens=_safe_int(c.get("cached_tokens")),
                estimated_cost_usd=round(_safe_float(c.get("estimated_cost_usd")), 8),
                llm_calls=_safe_int(c.get("llm_calls")),
                tool_calls=_safe_int(c.get("tool_calls")),
                error=s.get("status") == "ERROR",
            )
        )

    return items, total_count


def get_trace(trace_id: str, days: int = 30) -> TraceDetail | None:
    days = max(1, min(90, days))
    tid = trace_id.lower()
    if not tid.startswith("0x"):
        tid = "0x" + tid

    bucket, spans_dir, signatures = _cache_context(days)
    return deepcopy(_get_trace_cached(tid, days, bucket, spans_dir, signatures))


@lru_cache(maxsize=_CACHE_MAXSIZE)
def _get_trace_cached(
    tid: str, days: int, _bucket: int, _spans_dir: str, signatures: FileSignatures
) -> TraceDetail | None:
    now = datetime.now(timezone.utc)
    window_start = now - timedelta(days=days)
    files = _signature_paths(signatures)
    if not files:
        return None

    spans_in_win = _load_spans_in_window(files, window_start, now)
    matching = [
        s for s in spans_in_win if str(s.get("trace_id")).lower() == tid.lower()
    ]
    if not matching:
        return None

    matching.sort(key=lambda x: x.get("start_time") or 0)

    spans: list[SpanDetail] = []
    for s in matching:
        attrs = s.get("attributes")
        clean_attrs = (
            {k: v for k, v in attrs.items() if v is not None}
            if isinstance(attrs, dict)
            else {}
        )
        start_ns = s.get("start_time") or 0
        end_ns = s.get("end_time") or 0
        parent_id = s.get("parent_id")

        spans.append(
            SpanDetail(
                span_id=str(s.get("span_id")),
                parent_span_id=str(parent_id) if parent_id is not None else None,
                trace_id=str(s.get("trace_id")),
                name=str(s.get("name") or ""),
                kind=str(s.get("kind") or "INTERNAL"),
                start_ms=int(start_ns // 1_000_000),
                end_ms=int(end_ns // 1_000_000),
                duration_ms=round(_safe_float(s.get("duration_ms")), 1),
                status=str(s.get("status") or "UNSET"),
                attributes=clean_attrs,
            )
        )

    return TraceDetail(trace_id=spans[0].trace_id, spans=spans)
