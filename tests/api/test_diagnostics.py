"""Tests for /api/diagnostics — redacted-snapshot endpoint."""

from __future__ import annotations

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api.routes.diagnostics import router


def _client() -> TestClient:
    app = FastAPI()
    app.include_router(router, prefix="/api/diagnostics")
    return TestClient(app)


def test_returns_expected_shape():
    r = _client().get("/api/diagnostics")
    assert r.status_code == 200
    body = r.json()
    for key in (
        "version",
        "runtime",
        "dirs",
        "providers",
        "env",
        "team",
        "mcp",
        "log_tail",
        "log_path",
        "error_log_path",
    ):
        assert key in body, f"missing {key}"


def test_provider_values_are_booleans():
    body = _client().get("/api/diagnostics").json()
    for name, value in body["providers"].items():
        assert isinstance(value, bool), f"{name} leaked non-bool: {value!r}"


def test_secret_envvars_are_redacted():
    """Env values whose keys contain KEY/TOKEN/SECRET/PASSWORD never leak raw."""
    body = _client().get("/api/diagnostics").json()
    for k, v in body["env"].items():
        upper = k.upper()
        if any(s in upper for s in ("KEY", "TOKEN", "SECRET", "PASSWORD")):
            assert v in ("<set>", "<empty>"), f"{k} leaked: {v!r}"


def test_tail_param_bounded():
    """Negative or huge tail values are clamped, not honoured raw."""
    r = _client().get("/api/diagnostics?tail=-99")
    assert r.status_code == 200
    assert r.json()["log_tail"] == []  # 0 lines

    r = _client().get("/api/diagnostics?tail=99999")
    assert r.status_code == 200
    # Should not blow up; tail is clamped at 2000.
    assert isinstance(r.json()["log_tail"], list)


def test_runtime_section_does_not_expose_full_environ():
    body = _client().get("/api/diagnostics").json()
    env = body["env"]
    # PATH, HOME, USER must never appear.
    for forbidden in ("PATH", "HOME", "USER", "SHELL"):
        assert forbidden not in env, f"{forbidden} leaked"


def test_log_path_present_even_when_log_missing():
    """log_path is always reported; log_tail is empty if the file is absent."""
    body = _client().get("/api/diagnostics").json()
    assert isinstance(body["log_path"], str)
    assert body["log_path"].endswith("app.log")
    assert isinstance(body["error_log_path"], str)
    assert body["error_log_path"].endswith("app-error.log")
