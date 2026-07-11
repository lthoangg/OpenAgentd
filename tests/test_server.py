"""Tests for app/server.py — the uvicorn entry point."""

from __future__ import annotations

from unittest.mock import patch

import pytest


def test_api_host_defaults_to_loopback():
    from app.core.config import Settings

    assert Settings().API_HOST == "127.0.0.1"


def test_server_module_creates_app():
    """Importing app.server produces a FastAPI application."""
    import importlib

    import app.server as server_mod

    importlib.reload(server_mod)

    from starlette.applications import Starlette

    assert server_mod.app is not None
    assert isinstance(server_mod.app, Starlette)


def test_server_main_block_calls_uvicorn_run():
    """The __main__ block invokes uvicorn.run with config values."""
    import runpy
    import sys

    # Remove cached module so runpy doesn't warn about re-executing it.
    saved = sys.modules.pop("app.server", None)
    from app.core.config import settings

    old_host = settings.API_HOST
    settings.API_HOST = "127.0.0.1"
    try:
        with patch("uvicorn.run") as mock_run:
            runpy.run_module("app.server", run_name="__main__", alter_sys=False)
    finally:
        settings.API_HOST = old_host
        if saved is not None:
            sys.modules["app.server"] = saved

    mock_run.assert_called_once_with(
        "app.server:app",
        host="127.0.0.1",
        port=settings.API_PORT,
        reload=settings.API_RELOAD,
    )


def test_server_main_refuses_non_loopback_host_without_auth(monkeypatch):
    import runpy
    import sys

    from app.core.config import settings

    monkeypatch.delenv("OPENAGENTD_DESKTOP_TOKEN", raising=False)
    monkeypatch.delenv("OPENAGENTD_ACCESS_KEY", raising=False)
    saved = sys.modules.pop("app.server", None)
    old_host = settings.API_HOST
    settings.API_HOST = "0.0.0.0"
    try:
        with (
            patch("app.server.load_runtime_settings") as runtime_settings,
            patch("uvicorn.run") as mock_run,
            pytest.raises(SystemExit, match="--key.*access key"),
        ):
            runtime_settings.return_value.server.access_key = None
            runpy.run_module("app.server", run_name="__main__", alter_sys=False)
    finally:
        settings.API_HOST = old_host
        if saved is not None:
            sys.modules["app.server"] = saved

    mock_run.assert_not_called()
