"""Tests for app/server.py — the uvicorn entry point."""

from __future__ import annotations

from unittest.mock import patch

import pytest
from starlette.types import Message


def test_api_host_defaults_to_loopback():
    from app.core.config import Settings

    assert Settings().API_HOST == "127.0.0.1"
    assert Settings().API_ALLOW_INSECURE_LAN is False


def test_server_module_creates_app():
    """Importing app.server produces a FastAPI application."""
    import importlib

    server_mod = importlib.import_module("app.server")

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
            patch("app.server.load_server_settings") as server_settings,
            patch("uvicorn.run") as mock_run,
            pytest.raises(SystemExit, match="--key.*access key"),
        ):
            server_settings.return_value.access_key = None
            runpy.run_module("app.server", run_name="__main__", alter_sys=False)
    finally:
        settings.API_HOST = old_host
        if saved is not None:
            sys.modules["app.server"] = saved

    mock_run.assert_not_called()


def test_server_main_allows_explicit_insecure_development_lan(monkeypatch):
    import runpy
    import sys

    from app.core.config import settings

    monkeypatch.delenv("OPENAGENTD_DESKTOP_TOKEN", raising=False)
    monkeypatch.delenv("OPENAGENTD_ACCESS_KEY", raising=False)
    saved = sys.modules.pop("app.server", None)
    old_host = settings.API_HOST
    old_allow_insecure = settings.API_ALLOW_INSECURE_LAN
    settings.API_HOST = "0.0.0.0"
    settings.API_ALLOW_INSECURE_LAN = True
    try:
        with (
            patch("app.server.load_server_settings") as server_settings,
            patch("uvicorn.run") as mock_run,
        ):
            server_settings.return_value.access_key = None
            runpy.run_module("app.server", run_name="__main__", alter_sys=False)
    finally:
        settings.API_HOST = old_host
        settings.API_ALLOW_INSECURE_LAN = old_allow_insecure
        if saved is not None:
            sys.modules["app.server"] = saved

    mock_run.assert_called_once()


async def test_raw_uvicorn_non_loopback_bind_rejects_api_requests_without_auth():
    """The ASGI export does not expose APIs on an unauthenticated LAN bind."""
    from app.core.middlewares import NetworkBindGuard

    called = False
    sent: list[Message] = []

    async def app(scope, receive, send):
        nonlocal called
        called = True

    async def receive():
        return {"type": "http.disconnect"}

    async def send(message: Message):
        sent.append(message)

    await NetworkBindGuard(app, has_auth=False)(
        {"type": "http", "server": ("0.0.0.0", 4082)}, receive, send
    )

    assert called is False
    assert sent[0]["status"] == 503


async def test_non_tcp_asgi_listener_without_address_is_not_misclassified():
    from app.core.middlewares import NetworkBindGuard

    called = False
    sent: list[Message] = []

    async def app(scope, receive, send):
        nonlocal called
        called = True

    async def receive():
        return {"type": "http.disconnect"}

    async def send(message: Message):
        sent.append(message)

    await NetworkBindGuard(app, has_auth=False)({"type": "http"}, receive, send)

    assert called is True
    assert sent == []


async def test_raw_uvicorn_loopback_bind_preserves_unauthenticated_development():
    from app.core.middlewares import NetworkBindGuard

    called = False

    async def app(scope, receive, send):
        nonlocal called
        called = True

    async def receive():
        return {"type": "http.disconnect"}

    async def send(message: Message):
        pass

    await NetworkBindGuard(app, has_auth=False)(
        {"type": "http", "server": ("127.0.0.1", 4082)}, receive, send
    )

    assert called is True


async def test_raw_uvicorn_non_loopback_bind_allows_configured_authentication():
    from app.core.middlewares import NetworkBindGuard

    called = False

    async def app(scope, receive, send):
        nonlocal called
        called = True

    async def receive():
        return {"type": "http.disconnect"}

    async def send(message: Message):
        pass

    await NetworkBindGuard(app, has_auth=True)(
        {"type": "http", "server": ("0.0.0.0", 4082)}, receive, send
    )

    assert called is True


async def test_non_loopback_bind_allows_explicit_insecure_development():
    from app.core.middlewares import NetworkBindGuard

    called = False

    async def app(scope, receive, send):
        nonlocal called
        called = True

    async def receive():
        return {"type": "http.disconnect"}

    async def send(message: Message):
        pass

    await NetworkBindGuard(app, has_auth=False, allow_insecure=True)(
        {"type": "http", "server": ("0.0.0.0", 4082)}, receive, send
    )

    assert called is True
