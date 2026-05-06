"""Tests for app/api/routes/settings.py — sandbox deny-list endpoints."""

from __future__ import annotations

from pathlib import Path
from typing import Any
from unittest.mock import Mock, patch

import httpx
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from httpx import ASGITransport, AsyncClient

from app.agent.sandbox_config import DEFAULT_DENIED_PATTERNS
from app.api.routes import settings as settings_routes
from app.api.routes.settings import router


def _make_app() -> FastAPI:
    app = FastAPI()
    app.include_router(router, prefix="/api/settings")
    return app


class _FakePyPIResponse:
    def __init__(
        self, payload: dict[str, Any], *, json_error: ValueError | None = None
    ) -> None:
        self._payload = payload
        self._json_error = json_error

    def raise_for_status(self) -> None:
        return None

    def json(self) -> dict[str, Any]:
        if self._json_error is not None:
            raise self._json_error
        return self._payload


class _FakeAsyncClient:
    def __init__(
        self,
        *,
        response: _FakePyPIResponse | None = None,
        error: httpx.HTTPError | None = None,
    ) -> None:
        self._response = response
        self._error = error

    async def __aenter__(self) -> _FakeAsyncClient:
        return self

    async def __aexit__(self, *_args: object) -> None:
        return None

    async def get(self, _url: str) -> _FakePyPIResponse:
        if self._error is not None:
            raise self._error
        assert self._response is not None
        return self._response


async def _async_client() -> AsyncClient:
    transport = ASGITransport(app=_make_app())
    return AsyncClient(transport=transport, base_url="http://test")


def _mock_pypi(monkeypatch: pytest.MonkeyPatch, payload: dict[str, Any]) -> None:
    monkeypatch.setattr(
        settings_routes.httpx,
        "AsyncClient",
        lambda timeout: _FakeAsyncClient(response=_FakePyPIResponse(payload)),
    )


def _mock_pypi_invalid_json(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        settings_routes.httpx,
        "AsyncClient",
        lambda timeout: _FakeAsyncClient(
            response=_FakePyPIResponse({}, json_error=ValueError("bad json")),
        ),
    )


@pytest.fixture
def isolated_config(tmp_path: Path):
    """Point load_config / save_config at a tmp ``sandbox.yaml``."""
    target = tmp_path / "sandbox.yaml"
    with patch("app.agent.sandbox_config.config_path", return_value=target):
        yield target


def test_get_sandbox_returns_seed_defaults_when_file_missing(
    isolated_config: Path,
) -> None:
    client = TestClient(_make_app())
    response = client.get("/api/settings/sandbox")
    assert response.status_code == 200
    assert response.json() == {"denied_patterns": list(DEFAULT_DENIED_PATTERNS)}
    # GET must not write the file.
    assert not isolated_config.exists()


def test_put_sandbox_persists_patterns(isolated_config: Path) -> None:
    client = TestClient(_make_app())
    body = {"denied_patterns": ["**/.env", "**/secrets/**"]}
    response = client.put("/api/settings/sandbox", json=body)
    assert response.status_code == 200
    assert response.json() == body
    assert isolated_config.exists()

    # Round-trip — GET reflects what was saved.
    again = client.get("/api/settings/sandbox")
    assert again.json() == body


def test_put_sandbox_strips_blank_patterns(isolated_config: Path) -> None:
    client = TestClient(_make_app())
    response = client.put(
        "/api/settings/sandbox",
        json={"denied_patterns": ["**/.env", "", "   ", "bar/*"]},
    )
    assert response.status_code == 200
    assert response.json() == {"denied_patterns": ["**/.env", "bar/*"]}


def test_put_sandbox_rejects_unknown_field(isolated_config: Path) -> None:
    client = TestClient(_make_app())
    response = client.put(
        "/api/settings/sandbox",
        json={"denied_patterns": [], "extra_field": "nope"},
    )
    assert response.status_code == 422


@pytest.mark.asyncio
async def test_get_update_reports_new_version(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings_routes, "VERSION", "0.1.7")
    monkeypatch.setattr(settings_routes.settings, "APP_ENV", "production")
    monkeypatch.setattr(
        settings_routes.shutil, "which", lambda _name: "/usr/bin/openagentd"
    )
    _mock_pypi(monkeypatch, {"info": {"version": "0.1.8"}})

    async with await _async_client() as client:
        response = await client.get("/api/settings/update")

    assert response.status_code == 200
    assert response.json() == {
        "current_version": "0.1.7",
        "latest_version": "0.1.8",
        "update_available": True,
        "can_install": True,
        "install_blocked_reason": None,
    }


@pytest.mark.asyncio
async def test_get_update_blocks_install_without_executable(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(settings_routes, "VERSION", "0.1.7")
    monkeypatch.setattr(settings_routes.settings, "APP_ENV", "production")
    monkeypatch.setattr(settings_routes.shutil, "which", lambda _name: None)
    _mock_pypi(monkeypatch, {"info": {"version": "0.1.7"}})

    async with await _async_client() as client:
        response = await client.get("/api/settings/update")

    body = response.json()
    assert response.status_code == 200
    assert body["update_available"] is False
    assert body["can_install"] is False
    assert "executable" in body["install_blocked_reason"]


@pytest.mark.asyncio
async def test_get_update_returns_502_when_pypi_fails(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        settings_routes.httpx,
        "AsyncClient",
        lambda timeout: _FakeAsyncClient(error=httpx.ConnectError("offline")),
    )

    async with await _async_client() as client:
        response = await client.get("/api/settings/update")

    assert response.status_code == 502
    assert response.json()["detail"] == "Could not check for updates"


@pytest.mark.asyncio
async def test_get_update_returns_502_for_malformed_pypi_payload(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _mock_pypi(monkeypatch, {"info": {"version": ""}})

    async with await _async_client() as client:
        response = await client.get("/api/settings/update")

    assert response.status_code == 502
    assert response.json()["detail"] == "PyPI did not return a package version"


@pytest.mark.asyncio
async def test_get_update_returns_502_for_invalid_pypi_json(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _mock_pypi_invalid_json(monkeypatch)

    async with await _async_client() as client:
        response = await client.get("/api/settings/update")

    assert response.status_code == 502
    assert response.json()["detail"] == "PyPI did not return valid JSON"


@pytest.mark.asyncio
async def test_install_update_blocks_development_mode(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    popen = Mock()
    monkeypatch.setattr(settings_routes.settings, "APP_ENV", "development")
    monkeypatch.setattr(settings_routes.subprocess, "Popen", popen)

    async with await _async_client() as client:
        response = await client.post("/api/settings/update/install")

    assert response.status_code == 409
    assert (
        response.json()["detail"]
        == "Automatic install is only available for the installed app."
    )
    popen.assert_not_called()


@pytest.mark.asyncio
async def test_install_update_starts_background_restart(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    popen = Mock()
    monkeypatch.setattr(settings_routes.settings, "APP_ENV", "production")
    monkeypatch.setattr(
        settings_routes.shutil,
        "which",
        lambda _name: "/usr/local/bin/openagentd",
    )
    monkeypatch.setattr(settings_routes.subprocess, "Popen", popen)

    async with await _async_client() as client:
        response = await client.post("/api/settings/update/install")

    assert response.status_code == 200
    assert response.json() == {"status": "started"}
    popen.assert_called_once()
    args, kwargs = popen.call_args
    assert args[0][0:2] == ["/bin/sh", "-lc"]
    assert "/usr/local/bin/openagentd update" in args[0][2]
    assert "/usr/local/bin/openagentd stop" in args[0][2]
    assert "/usr/local/bin/openagentd start" in args[0][2]
    assert kwargs["stdout"] == settings_routes.subprocess.DEVNULL
    assert kwargs["stderr"] == settings_routes.subprocess.DEVNULL
    assert kwargs["start_new_session"] is True
