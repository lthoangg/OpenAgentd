"""Model state for providers that lost their connection, or lost a model.

Covers two ways a cached model list goes stale: the provider is no longer
connected (its cached and visible models are dropped) and the provider dropped
one model from its live list (the retired id is pruned from both lists).
"""

from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import AsyncMock

import httpx
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api.routes import settings as settings_routes
from app.api.routes.agents import is_registered_model_id, router as agents_router
from app.api.routes.settings import router as settings_router
from app.core.runtime_settings import (
    ProviderUiSettings,
    RuntimeSettings,
    load_runtime_settings,
    save_runtime_settings,
)


def _make_agents_app() -> FastAPI:
    app = FastAPI()
    app.include_router(agents_router, prefix="/api/agents")
    return app


def _make_settings_app() -> FastAPI:
    app = FastAPI()
    app.include_router(settings_router, prefix="/api/settings")
    return app


def test_registry_clears_cached_models_when_provider_not_configured(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """When a provider has cached models but is not configured (e.g. oauth expired / no key),
    get_registry must clear the cached models from settings and exclude them from the catalog."""
    monkeypatch.setattr(
        settings_routes.settings, "OPENAGENTD_CONFIG_DIR", str(tmp_path)
    )
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)

    save_runtime_settings(
        RuntimeSettings(
            providers={
                "openai": ProviderUiSettings(cached_models=["gpt-5", "gpt-5-mini"])
            }
        )
    )

    client = TestClient(_make_agents_app())
    response = client.get("/api/agents/registry")
    assert response.status_code == 200

    ids = {m["id"] for m in response.json()["models"]}
    assert "openai:gpt-5" not in ids
    assert "openai:gpt-5-mini" not in ids

    # Runtime settings must no longer cache those models
    cfg = load_runtime_settings()
    assert cfg.providers.get("openai", ProviderUiSettings()).cached_models == []


@pytest.mark.asyncio
async def test_is_registered_model_id_clears_cached_models_when_unconfigured(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(
        settings_routes.settings, "OPENAGENTD_CONFIG_DIR", str(tmp_path)
    )
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)

    save_runtime_settings(
        RuntimeSettings(
            providers={"openai": ProviderUiSettings(cached_models=["gpt-5"])}
        )
    )

    assert await is_registered_model_id("openai:gpt-5") is False
    cfg = load_runtime_settings()
    assert cfg.providers.get("openai", ProviderUiSettings()).cached_models == []


def test_list_providers_clears_cached_models_when_unconfigured(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(
        settings_routes.settings, "OPENAGENTD_CONFIG_DIR", str(tmp_path)
    )
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)

    save_runtime_settings(
        RuntimeSettings(
            providers={"openai": ProviderUiSettings(cached_models=["gpt-5"])}
        )
    )

    client = TestClient(_make_settings_app())
    response = client.get("/api/settings/providers")
    assert response.status_code == 200

    providers = {p["id"]: p for p in response.json()["providers"]}
    assert providers["openai"]["cached_models"] == []

    cfg = load_runtime_settings()
    assert cfg.providers.get("openai", ProviderUiSettings()).cached_models == []


def test_list_provider_models_prunes_model_retired_by_provider(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A refresh that no longer returns a cached model must drop it from both
    the cached list and the visible selection."""
    monkeypatch.setattr(
        settings_routes.settings, "OPENAGENTD_CONFIG_DIR", str(tmp_path)
    )
    monkeypatch.setenv("DEEPSEEK_API_KEY", "test-key")

    save_runtime_settings(
        RuntimeSettings(
            providers={
                "deepseek": ProviderUiSettings(
                    cached_models=["deepseek-v4-flash", "deepseek-v4-pro"],
                    visible_models=["deepseek-v4-flash"],
                )
            }
        )
    )

    monkeypatch.setattr(
        "app.agent.providers.model_discovery.discover_provider_models",
        AsyncMock(return_value=["deepseek-v4-pro"]),
    )

    client = TestClient(_make_settings_app())
    response = client.post(
        "/api/settings/providers/deepseek/models",
        json={"api_key": "", "extra": {}},
    )
    assert response.status_code == 200
    assert response.json()["models"] == ["deepseek-v4-pro"]

    cfg = load_runtime_settings()
    ui = cfg.providers["deepseek"]
    assert ui.cached_models == ["deepseek-v4-pro"]
    assert ui.visible_models == []


def test_disconnected_provider_drops_cached_and_visible_models(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A provider with no live credentials must lose both the cached list and
    the visible selection -- the selection would otherwise whitelist model ids
    the provider can no longer serve."""
    monkeypatch.setattr(
        settings_routes.settings, "OPENAGENTD_CONFIG_DIR", str(tmp_path)
    )
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)

    save_runtime_settings(
        RuntimeSettings(
            providers={
                "openai": ProviderUiSettings(
                    cached_models=["gpt-5", "gpt-5-mini"],
                    visible_models=["gpt-5"],
                )
            }
        )
    )

    client = TestClient(_make_agents_app())
    response = client.get("/api/agents/registry")
    assert response.status_code == 200
    assert "openai:gpt-5" not in {m["id"] for m in response.json()["models"]}

    cfg = load_runtime_settings()
    ui = cfg.providers.get("openai", ProviderUiSettings())
    assert ui.cached_models == []
    assert ui.visible_models == []


def test_oauth_refresh_failure_unlinks_credentials_and_clears_cached_models(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from app.agent.providers.codex.oauth import CodexOAuth

    monkeypatch.setattr(
        settings_routes.settings, "OPENAGENTD_CONFIG_DIR", str(tmp_path)
    )
    monkeypatch.setattr(settings_routes.settings, "OPENAGENTD_CACHE_DIR", str(tmp_path))

    save_runtime_settings(
        RuntimeSettings(
            providers={
                "codex": ProviderUiSettings(
                    cached_models=["gpt-5.4"],
                    visible_models=["gpt-5.4"],
                )
            }
        )
    )

    token_path = tmp_path / "codex_oauth.json"
    token_path.write_text(
        json.dumps(
            {
                "access_token": "expired_tok",
                "refresh_token": "expired_ref",
                "expires_at": 1000.0,
                "account_id": None,
            }
        )
    )
    oauth = CodexOAuth.load(token_path)
    assert oauth is not None

    def mock_refresh_error(refresh_token: str):
        request = httpx.Request("POST", "https://auth.openai.com/oauth/token")
        response = httpx.Response(400, request=request, json={"error": "invalid_grant"})
        raise httpx.HTTPStatusError("invalid_grant", request=request, response=response)

    monkeypatch.setattr(
        "app.agent.providers.codex.oauth._refresh_access_token", mock_refresh_error
    )

    with pytest.raises(httpx.HTTPStatusError):
        oauth.refresh(token_path)

    # Dead credentials are removed and the provider's model state is forgotten
    assert not token_path.exists()
    cfg = load_runtime_settings()
    ui = cfg.providers.get("codex", ProviderUiSettings())
    assert ui.cached_models == []
    assert ui.visible_models == []
