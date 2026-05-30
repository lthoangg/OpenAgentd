from __future__ import annotations

from contextlib import asynccontextmanager
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

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
def slim_lifespan(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(app_module.settings, "APP_ENV", "test")
    monkeypatch.setattr(app_module, "ensure_workspace_initialized", Mock())
    monkeypatch.setattr(app_module, "seed_wiki", Mock())
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

    dream_scheduler = SimpleNamespace(start=AsyncMock(), stop=AsyncMock())
    monkeypatch.setattr(
        app_module, "DreamScheduler", Mock(return_value=dream_scheduler)
    )
    return dream_scheduler


@pytest.mark.asyncio
async def test_lifespan_skips_idle_startup_services(
    monkeypatch: pytest.MonkeyPatch, slim_lifespan
) -> None:
    monkeypatch.setattr(
        app_module, "load_mcp_config", Mock(return_value=SimpleNamespace(servers={}))
    )
    monkeypatch.setattr(app_module.mcp_manager, "start", AsyncMock())
    monkeypatch.setattr(
        app_module.task_scheduler, "has_enabled_tasks", AsyncMock(return_value=False)
    )
    monkeypatch.setattr(app_module.task_scheduler, "start", AsyncMock())
    monkeypatch.setattr(
        app_module,
        "load_runtime_settings",
        Mock(return_value=SimpleNamespace(dream=SimpleNamespace(enabled=False))),
    )

    app = await _run_lifespan()

    app_module.mcp_manager.start.assert_not_awaited()
    app_module.task_scheduler.start.assert_not_awaited()
    slim_lifespan.start.assert_not_awaited()
    assert app.state.dream_scheduler is slim_lifespan


@pytest.mark.asyncio
async def test_lifespan_starts_configured_services(
    monkeypatch: pytest.MonkeyPatch, slim_lifespan
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
    monkeypatch.setattr(
        app_module,
        "load_runtime_settings",
        Mock(return_value=SimpleNamespace(dream=SimpleNamespace(enabled=True))),
    )

    await _run_lifespan()

    app_module.mcp_manager.start.assert_awaited_once()
    app_module.task_scheduler.start.assert_awaited_once()
    slim_lifespan.start.assert_awaited_once()
