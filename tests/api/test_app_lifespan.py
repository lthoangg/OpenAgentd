from __future__ import annotations

from contextlib import asynccontextmanager
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, call

import pytest
from fastapi import FastAPI

from app.api import app as app_module


@asynccontextmanager
async def _noop_context():
    yield


async def _run_lifespan() -> FastAPI:
    app = FastAPI()
    async with app_module.lifespan(app):
        pass
    return app


@pytest.fixture
def slim_lifespan(monkeypatch: pytest.MonkeyPatch) -> Mock:
    monkeypatch.setattr(app_module.settings, "APP_ENV", "test")
    monkeypatch.setattr(app_module, "ensure_workspace_initialized", Mock())
    startup_logger = Mock()
    monkeypatch.setattr(app_module.logger, "info", startup_logger)
    monkeypatch.setattr(app_module, "setup_otel", Mock())
    monkeypatch.setattr(app_module, "start_otel_retention", Mock())
    monkeypatch.setattr(app_module, "stop_otel_retention", AsyncMock())
    monkeypatch.setattr(app_module, "shutdown_otel", Mock())
    monkeypatch.setattr(app_module.stream_store, "close", AsyncMock())
    monkeypatch.setattr(
        app_module.team_manager, "validate_agents_dir", Mock(return_value=True)
    )
    monkeypatch.setattr(app_module.team_manager, "stop", AsyncMock())
    monkeypatch.setattr(app_module.task_scheduler, "stop", AsyncMock())
    monkeypatch.setattr(app_module.mcp_manager, "stop", AsyncMock())
    # Mock refresh_model_registry to prevent network/cache access during lifespan tests
    monkeypatch.setattr("app.agent.providers.model_registry.refresh_model_registry", Mock())
    return startup_logger


@pytest.mark.asyncio
async def test_lifespan_skips_idle_startup_services(
    monkeypatch: pytest.MonkeyPatch, slim_lifespan: Mock
) -> None:
    monkeypatch.setattr(
        app_module, "load_mcp_config", Mock(return_value=SimpleNamespace(servers={}))
    )
    monkeypatch.setattr(app_module.mcp_manager, "start", AsyncMock())
    monkeypatch.setattr(
        app_module.task_scheduler, "has_enabled_tasks", AsyncMock(return_value=False)
    )
    monkeypatch.setattr(app_module.task_scheduler, "start", AsyncMock())

    await _run_lifespan()

    app_module.mcp_manager.start.assert_not_awaited()
    app_module.task_scheduler.start.assert_not_awaited()
    assert slim_lifespan.mock_calls[:2] == [
        call("server_starting version={} app_env={}", app_module.VERSION, "test"),
        call("mcp_no_servers_configured"),
    ]


@pytest.mark.asyncio
async def test_lifespan_starts_configured_services(
    monkeypatch: pytest.MonkeyPatch, slim_lifespan: Mock
) -> None:
    monkeypatch.setattr(
        app_module,
        "load_mcp_config",
        Mock(return_value=SimpleNamespace(servers={"fs": object()})),
    )
    monkeypatch.setattr(app_module.mcp_manager, "start", AsyncMock())
    monkeypatch.setattr(
        app_module.task_scheduler, "has_enabled_tasks", AsyncMock(return_value=True)
    )
    monkeypatch.setattr(app_module.task_scheduler, "start", AsyncMock())

    await _run_lifespan()

    app_module.mcp_manager.start.assert_awaited_once()
    app_module.task_scheduler.start.assert_awaited_once()
    assert slim_lifespan.mock_calls[0] == call(
        "server_starting version={} app_env={}", app_module.VERSION, "test"
    )
