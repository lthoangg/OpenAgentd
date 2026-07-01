"""Tests for provider disconnect: PUT /providers/{id}/disconnect endpoint,
list_providers is_disconnected field, list_provider_models guard, and
get_registry / is_registered_model_id exclusion.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api.routes import settings as settings_routes
from app.api.routes.settings import router as settings_router


def _make_settings_app() -> FastAPI:
    app = FastAPI()
    app.include_router(settings_router, prefix="/api/settings")
    return app


def _make_agents_app() -> FastAPI:
    from app.api.routes.agents import router as agents_router

    app = FastAPI()
    app.include_router(agents_router, prefix="/api/agents")
    return app


@pytest.fixture(autouse=True)
def _reset_local_reachable_cache():
    settings_routes._local_reachable_cache.clear()
    yield
    settings_routes._local_reachable_cache.clear()


# ── PUT /providers/{id}/disconnect ───────────────────────────────────────────


class TestDisconnectEndpoint:
    def test_disconnect_returns_200_and_flag(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setattr(
            settings_routes.settings, "OPENAGENTD_CONFIG_DIR", str(tmp_path)
        )
        client = TestClient(_make_settings_app())
        response = client.put(
            "/api/settings/providers/openai/disconnect",
            json={"disconnected": True},
        )
        assert response.status_code == 200
        assert response.json() == {"provider": "openai", "is_disconnected": True}

    def test_reconnect_returns_200_and_flag_false(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setattr(
            settings_routes.settings, "OPENAGENTD_CONFIG_DIR", str(tmp_path)
        )
        client = TestClient(_make_settings_app())
        client.put(
            "/api/settings/providers/openai/disconnect", json={"disconnected": True}
        )
        response = client.put(
            "/api/settings/providers/openai/disconnect",
            json={"disconnected": False},
        )
        assert response.status_code == 200
        assert response.json() == {"provider": "openai", "is_disconnected": False}

    def test_unknown_provider_returns_404(self) -> None:
        client = TestClient(_make_settings_app())
        response = client.put(
            "/api/settings/providers/notreal/disconnect",
            json={"disconnected": True},
        )
        assert response.status_code == 404

    def test_persists_to_settings_yaml(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setattr(
            settings_routes.settings, "OPENAGENTD_CONFIG_DIR", str(tmp_path)
        )
        client = TestClient(_make_settings_app())
        client.put(
            "/api/settings/providers/openai/disconnect", json={"disconnected": True}
        )
        assert (tmp_path / "settings.yaml").exists()
        text = (tmp_path / "settings.yaml").read_text(encoding="utf-8")
        assert "is_disconnected: true" in text

    def test_missing_body_field_returns_422(self) -> None:
        client = TestClient(_make_settings_app())
        response = client.put("/api/settings/providers/openai/disconnect", json={})
        assert response.status_code == 422


# ── GET /providers — is_disconnected field ───────────────────────────────────


class TestListProvidersDisconnectedField:
    def test_field_defaults_false(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ) -> None:
        monkeypatch.setattr(
            settings_routes.settings, "OPENAGENTD_CONFIG_DIR", str(tmp_path)
        )

        async def _unreachable(_entry):  # type: ignore[no-untyped-def]
            return False

        monkeypatch.setattr(settings_routes, "_local_provider_reachable", _unreachable)

        client = TestClient(_make_settings_app())
        response = client.get("/api/settings/providers")
        assert response.status_code == 200
        for provider in response.json()["providers"]:
            assert provider["is_disconnected"] is False

    def test_field_reflects_persisted_flag(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ) -> None:
        from app.core.runtime_settings import (
            RuntimeSettings,
            save_runtime_settings,
            ProviderUiSettings,
        )

        monkeypatch.setattr(
            settings_routes.settings, "OPENAGENTD_CONFIG_DIR", str(tmp_path)
        )

        async def _unreachable(_entry):  # type: ignore[no-untyped-def]
            return False

        monkeypatch.setattr(settings_routes, "_local_provider_reachable", _unreachable)
        save_runtime_settings(
            RuntimeSettings(
                providers={"openai": ProviderUiSettings(is_disconnected=True)}
            )
        )

        client = TestClient(_make_settings_app())
        response = client.get("/api/settings/providers")
        assert response.status_code == 200
        openai = next(p for p in response.json()["providers"] if p["id"] == "openai")
        assert openai["is_disconnected"] is True


# ── POST /providers/{id}/models — disconnected guard ─────────────────────────


class TestListProviderModelsDisconnectedGuard:
    def test_returns_409_when_disconnected(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        from app.core.runtime_settings import (
            RuntimeSettings,
            save_runtime_settings,
            ProviderUiSettings,
        )

        monkeypatch.setattr(
            settings_routes.settings, "OPENAGENTD_CONFIG_DIR", str(tmp_path)
        )
        save_runtime_settings(
            RuntimeSettings(
                providers={"openai": ProviderUiSettings(is_disconnected=True)}
            )
        )

        client = TestClient(_make_settings_app())
        response = client.post(
            "/api/settings/providers/openai/models",
            json={"api_key": "", "extra": {}},
        )
        assert response.status_code == 409
        assert "disconnected" in response.json()["detail"].lower()

    def test_proceeds_when_connected(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setattr(
            settings_routes.settings, "OPENAGENTD_CONFIG_DIR", str(tmp_path)
        )

        async def _models(_entry, **_kwargs):  # type: ignore[no-untyped-def]
            return ["gpt-5"]

        monkeypatch.setattr(
            "app.agent.providers.model_discovery.discover_provider_models", _models
        )

        client = TestClient(_make_settings_app())
        response = client.post(
            "/api/settings/providers/openai/models",
            json={"api_key": "sk-test", "extra": {}},
        )
        assert response.status_code == 200
        assert response.json()["models"] == ["gpt-5"]


# ── GET /agents/registry — disconnected providers excluded ───────────────────


class TestRegistryExcludesDisconnectedProviders:
    def test_models_hidden_when_provider_disconnected(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        from app.core.runtime_settings import (
            RuntimeSettings,
            save_runtime_settings,
            ProviderUiSettings,
        )

        monkeypatch.setattr(
            settings_routes.settings, "OPENAGENTD_CONFIG_DIR", str(tmp_path)
        )
        save_runtime_settings(
            RuntimeSettings(
                providers={
                    "openai": ProviderUiSettings(
                        cached_models=["gpt-5", "gpt-5-mini"],
                        is_disconnected=True,
                    )
                }
            )
        )

        client = TestClient(_make_agents_app())
        response = client.get("/api/agents/registry")
        assert response.status_code == 200
        ids = {m["id"] for m in response.json()["models"]}
        assert "openai:gpt-5" not in ids
        assert "openai:gpt-5-mini" not in ids

    def test_models_visible_when_provider_reconnected(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        from app.core.runtime_settings import (
            RuntimeSettings,
            save_runtime_settings,
            ProviderUiSettings,
        )

        monkeypatch.setattr(
            settings_routes.settings, "OPENAGENTD_CONFIG_DIR", str(tmp_path)
        )
        save_runtime_settings(
            RuntimeSettings(
                providers={
                    "openai": ProviderUiSettings(
                        cached_models=["gpt-5"],
                        is_disconnected=False,
                    )
                }
            )
        )

        client = TestClient(_make_agents_app())
        response = client.get("/api/agents/registry")
        assert response.status_code == 200
        ids = {m["id"] for m in response.json()["models"]}
        assert "openai:gpt-5" in ids

    def test_only_disconnected_provider_excluded_others_intact(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        from app.core.runtime_settings import (
            RuntimeSettings,
            save_runtime_settings,
            ProviderUiSettings,
        )

        monkeypatch.setattr(
            settings_routes.settings, "OPENAGENTD_CONFIG_DIR", str(tmp_path)
        )
        save_runtime_settings(
            RuntimeSettings(
                providers={
                    "openai": ProviderUiSettings(
                        cached_models=["gpt-5"], is_disconnected=True
                    ),
                    "anthropic": ProviderUiSettings(
                        cached_models=["claude-opus-4-5"], is_disconnected=False
                    ),
                }
            )
        )

        client = TestClient(_make_agents_app())
        response = client.get("/api/agents/registry")
        assert response.status_code == 200
        ids = {m["id"] for m in response.json()["models"]}
        assert "openai:gpt-5" not in ids
        assert "anthropic:claude-opus-4-5" in ids

    def test_warm_cache_skips_disconnected_provider(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """_warm_provider_model_cache must not auto-discover for disconnected providers."""
        from app.core.runtime_settings import (
            RuntimeSettings,
            save_runtime_settings,
            ProviderUiSettings,
        )

        monkeypatch.setattr(
            settings_routes.settings, "OPENAGENTD_CONFIG_DIR", str(tmp_path)
        )
        monkeypatch.setenv("OPENAI_API_KEY", "test-key")
        save_runtime_settings(
            RuntimeSettings(
                providers={"openai": ProviderUiSettings(is_disconnected=True)}
            )
        )

        discovered: list[str] = []

        async def _spy(_entry, **_kwargs):  # type: ignore[no-untyped-def]
            discovered.append(_entry["id"])
            return ["gpt-5"]

        monkeypatch.setattr(
            "app.agent.providers.model_discovery.discover_provider_models", _spy
        )

        client = TestClient(_make_agents_app())
        client.get("/api/agents/registry")

        assert "openai" not in discovered


# ── is_registered_model_id — disconnected provider ───────────────────────────


class TestIsRegisteredModelId:
    async def test_returns_false_for_disconnected_provider(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        from app.api.routes.agents import is_registered_model_id
        from app.core.runtime_settings import (
            RuntimeSettings,
            ProviderUiSettings,
            save_runtime_settings,
        )

        monkeypatch.setattr(
            settings_routes.settings, "OPENAGENTD_CONFIG_DIR", str(tmp_path)
        )
        save_runtime_settings(
            RuntimeSettings(
                providers={
                    "openai": ProviderUiSettings(
                        cached_models=["gpt-5"], is_disconnected=True
                    )
                }
            )
        )

        assert await is_registered_model_id("openai:gpt-5") is False

    async def test_returns_true_when_provider_connected(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        from app.api.routes.agents import is_registered_model_id
        from app.core.runtime_settings import (
            RuntimeSettings,
            ProviderUiSettings,
            save_runtime_settings,
        )

        monkeypatch.setattr(
            settings_routes.settings, "OPENAGENTD_CONFIG_DIR", str(tmp_path)
        )
        save_runtime_settings(
            RuntimeSettings(
                providers={
                    "openai": ProviderUiSettings(
                        cached_models=["gpt-5"], is_disconnected=False
                    )
                }
            )
        )

        assert await is_registered_model_id("openai:gpt-5") is True
