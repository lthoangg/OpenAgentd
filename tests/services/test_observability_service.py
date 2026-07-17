"""Tests for app/services/observability_service.py."""

from __future__ import annotations

import json
import os
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

import pytest

from app.services import observability_service
from app.services.observability_service import (
    count_traces,
    get_trace,
    list_traces,
    list_traces_with_count,
    summarize,
)


# ── Helpers ───────────────────────────────────────────────────────────────────


def _span(
    *,
    name: str,
    end_time_ns: int,
    duration_ms: float,
    status: str = "OK",
    attributes: dict | None = None,
    trace_id: str = "0x" + "f" * 32,
    span_id: str = "0x" + "e" * 16,
    parent_id: str | None = None,
    kind: str = "INTERNAL",
) -> dict:
    return {
        "name": name,
        "trace_id": trace_id,
        "span_id": span_id,
        "parent_id": parent_id,
        "kind": kind,
        "start_time": end_time_ns - int(duration_ms * 1_000_000),
        "end_time": end_time_ns,
        "duration_ms": duration_ms,
        "status": status,
        "attributes": attributes or {},
        "events": [],
        "resource": {"service.name": "openagentd"},
    }


def _write_spans(path: Path, spans: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as f:
        for s in spans:
            f.write(json.dumps(s) + "\n")


def _point_openagentd_at(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    # Observability reads spans from ``{STATE_DIR}/otel/spans`` now — point
    # STATE_DIR at tmp_path so the test's ``tmp_path/otel/spans`` layout stays
    # as-is.  We also need to flush the cached settings singleton, since
    # observability_service imports ``settings`` at request time; but the
    # service re-imports inside ``_spans_dir``, so a plain env override works.
    from app.core import config as _config

    monkeypatch.setattr(
        _config.settings, "OPENAGENTD_STATE_DIR", str(tmp_path), raising=True
    )
    return tmp_path / "otel" / "spans"


# ── Empty / missing ───────────────────────────────────────────────────────────


def test_summarize_returns_empty_when_spans_dir_missing(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    _point_openagentd_at(tmp_path, monkeypatch)
    result = summarize(days=7)
    assert result.total_turns == 0
    assert result.total_llm_calls == 0
    assert result.daily_turns == []


def test_summarize_returns_empty_when_no_files_in_window(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    spans_dir = _point_openagentd_at(tmp_path, monkeypatch)
    # File from 200 days ago — outside the 7-day window.
    old = datetime.now(timezone.utc) - timedelta(days=200)
    old_key = old.strftime("%Y-%m-%d-%H")
    _write_spans(
        spans_dir / f"{old_key}.jsonl",
        [
            _span(
                name="agent_run lead",
                end_time_ns=int(old.timestamp() * 1e9),
                duration_ms=1.0,
            )
        ],
    )
    result = summarize(days=7)
    assert result.total_turns == 0


# ── Happy path ────────────────────────────────────────────────────────────────


def test_summarize_aggregates_turns_llm_tools(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    spans_dir = _point_openagentd_at(tmp_path, monkeypatch)
    now = datetime.now(timezone.utc)
    key = now.strftime("%Y-%m-%d-%H")
    ts_ns = int(now.timestamp() * 1e9)

    spans = [
        # 2 turns
        _span(name="agent_run lead", end_time_ns=ts_ns, duration_ms=1200.0),
        _span(
            name="agent_run lead", end_time_ns=ts_ns, duration_ms=800.0, status="ERROR"
        ),
        # 3 LLM calls
        _span(
            name="chat gpt-4o",
            end_time_ns=ts_ns,
            duration_ms=500.0,
            attributes={
                "gen_ai.provider.name": "openai",
                "gen_ai.request.model": "gpt-4o",
                "gen_ai.usage.input_tokens": 1000,
                "gen_ai.usage.output_tokens": 200,
                "gen_ai.usage.cache_read.input_tokens": 250,
                "gen_ai.usage.estimated_cost_usd": 0.004,
            },
        ),
        _span(
            name="chat gpt-4o",
            end_time_ns=ts_ns,
            duration_ms=700.0,
            attributes={
                "gen_ai.provider.name": "openai",
                "gen_ai.request.model": "gpt-4o",
                "gen_ai.usage.input_tokens": 500,
                "gen_ai.usage.output_tokens": 100,
                "gen_ai.usage.cache_read.input_tokens": 50,
                "gen_ai.usage.estimated_cost_usd": 0.002,
            },
        ),
        _span(
            name="chat gemini-flash",
            end_time_ns=ts_ns,
            duration_ms=200.0,
            attributes={
                "gen_ai.provider.name": "google",
                "gen_ai.request.model": "gemini-flash",
                "gen_ai.usage.input_tokens": 400,
                "gen_ai.usage.output_tokens": 80,
                "gen_ai.usage.estimated_cost_usd": 0.001,
            },
        ),
        _span(
            name="title_generation",
            end_time_ns=ts_ns,
            duration_ms=120.0,
            attributes={
                "gen_ai.operation.name": "title_generation",
                "gen_ai.provider.name": "openai",
                "gen_ai.request.model": "gpt-4o-mini",
                "gen_ai.usage.input_tokens": 100,
                "gen_ai.usage.output_tokens": 20,
                "gen_ai.usage.cache_read.input_tokens": 80,
                "gen_ai.usage.estimated_cost_usd": 0.0001,
            },
        ),
        # 2 tool calls (one errored)
        _span(
            name="execute_tool read",
            end_time_ns=ts_ns,
            duration_ms=10.0,
            attributes={"gen_ai.tool.name": "read"},
        ),
        _span(
            name="execute_tool web_fetch",
            end_time_ns=ts_ns,
            duration_ms=300.0,
            status="ERROR",
            attributes={"gen_ai.tool.name": "web_fetch"},
        ),
    ]
    _write_spans(spans_dir / f"{key}.jsonl", spans)

    result = summarize(days=7)

    assert result.total_turns == 2
    assert result.total_llm_calls == 3
    assert result.total_tool_calls == 2
    assert result.total_input_tokens == 2000
    assert result.total_output_tokens == 400
    assert result.total_cached_tokens == 380
    assert result.total_estimated_cost_usd == 0.0071
    # 1 agent_run + 1 tool in ERROR status
    assert result.total_errors == 2

    # Latency percentiles
    assert result.turn_p50_ms > 0
    assert result.llm_p50_ms > 0

    # Daily bucket
    assert len(result.daily_turns) == 1
    assert result.daily_turns[0]["turns"] == 2
    assert result.daily_turns[0]["errors"] == 1

    # Per-model breakdown
    models = {m["model"]: m for m in result.by_model}
    assert models["gpt-4o"]["calls"] == 2
    assert models["gpt-4o"]["provider"] == "openai"
    assert models["gpt-4o"]["provider_model"] == "openai:gpt-4o"
    assert models["gpt-4o"]["input_tokens"] == 1500
    assert models["gpt-4o"]["cached_tokens"] == 300
    assert models["gpt-4o"]["cache_percent"] == 20.0
    assert models["gpt-4o"]["estimated_cost_usd"] == 0.006
    assert models["gemini-flash"]["calls"] == 1

    cache_steps = {
        (row["step"], row["provider_model"]): row for row in result.cache_by_step
    }
    chat_openai = cache_steps[("chat", "openai:gpt-4o")]
    assert chat_openai["input_tokens"] == 1500
    assert chat_openai["cached_tokens"] == 300
    assert chat_openai["miss_tokens"] == 1200
    title_generation = cache_steps[("title_generation", "openai:gpt-4o-mini")]
    assert title_generation["input_tokens"] == 100
    assert title_generation["cached_tokens"] == 80
    assert title_generation["cache_percent"] == 80.0

    # Per-tool breakdown
    tools = {t["tool"]: t for t in result.by_tool}
    assert tools["read"]["calls"] == 1
    assert tools["read"]["errors"] == 0
    assert tools["web_fetch"]["calls"] == 1
    assert tools["web_fetch"]["errors"] == 1


def test_summarize_clamps_days(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    _point_openagentd_at(tmp_path, monkeypatch)
    # Should not raise even with out-of-range input.
    result = summarize(days=0)
    assert (result.window_end - result.window_start).days == 1
    result = summarize(days=500)
    assert (result.window_end - result.window_start).days == 90


def test_summarize_reports_sample_ratio(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    _point_openagentd_at(tmp_path, monkeypatch)
    monkeypatch.setenv("OTEL_SPAN_SAMPLE_RATIO", "0.25")
    result = summarize(days=7)
    assert result.sample_ratio == 0.25


# ── Serialisation ─────────────────────────────────────────────────────────────


def test_to_dict_round_trips(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    _point_openagentd_at(tmp_path, monkeypatch)
    result = summarize(days=7)
    d = result.to_dict()
    assert set(d.keys()) == {
        "window_start",
        "window_end",
        "sample_ratio",
        "totals",
        "latency_ms",
        "daily_turns",
        "by_model",
        "cache_by_step",
        "by_tool",
    }
    assert set(d["totals"].keys()) == {
        "turns",
        "llm_calls",
        "tool_calls",
        "input_tokens",
        "output_tokens",
        "cached_tokens",
        "cache_percent",
        "estimated_cost_usd",
        "errors",
    }


# ── list_traces ───────────────────────────────────────────────────────────────


def _write_trace(
    spans_dir: Path,
    *,
    trace_id: str,
    end_time_ns: int,
    agent_name: str = "lead",
    model: str = "gpt-4o",
    session_id: str = "sess-a",
    run_id: str = "run-1",
    with_tool: bool = False,
    error: bool = False,
) -> None:
    """Write an ``agent_run`` + ``chat`` (+ optional ``execute_tool``) trio."""
    key = datetime.fromtimestamp(end_time_ns / 1e9, tz=timezone.utc).strftime(
        "%Y-%m-%d-%H"
    )
    path = spans_dir / f"{key}.jsonl"
    root_id = "0x" + "a" * 16
    spans = [
        _span(
            name=f"agent_run {agent_name}",
            end_time_ns=end_time_ns,
            duration_ms=1500.0,
            status="ERROR" if error else "OK",
            attributes={
                "gen_ai.agent.name": agent_name,
                "gen_ai.provider.name": "openai",
                "gen_ai.request.model": model,
                "gen_ai.conversation.id": session_id,
                "run_id": run_id,
                "gen_ai.usage.input_tokens": 1000,
                "gen_ai.usage.output_tokens": 200,
            },
            trace_id=trace_id,
            span_id=root_id,
        ),
        _span(
            name=f"chat {model}",
            end_time_ns=end_time_ns - 1_000_000,  # 1 ms earlier
            duration_ms=400.0,
            attributes={
                "gen_ai.operation.name": "chat",
                "gen_ai.provider.name": "openai",
                "gen_ai.request.model": model,
                "gen_ai.agent.name": agent_name,
                "run_id": run_id,
                "gen_ai.usage.input_tokens": 900,
                "gen_ai.usage.output_tokens": 150,
                "gen_ai.usage.cache_read.input_tokens": 300,
                "gen_ai.usage.estimated_cost_usd": 0.0035,
            },
            trace_id=trace_id,
            span_id="0x" + "b" * 16,
            parent_id=root_id,
            kind="CLIENT",
        ),
    ]
    if with_tool:
        spans.append(
            _span(
                name="execute_tool read",
                end_time_ns=end_time_ns - 2_000_000,
                duration_ms=50.0,
                attributes={
                    "gen_ai.operation.name": "execute_tool",
                    "gen_ai.tool.name": "read",
                    "gen_ai.agent.name": agent_name,
                    "run_id": run_id,
                },
                trace_id=trace_id,
                span_id="0x" + "c" * 16,
                parent_id=root_id,
            )
        )
    _write_spans(path, spans)


def test_list_traces_empty_when_no_files(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    _point_openagentd_at(tmp_path, monkeypatch)
    assert list_traces(days=7) == []


def test_list_traces_returns_one_row_per_agent_run(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    spans_dir = _point_openagentd_at(tmp_path, monkeypatch)
    now_ns = int(datetime.now(timezone.utc).timestamp() * 1e9)

    _write_trace(spans_dir, trace_id="0x" + "1" * 32, end_time_ns=now_ns)
    _write_trace(
        spans_dir,
        trace_id="0x" + "2" * 32,
        end_time_ns=now_ns - 60_000_000_000,  # 60 s earlier
        with_tool=True,
        error=True,
    )

    rows = list_traces(days=7)

    assert len(rows) == 2
    # Newest first
    assert rows[0].trace_id == "0x" + "1" * 32
    assert rows[1].trace_id == "0x" + "2" * 32
    # Row 0: just a chat span, no tool
    assert rows[0].llm_calls == 1
    assert rows[0].tool_calls == 0
    assert rows[0].error is False
    # Row 1: one chat + one tool, errored
    assert rows[1].llm_calls == 1
    assert rows[1].tool_calls == 1
    assert rows[1].error is True
    # Attributes are unpacked into typed columns
    assert rows[0].agent_name == "lead"
    assert rows[0].provider == "openai"
    assert rows[0].model == "gpt-4o"
    assert rows[0].provider_model == "openai:gpt-4o"
    assert rows[0].session_id == "sess-a"
    assert rows[0].input_tokens == 900
    assert rows[0].output_tokens == 150
    assert rows[0].cached_tokens == 300
    assert rows[0].estimated_cost_usd == 0.0035
    # start_ms/end_ms are epoch milliseconds (JS-friendly)
    assert rows[0].end_ms == now_ns // 1_000_000
    assert rows[0].duration_ms == 1500.0


def test_list_traces_pagination(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    spans_dir = _point_openagentd_at(tmp_path, monkeypatch)
    base_ns = int(datetime.now(timezone.utc).timestamp() * 1e9)
    for i in range(5):
        _write_trace(
            spans_dir,
            trace_id=f"0x{i:032x}",
            end_time_ns=base_ns - i * 1_000_000_000,  # space out by 1 s
            run_id=f"run-{i}",
        )

    first = list_traces(days=7, limit=2, offset=0)
    second = list_traces(days=7, limit=2, offset=2)
    assert [r.run_id for r in first] == ["run-0", "run-1"]
    assert [r.run_id for r in second] == ["run-2", "run-3"]
    assert count_traces(days=7) == 5


def test_list_traces_with_count_returns_page_and_total_in_one_result(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    spans_dir = _point_openagentd_at(tmp_path, monkeypatch)
    base_ns = int(datetime.now(timezone.utc).timestamp() * 1e9)
    for i in range(5):
        _write_trace(
            spans_dir,
            trace_id=f"0x{i:032x}",
            end_time_ns=base_ns - i * 1_000_000_000,
            run_id=f"run-{i}",
        )

    page, total = list_traces_with_count(days=7, limit=2, offset=2)

    assert [row.run_id for row in page] == ["run-2", "run-3"]
    assert total == 5

    empty_page, total = list_traces_with_count(days=7, limit=2, offset=50)
    assert empty_page == []
    assert total == 5


def test_list_traces_clamps_inputs(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    _point_openagentd_at(tmp_path, monkeypatch)
    # Should not raise; should return empty because no files.
    assert list_traces(days=0, limit=0, offset=-1) == []
    assert list_traces(days=500, limit=10_000, offset=0) == []


# ── get_trace ─────────────────────────────────────────────────────────────────


def test_get_trace_returns_none_when_missing(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    _point_openagentd_at(tmp_path, monkeypatch)
    assert get_trace("0x" + "1" * 32) is None


def test_get_trace_returns_all_spans_ordered(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    spans_dir = _point_openagentd_at(tmp_path, monkeypatch)
    now_ns = int(datetime.now(timezone.utc).timestamp() * 1e9)
    trace = "0x" + "1" * 32
    _write_trace(spans_dir, trace_id=trace, end_time_ns=now_ns, with_tool=True)

    detail = get_trace(trace)

    assert detail is not None
    assert detail.trace_id == trace
    # 3 spans: agent_run, chat, execute_tool
    assert len(detail.spans) == 3
    # Ordered by start_time ASC.  The root ``agent_run`` starts first
    # (it wraps the others); ``chat`` starts slightly later, and
    # ``execute_tool`` fires last in the fixture.
    names_in_order = [s.name for s in detail.spans]
    assert names_in_order == [
        "agent_run lead",
        "chat gpt-4o",
        "execute_tool read",
    ]
    # Full attributes included
    root = next(s for s in detail.spans if s.name.startswith("agent_run"))
    assert root.parent_span_id is None
    assert root.attributes["gen_ai.agent.name"] == "lead"
    assert root.attributes["gen_ai.usage.input_tokens"] == 1000
    # Child spans link to the root
    chat = next(s for s in detail.spans if s.name.startswith("chat"))
    assert chat.parent_span_id == root.span_id
    assert chat.kind == "CLIENT"


def test_get_trace_strips_null_attributes_unioned_across_span_types(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    """DuckDB's ``union_by_name=true`` unions the attribute schema across all
    spans in the window — so a ``chat`` span's row would otherwise carry
    ``gen_ai.usage.input_tokens = None`` just because some ``agent_run`` in
    the same window set it.  The service must strip those Nones so the UI
    doesn't render rows of em-dashes.
    """
    spans_dir = _point_openagentd_at(tmp_path, monkeypatch)
    now_ns = int(datetime.now(timezone.utc).timestamp() * 1e9)
    trace = "0x" + "1" * 32
    _write_trace(spans_dir, trace_id=trace, end_time_ns=now_ns)

    detail = get_trace(trace)
    assert detail is not None

    chat = next(s for s in detail.spans if s.name.startswith("chat"))
    # The chat span only sets its own keys, not conversation id inherited from
    # agent_run. The service must not forward Nones from the union.
    assert set(chat.attributes.keys()) == {
        "gen_ai.operation.name",
        "gen_ai.provider.name",
        "gen_ai.request.model",
        "gen_ai.agent.name",
        "run_id",
        "gen_ai.usage.input_tokens",
        "gen_ai.usage.output_tokens",
        "gen_ai.usage.cache_read.input_tokens",
        "gen_ai.usage.estimated_cost_usd",
    }
    # And in particular, conversation keys (set only by agent_run) must not
    # appear as None on the chat row.
    assert "gen_ai.conversation.id" not in chat.attributes


def test_get_trace_accepts_unprefixed_trace_id(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    spans_dir = _point_openagentd_at(tmp_path, monkeypatch)
    now_ns = int(datetime.now(timezone.utc).timestamp() * 1e9)
    trace = "0x" + "1" * 32
    _write_trace(spans_dir, trace_id=trace, end_time_ns=now_ns)

    # Caller passes the hex without "0x" — should still resolve.
    detail = get_trace("1" * 32)
    assert detail is not None
    assert detail.trace_id == trace


# ── Bounded JSONL query cache ────────────────────────────────────────────────


def _clear_observability_caches() -> None:
    observability_service._summarize_cached.cache_clear()
    observability_service._list_traces_with_count_cached.cache_clear()
    observability_service._count_traces_cached.cache_clear()
    observability_service._get_trace_cached.cache_clear()


@pytest.fixture
def frozen_cache_bucket(monkeypatch: pytest.MonkeyPatch) -> None:
    """Pin the cache-key time bucket for multi-call cache-hit assertions.

    The cache key includes ``int(now.timestamp()) // _CACHE_BUCKET_SECONDS``
    (5s freshness TTL). Tests that assert "identical file state == cache
    hit" flake whenever the wall clock crosses a 5s bucket boundary between
    two calls — reproduced deterministically by aligning the first call
    ~50ms before a boundary (call_count came back 2 instead of 1). A huge
    bucket keeps every call in this test within one bucket; file-signature
    invalidation — the behavior under test — is unaffected.
    """
    monkeypatch.setattr(observability_service, "_CACHE_BUCKET_SECONDS", 10_000)


def _cache_span_attributes() -> dict:
    """Supply the unioned JSON schema expected by all observability queries."""
    return {
        "gen_ai.agent.name": "lead",
        "gen_ai.provider.name": "test",
        "gen_ai.request.model": "test-model",
        "gen_ai.conversation.id": "session",
        "run_id": "run",
        "gen_ai.operation.name": "chat",
        "gen_ai.tool.name": "read",
        "gen_ai.usage.input_tokens": 1,
        "gen_ai.usage.output_tokens": 1,
        "gen_ai.usage.cache_read.input_tokens": 0,
        "gen_ai.usage.estimated_cost_usd": 0.0,
    }


def test_summary_cache_invalidates_when_span_files_change(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, frozen_cache_bucket: None
) -> None:
    """Appends, truncations, rotations, and new files must bust cached reads."""
    spans_dir = _point_openagentd_at(tmp_path, monkeypatch)
    spans_dir.mkdir(parents=True)
    key = datetime.now(timezone.utc).strftime("%Y-%m-%d-%H")
    span_file = spans_dir / f"{key}.jsonl"
    span_file.write_text("{}\n", encoding="utf-8")

    _clear_observability_caches()
    with (
        patch.object(observability_service, "_create_spans_window_view"),
        patch.object(
            observability_service,
            "_run_queries",
            side_effect=lambda _con, start, end: observability_service._empty_summary(
                start, end
            ),
        ) as run_queries,
    ):
        summarize(days=7)
        summarize(days=7)
        span_file.write_text("{}\n{}\n", encoding="utf-8")
        summarize(days=7)
        span_file.write_text("{}\n", encoding="utf-8")
        summarize(days=7)
        os.replace(span_file, spans_dir / f"{key}.old")
        span_file.write_text("{}\n", encoding="utf-8")
        summarize(days=7)
        (spans_dir / f"{key}-extra.jsonl").write_text("{}\n", encoding="utf-8")
        summarize(days=7)

    assert run_queries.call_count == 5


def test_summary_cache_key_includes_query_arguments(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, frozen_cache_bucket: None
) -> None:
    spans_dir = _point_openagentd_at(tmp_path, monkeypatch)
    spans_dir.mkdir(parents=True)
    key = datetime.now(timezone.utc).strftime("%Y-%m-%d-%H")
    (spans_dir / f"{key}.jsonl").write_text("{}\n", encoding="utf-8")

    _clear_observability_caches()
    with (
        patch.object(observability_service, "_create_spans_window_view"),
        patch.object(
            observability_service,
            "_run_queries",
            side_effect=lambda _con, start, end: observability_service._empty_summary(
                start, end
            ),
        ) as run_queries,
    ):
        summarize(days=1)
        summarize(days=7)
        summarize(days=1)

    assert run_queries.call_count == 2


@pytest.mark.parametrize("query", ["list", "detail", "count"])
def test_trace_query_caches_invalidate_on_jsonl_signature_change(
    query: str,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    frozen_cache_bucket: None,
) -> None:
    """Every trace query reuses unchanged scans and refreshes after an append."""
    spans_dir = _point_openagentd_at(tmp_path, monkeypatch)
    now = datetime.now(timezone.utc)
    trace_id = "0x" + "c" * 32
    span_file = spans_dir / f"{now:%Y-%m-%d-%H}.jsonl"
    _write_spans(
        span_file,
        [
            _span(
                name="agent_run lead",
                trace_id=trace_id,
                end_time_ns=int(now.timestamp() * 1e9),
                duration_ms=10.0,
                attributes=_cache_span_attributes(),
            )
        ],
    )
    _clear_observability_caches()

    def run_query() -> object:
        if query == "list":
            return list_traces_with_count(days=7)
        if query == "detail":
            return get_trace(trace_id, days=7)
        return count_traces(days=7)

    with patch.object(
        observability_service,
        "_create_spans_window_view",
        wraps=observability_service._create_spans_window_view,
    ) as create_view:
        run_query()
        run_query()
        _write_spans(
            span_file,
            [
                _span(
                    name="chat model",
                    trace_id=trace_id,
                    end_time_ns=int(now.timestamp() * 1e9),
                    duration_ms=5.0,
                )
            ],
        )
        run_query()

    assert create_view.call_count == 2


def test_cached_results_do_not_leak_caller_mutations(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    spans_dir = _point_openagentd_at(tmp_path, monkeypatch)
    now = datetime.now(timezone.utc)
    trace_id = "0x" + "d" * 32
    _write_spans(
        spans_dir / f"{now:%Y-%m-%d-%H}.jsonl",
        [
            _span(
                name="agent_run lead",
                trace_id=trace_id,
                end_time_ns=int(now.timestamp() * 1e9),
                duration_ms=10.0,
                attributes=_cache_span_attributes(),
            )
        ],
    )
    _clear_observability_caches()

    summary = summarize(days=7)
    summary.daily_turns.append({"day": "poisoned"})
    detail = get_trace(trace_id, days=7)
    assert detail is not None
    detail.spans[0].attributes["poisoned"] = True

    assert all(day["day"] != "poisoned" for day in summarize(days=7).daily_turns)
    refreshed_detail = get_trace(trace_id, days=7)
    assert refreshed_detail is not None
    assert "poisoned" not in refreshed_detail.spans[0].attributes
