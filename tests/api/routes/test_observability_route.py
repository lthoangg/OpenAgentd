"""Tests for app/api/routes/observability.py."""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from app.api.routes.observability import router
from app.services import observability_service


def _write_agent_run(
    tmp_path: Path,
    *,
    trace_id: str = "0x" + "1" * 32,
    run_id: str = "run-1",
) -> None:
    """Write one ``agent_run`` + ``chat`` pair into a fresh hourly file."""
    now_ns = int(datetime.now(timezone.utc).timestamp() * 1e9)
    spans_dir = tmp_path / "otel" / "spans"
    spans_dir.mkdir(parents=True, exist_ok=True)
    key = datetime.now(timezone.utc).strftime("%Y-%m-%d-%H")
    root_id = "0x" + "a" * 16
    root = {
        "name": "agent_run lead",
        "trace_id": trace_id,
        "span_id": root_id,
        "parent_id": None,
        "kind": "INTERNAL",
        "start_time": now_ns - 1_500_000_000,
        "end_time": now_ns,
        "duration_ms": 1500.0,
        "status": "OK",
        "attributes": {
            "gen_ai.agent.name": "lead",
            "gen_ai.provider.name": "openai",
            "gen_ai.request.model": "gpt-4o",
            "gen_ai.conversation.id": "sess-a",
            "run_id": run_id,
            "gen_ai.usage.input_tokens": 1000,
            "gen_ai.usage.output_tokens": 200,
        },
        "events": [],
        "resource": {"service.name": "openagentd"},
    }
    child = {
        "name": "chat gpt-4o",
        "trace_id": trace_id,
        "span_id": "0x" + "b" * 16,
        "parent_id": root_id,
        "kind": "CLIENT",
        "start_time": now_ns - 500_000_000,
        "end_time": now_ns - 100_000_000,
        "duration_ms": 400.0,
        "status": "OK",
        "attributes": {
            "gen_ai.operation.name": "chat",
            "gen_ai.provider.name": "openai",
            "gen_ai.request.model": "gpt-4o",
            "gen_ai.usage.input_tokens": 900,
            "gen_ai.usage.output_tokens": 150,
            "gen_ai.usage.cache_read.input_tokens": 300,
            "gen_ai.usage.estimated_cost_usd": 0.0035,
        },
        "events": [],
        "resource": {"service.name": "openagentd"},
    }
    with (spans_dir / f"{key}.jsonl").open("a", encoding="utf-8") as f:
        f.write(json.dumps(root) + "\n")
        f.write(json.dumps(child) + "\n")


def _make_app() -> FastAPI:
    app = FastAPI()
    app.include_router(router, prefix="/api/observability")
    return app


def test_returns_empty_payload_when_no_spans(tmp_path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(
        observability_service,
        "_spans_dir",
        lambda: tmp_path / "otel" / "spans",
    )
    client = TestClient(_make_app())
    resp = client.get("/api/observability/summary")
    assert resp.status_code == 200
    body = resp.json()
    assert body["totals"]["turns"] == 0
    assert body["daily_turns"] == []
    assert "sample_ratio" in body


def test_days_query_param_bounds(tmp_path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(
        observability_service,
        "_spans_dir",
        lambda: tmp_path / "otel" / "spans",
    )
    client = TestClient(_make_app())
    # Below min → 422
    assert client.get("/api/observability/summary?days=0").status_code == 422
    # Above max → 422
    assert client.get("/api/observability/summary?days=91").status_code == 422
    # Within range → 200
    assert client.get("/api/observability/summary?days=30").status_code == 200


# ── /traces ───────────────────────────────────────────────────────────────────


def test_traces_list_returns_empty_when_no_spans(
    tmp_path, monkeypatch: pytest.MonkeyPatch
):
    monkeypatch.setattr(
        observability_service,
        "_spans_dir",
        lambda: tmp_path / "otel" / "spans",
    )
    client = TestClient(_make_app())
    resp = client.get("/api/observability/traces")
    assert resp.status_code == 200
    body = resp.json()
    assert body == {
        "traces": [],
        "limit": 50,
        "offset": 0,
        "total": 0,
        "has_next": False,
    }


def test_traces_list_returns_turn_rows(tmp_path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(
        observability_service,
        "_spans_dir",
        lambda: tmp_path / "otel" / "spans",
    )
    _write_agent_run(tmp_path, trace_id="0x" + "1" * 32, run_id="run-1")
    client = TestClient(_make_app())

    resp = client.get("/api/observability/traces?days=7&limit=10")
    assert resp.status_code == 200
    body = resp.json()
    assert len(body["traces"]) == 1
    row = body["traces"][0]
    assert row["trace_id"] == "0x" + "1" * 32
    assert row["run_id"] == "run-1"
    assert row["agent_name"] == "lead"
    assert row["provider"] == "openai"
    assert row["model"] == "gpt-4o"
    assert row["provider_model"] == "openai:gpt-4o"
    assert row["input_tokens"] == 900
    assert row["cached_tokens"] == 300
    assert row["estimated_cost_usd"] == 0.0035
    assert row["llm_calls"] == 1
    assert row["error"] is False
    assert body["total"] == 1
    assert body["has_next"] is False


def test_traces_list_respects_query_bounds(tmp_path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(
        observability_service,
        "_spans_dir",
        lambda: tmp_path / "otel" / "spans",
    )
    client = TestClient(_make_app())
    assert client.get("/api/observability/traces?limit=0").status_code == 422
    assert client.get("/api/observability/traces?limit=201").status_code == 422
    assert client.get("/api/observability/traces?offset=-1").status_code == 422


async def test_observability_routes_offload_sync_services_to_a_thread():
    """DuckDB reads must not block FastAPI's event loop."""
    from app.api.routes import observability

    async def run_in_thread(func, /, *args, **kwargs):
        return func(*args, **kwargs)

    with patch.object(
        observability,
        "asyncio",
    ) as asyncio_mock:
        asyncio_mock.to_thread = AsyncMock(side_effect=run_in_thread)
        with (
            patch.object(
                observability,
                "summarize",
                return_value=MagicMock(to_dict=lambda: {}),
            ),
            patch.object(observability, "list_traces_with_count", return_value=([], 0)),
            patch.object(observability, "get_trace", return_value=None),
            patch.object(
                observability.ObservabilitySummaryResponse,
                "model_validate",
                return_value=object(),
            ),
            patch.object(
                observability.TraceListItemResponse,
                "model_validate",
                return_value=object(),
            ),
        ):
            await observability.summary(days=7)
            await observability.traces(days=7, limit=50, offset=0)
            with pytest.raises(HTTPException):
                await observability.trace_detail("0x1", days=30)

    assert asyncio_mock.to_thread.await_count == 3


# ── /traces/{trace_id} ────────────────────────────────────────────────────────


def test_trace_detail_returns_span_tree(tmp_path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(
        observability_service,
        "_spans_dir",
        lambda: tmp_path / "otel" / "spans",
    )
    trace = "0x" + "1" * 32
    _write_agent_run(tmp_path, trace_id=trace)
    client = TestClient(_make_app())

    resp = client.get(f"/api/observability/traces/{trace}")
    assert resp.status_code == 200
    body = resp.json()
    assert body["trace_id"] == trace
    assert len(body["spans"]) == 2
    # Spans are ordered by start_time ASC — root agent_run starts first.
    names = [s["name"] for s in body["spans"]]
    assert names == ["agent_run lead", "chat gpt-4o"]
    # Full attributes survive the round-trip
    root = next(s for s in body["spans"] if s["name"].startswith("agent_run"))
    assert root["attributes"]["gen_ai.agent.name"] == "lead"
    assert root["parent_span_id"] is None


def test_trace_detail_404_when_missing(tmp_path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(
        observability_service,
        "_spans_dir",
        lambda: tmp_path / "otel" / "spans",
    )
    _write_agent_run(tmp_path, trace_id="0x" + "1" * 32)
    client = TestClient(_make_app())

    resp = client.get("/api/observability/traces/" + "0x" + "9" * 32)
    assert resp.status_code == 404
    assert resp.json()["detail"]["reason"] == "trace_not_found"


# ── trace_id format validation ────────────────────────────────────────────────


@pytest.mark.parametrize(
    "trace_id",
    [
        "0x" + "a" * 32,  # standard OTel 128-bit hex with prefix
        "a" * 32,  # without 0x prefix
        "0x" + "A1b2" * 4,  # mixed case
        "0x1",  # short but valid hex
        "deadbeef",  # short lowercase hex
    ],
)
def test_trace_detail_accepts_valid_hex_trace_ids(
    trace_id, tmp_path, monkeypatch: pytest.MonkeyPatch
):
    """Valid hex trace IDs do not get a 422 — they get 404 (not found in empty store)."""
    monkeypatch.setattr(
        observability_service,
        "_spans_dir",
        lambda: tmp_path / "otel" / "spans",
    )
    client = TestClient(_make_app())
    resp = client.get(f"/api/observability/traces/{trace_id}")
    # Not found in empty store — important: NOT a 422 format error
    assert resp.status_code == 404


@pytest.mark.parametrize(
    "bad_id",
    [
        "not-hex",  # contains hyphens
        "0x" + "g" * 32,  # 'g' is not a hex digit
        "0x" + "a" * 65,  # too long (> 64 hex chars after 0x)
        "'; DROP TABLE spans; --",  # SQL injection attempt
    ],
)
def test_trace_detail_rejects_invalid_trace_ids(
    bad_id, tmp_path, monkeypatch: pytest.MonkeyPatch
):
    """Non-hex or malformed trace IDs return 422 before hitting the database."""
    monkeypatch.setattr(
        observability_service,
        "_spans_dir",
        lambda: tmp_path / "otel" / "spans",
    )
    client = TestClient(_make_app())
    resp = client.get(f"/api/observability/traces/{bad_id}")
    assert resp.status_code == 422, (
        f"Expected 422 for bad trace_id {bad_id!r}, got {resp.status_code}"
    )
