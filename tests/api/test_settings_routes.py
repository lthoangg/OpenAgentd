"""Tests for app/api/routes/settings.py — sandbox deny-list endpoints."""

from __future__ import annotations

from pathlib import Path
from unittest.mock import Mock, patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from pydantic import SecretStr

from app.agent.sandbox_config import DEFAULT_DENIED_PATTERNS
from app.cli.seed import SeedDownloadError, SeedResult
from app.api.routes import settings as settings_routes
from app.api.routes.settings import router
from app.agent.providers.codex.oauth import CodexOAuth
from app.agent.providers.copilot.oauth import CopilotOAuth
from app.agent.providers.codex import usage as codex_usage
from app.agent.providers.copilot import usage as copilot_usage


def _make_app() -> FastAPI:
    app = FastAPI()
    app.include_router(router, prefix="/api/settings")
    return app


@pytest.fixture
def isolated_config(tmp_path: Path):
    """Point load_config / save_config at a tmp ``sandbox.yaml``."""
    target = tmp_path / "sandbox.yaml"
    with patch("app.agent.sandbox_config.config_path", return_value=target):
        yield target


@pytest.fixture(autouse=True)
def _reset_local_reachable_cache(monkeypatch: pytest.MonkeyPatch):
    """Clear daemon-reachability cache and avoid live model discovery in tests.

    The cache is module-level state; without resetting it a test that
    happens to ping a daemon successfully (or hit a cached failure)
    would leak that result into unrelated tests. Provider listing also
    checks live model discovery before showing Connected; default that
    probe to a deterministic success so focused tests can opt into
    fallback/unreachable states explicitly.
    """

    async def _available(_entry, **_kwargs):  # type: ignore[no-untyped-def]
        return ["test-model"]

    settings_routes._local_reachable_cache.clear()
    monkeypatch.setattr(
        "app.agent.providers.model_discovery.discover_provider_models", _available
    )
    yield
    settings_routes._local_reachable_cache.clear()


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


# ── Updates removed ─────────────────────────────────────────────────────────
#
# The PyPI-backed self-update endpoints were removed when the desktop bundle
# switched to ``tauri-plugin-updater`` and CLI users were pointed at
# ``openagentd upgrade`` directly. These tests guard against an accidental
# revert that would re-expose the in-process restart shell script.


@pytest.mark.parametrize(
    ("method", "path"),
    [
        ("GET", "/api/settings/update"),
        ("POST", "/api/settings/update/install"),
        # Variants that would exist if someone restored the old code under
        # a slightly different shape — catch the obvious near-misses too.
        ("GET", "/api/settings/updates"),
        ("POST", "/api/settings/updates/install"),
    ],
)
def test_update_endpoints_removed(method: str, path: str) -> None:
    client = TestClient(_make_app())
    response = client.request(method, path)
    assert response.status_code == 404, (
        f"{method} {path} should not exist; got {response.status_code}. "
        "Desktop uses tauri-plugin-updater; CLI uses `openagentd upgrade`."
    )


def test_settings_router_has_no_update_routes() -> None:
    """Inspect registered routes directly so route names also can't drift back."""
    from app.api.routes.settings import router as settings_router

    for route in settings_router.routes:
        path = getattr(route, "path", "")
        assert "update" not in path.lower(), (
            f"Settings router exposes an update-related path: {path}"
        )


def test_update_install_helpers_not_importable() -> None:
    """The shell-spawning restart helpers must not silently come back."""
    from app.api.routes import settings as settings_routes

    for symbol in (
        "_self_terminate_after_response",
        "_install_blocked_reason",
        "_version_key",
        "_PYPI_JSON_URL",
        "install_update",
        "get_update_status",
    ):
        assert not hasattr(settings_routes, symbol), (
            f"`{symbol}` was reintroduced; that path is no longer supported."
        )


# ── Providers (Settings → Providers tab) ────────────────────────────────────


def test_list_providers_returns_catalog(monkeypatch: pytest.MonkeyPatch) -> None:
    """GET /providers returns one entry per catalog row with config state."""
    # Clear every known credential env var so the test is deterministic
    # regardless of the developer's local ``.env``.
    from app.agent.providers.catalog import PROVIDER_KEY_VAR, all_providers

    for var in PROVIDER_KEY_VAR.values():
        monkeypatch.delenv(var, raising=False)
    for entry in all_providers():
        for var in entry.get("env_vars", ()):
            monkeypatch.delenv(var, raising=False)

    # Stub the daemon probe so this test doesn't depend on whether
    # Ollama happens to be running on the developer's machine.
    async def _unreachable(_entry):  # type: ignore[no-untyped-def]
        return False

    monkeypatch.setattr(settings_routes, "_local_provider_reachable", _unreachable)

    app = _make_app()
    client = TestClient(app)
    response = client.get("/api/settings/providers")
    assert response.status_code == 200
    data = response.json()
    assert isinstance(data["providers"], list)
    assert len(data["providers"]) > 5  # we ship many
    ids = {p["id"] for p in data["providers"]}
    assert {"googlegenai", "openai", "openrouter", "copilot", "codex"} <= ids
    # Nothing configured → has_any_configured is exactly False.
    assert data["has_any_configured"] is False


def test_list_providers_marks_configured_when_env_var_set(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """An env var with a value flips is_configured to True."""
    monkeypatch.setenv("GOOGLE_API_KEY", "test-key-not-real")

    app = _make_app()
    client = TestClient(app)
    response = client.get("/api/settings/providers")
    assert response.status_code == 200
    data = response.json()
    google = next(p for p in data["providers"] if p["id"] == "googlegenai")
    assert google["is_configured"] is True
    assert google["cached_models"] == []
    assert data["has_any_configured"] is True


def test_list_providers_ollama_not_configured_when_daemon_unreachable(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """`kind="local"` providers must not show as Connected unless the daemon answers."""

    async def _unreachable(_entry):  # type: ignore[no-untyped-def]
        return False

    monkeypatch.setattr(settings_routes, "_local_provider_reachable", _unreachable)

    app = _make_app()
    client = TestClient(app)
    response = client.get("/api/settings/providers")

    assert response.status_code == 200
    ollama = next(p for p in response.json()["providers"] if p["id"] == "ollama")
    assert ollama["is_configured"] is False


def test_list_providers_ollama_configured_when_daemon_reachable(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """When the probe succeeds, Ollama shows as Connected."""

    async def _reachable(_entry):  # type: ignore[no-untyped-def]
        return True

    monkeypatch.setattr(settings_routes, "_local_provider_reachable", _reachable)

    app = _make_app()
    client = TestClient(app)
    response = client.get("/api/settings/providers")

    assert response.status_code == 200
    ollama = next(p for p in response.json()["providers"] if p["id"] == "ollama")
    assert ollama["is_configured"] is True


def test_list_providers_router9_requires_both_env_var_and_daemon(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Local-proxy api_key providers need both a key AND a reachable daemon."""
    monkeypatch.delenv("ROUTER9_API_KEY", raising=False)

    probed: list[str] = []

    async def _spy(entry):  # type: ignore[no-untyped-def]
        probed.append(entry["id"])
        return True

    monkeypatch.setattr(settings_routes, "_local_provider_reachable", _spy)

    app = _make_app()
    client = TestClient(app)
    response = client.get("/api/settings/providers")

    assert response.status_code == 200
    router9 = next(p for p in response.json()["providers"] if p["id"] == "router9")
    # No env var → still not connected, and we never bothered to probe.
    assert router9["is_configured"] is False
    assert "router9" not in probed


def test_list_providers_marks_oauth_file_configured(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """OAuth providers persist token files directly under CACHE_DIR."""
    monkeypatch.setattr(settings_routes.settings, "OPENAGENTD_CACHE_DIR", str(tmp_path))
    (tmp_path / "codex_oauth.json").write_text("{}", encoding="utf-8")

    app = _make_app()
    client = TestClient(app)
    response = client.get("/api/settings/providers")

    assert response.status_code == 200
    data = response.json()
    codex = next(p for p in data["providers"] if p["id"] == "codex")
    copilot = next(p for p in data["providers"] if p["id"] == "copilot")
    assert codex["is_configured"] is True
    assert copilot["is_configured"] is False


def test_test_provider_returns_404_for_unknown(monkeypatch: pytest.MonkeyPatch) -> None:
    app = _make_app()
    client = TestClient(app)
    response = client.post(
        "/api/settings/providers/notreal/test",
        json={"api_key": "x", "model": "y"},
    )
    assert response.status_code == 404


def test_test_provider_reports_failure_without_crashing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Provider chat error → 200 OK with ok=False rather than 500.

    The test endpoint catches every exception so the UI never has to
    distinguish "the test API itself broke" from "your key is wrong."
    """

    # Force a deterministic failure by stubbing build_provider — real
    # provider chat() behaviour varies by SDK version and would make this
    # test flaky against the live network.
    def _explode(*_args: object, **_kwargs: object) -> None:
        raise ValueError("synthetic auth failure")

    monkeypatch.setattr(settings_routes, "build_provider", None, raising=False)
    monkeypatch.setattr(
        "app.agent.providers.factory.build_provider", _explode, raising=True
    )

    app = _make_app()
    client = TestClient(app)
    response = client.post(
        "/api/settings/providers/googlegenai/test",
        json={"api_key": "ignored-because-stub", "model": "gemini-3-flash-preview"},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["ok"] is False
    assert "synthetic auth failure" in (body["error"] or "")


def test_save_provider_writes_env_and_mutates_environ(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """PUT /providers/{id} persists creds and mirrors them into os.environ."""
    # Redirect CONFIG_DIR to a temp dir so the test doesn't touch real config.
    monkeypatch.setattr(
        settings_routes.settings, "OPENAGENTD_CONFIG_DIR", str(tmp_path)
    )
    monkeypatch.delenv("GOOGLE_API_KEY", raising=False)

    app = _make_app()
    client = TestClient(app)
    response = client.put(
        "/api/settings/providers/googlegenai",
        json={"api_key": "fresh-key-123"},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["saved"] is True
    assert body["is_first_provider"] is True

    # .env should now contain the key.
    env_text = (tmp_path / ".env").read_text(encoding="utf-8")
    assert "GOOGLE_API_KEY=fresh-key-123" in env_text

    # os.environ should be mutated so the next build_provider call works
    # without restarting the server.
    import os

    assert os.environ.get("GOOGLE_API_KEY") == "fresh-key-123"

    # A second save flips is_first_provider to False — the user is past
    # the initial setup so the frontend shouldn't trigger seed install
    # again.
    response2 = client.put(
        "/api/settings/providers/googlegenai",
        json={"api_key": "another-key"},
    )
    assert response2.status_code == 200
    assert response2.json()["is_first_provider"] is False


def test_save_provider_persists_base_url_extra(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Daemon providers can set an optional base URL via ``extra``.

    The value is written to ``.env`` alongside the API key and mirrored
    into ``os.environ`` so the next discovery call picks it up without a
    server restart. Clearing the field (empty string) deletes the line.
    """
    monkeypatch.setattr(
        settings_routes.settings, "OPENAGENTD_CONFIG_DIR", str(tmp_path)
    )
    monkeypatch.delenv("ROUTER9_API_KEY", raising=False)
    monkeypatch.delenv("ROUTER9_BASE_URL", raising=False)

    app = _make_app()
    client = TestClient(app)
    response = client.put(
        "/api/settings/providers/router9",
        json={
            "api_key": "rk-123",
            "extra": {"ROUTER9_BASE_URL": "http://10.0.0.5:20128/v1"},
        },
    )
    assert response.status_code == 200
    assert response.json()["saved"] is True

    env_text = (tmp_path / ".env").read_text(encoding="utf-8")
    assert "ROUTER9_API_KEY=rk-123" in env_text
    assert "ROUTER9_BASE_URL=http://10.0.0.5:20128/v1" in env_text

    import os

    assert os.environ.get("ROUTER9_BASE_URL") == "http://10.0.0.5:20128/v1"

    # Clearing the base URL on a subsequent save removes the line from
    # ``.env`` and pops the env var.
    response2 = client.put(
        "/api/settings/providers/router9",
        json={"api_key": "rk-123", "extra": {"ROUTER9_BASE_URL": ""}},
    )
    assert response2.status_code == 200
    env_text2 = (tmp_path / ".env").read_text(encoding="utf-8")
    assert "ROUTER9_BASE_URL" not in env_text2
    assert os.environ.get("ROUTER9_BASE_URL") is None


def test_save_provider_supports_plugin_credentials(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Plugin providers persist declared credential fields, including extras."""
    from app.agent.providers.plugin_registry import clear_provider_plugin_cache

    plugin_dir = tmp_path / "plugins"
    plugin_dir.mkdir()
    (plugin_dir / "sample_provider.py").write_text(
        """
from app.agent.providers.base import LLMProviderBase
from app.agent.providers.plugin_api import ProviderPlugin, ProviderCredentialField

class DummyProvider(LLMProviderBase):
    async def chat(self, messages, tools=None, **kwargs):
        raise AssertionError('not used')
    async def stream(self, messages, tools=None, **kwargs):
        if False:
            yield None

provider = ProviderPlugin(
    id='sample',
    label='Sample',
    description='Synthetic provider.',
    kind='api_key',
    credentials=[
        ProviderCredentialField(name='SAMPLE_KEY', label='Sample key'),
        ProviderCredentialField(name='SAMPLE_BASE_URL', label='Base URL', secret=False, required=False),
    ],
    factory=lambda ctx: DummyProvider(),
)
""".lstrip(),
        encoding="utf-8",
    )
    monkeypatch.setattr(
        settings_routes.settings, "OPENAGENTD_CONFIG_DIR", str(tmp_path)
    )
    monkeypatch.setattr(
        settings_routes.settings, "OPENAGENTD_PLUGINS_DIRS", str(plugin_dir)
    )
    monkeypatch.delenv("SAMPLE_KEY", raising=False)
    monkeypatch.delenv("SAMPLE_BASE_URL", raising=False)
    clear_provider_plugin_cache()

    try:
        client = TestClient(_make_app())
        response = client.put(
            "/api/settings/providers/sample",
            json={
                "api_key": "sk-test",
                "extra": {"SAMPLE_BASE_URL": "https://local.test/v1"},
            },
        )

        assert response.status_code == 200
        assert response.json()["saved"] is True
        env_text = (tmp_path / ".env").read_text(encoding="utf-8")
        assert "SAMPLE_KEY=sk-test" in env_text
        assert "SAMPLE_BASE_URL=https://local.test/v1" in env_text

        listed = client.get("/api/settings/providers")
        sample = next(p for p in listed.json()["providers"] if p["id"] == "sample")
        assert sample["is_configured"] is True
        assert [field["name"] for field in sample["credentials"]] == [
            "SAMPLE_KEY",
            "SAMPLE_BASE_URL",
        ]
    finally:
        clear_provider_plugin_cache()


def test_save_provider_404_for_unknown(monkeypatch: pytest.MonkeyPatch) -> None:
    app = _make_app()
    client = TestClient(app)
    response = client.put(
        "/api/settings/providers/notreal",
        json={"api_key": "x"},
    )
    assert response.status_code == 404


def test_install_seed_defaults_calls_seed_installer(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(
        settings_routes.settings, "OPENAGENTD_CONFIG_DIR", str(tmp_path)
    )
    install_seed = Mock(
        return_value=SeedResult(
            agents_written=["openagentd.md"],
            skills_written=["self-healing"],
            configs_written=["mcp.json"],
            agents_removed=["consultant.md"],
            source="local",
        )
    )
    monkeypatch.setattr("app.cli.seed.install_seed", install_seed)

    app = _make_app()
    client = TestClient(app)
    response = client.post(
        "/api/settings/seed",
        json={"provider_model": "googlegenai:gemini-3-flash-preview"},
    )

    assert response.status_code == 200
    assert response.json() == {
        "agents_written": ["openagentd.md"],
        "skills_written": ["self-healing"],
        "configs_written": ["mcp.json"],
        "agents_removed": ["consultant.md"],
        "source": "local",
    }
    install_seed.assert_called_once_with(
        tmp_path, provider_model="googlegenai:gemini-3-flash-preview"
    )


def test_install_seed_defaults_reports_download_failure(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(
        settings_routes.settings, "OPENAGENTD_CONFIG_DIR", str(tmp_path)
    )

    def _fail(*_args: object, **_kwargs: object) -> None:
        raise SeedDownloadError("offline")

    monkeypatch.setattr("app.cli.seed.install_seed", _fail)

    app = _make_app()
    client = TestClient(app)
    response = client.post(
        "/api/settings/seed",
        json={"provider_model": "googlegenai:gemini-3-flash-preview"},
    )

    assert response.status_code == 502
    assert response.json()["detail"] == "offline"


@pytest.mark.parametrize("body", [{}, {"provider_model": None}, {"provider_model": ""}])
def test_install_seed_defaults_accepts_empty_model(
    body: dict[str, str | None], tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(
        settings_routes.settings, "OPENAGENTD_CONFIG_DIR", str(tmp_path)
    )
    install_seed = Mock(
        return_value=SeedResult(
            agents_written=[],
            skills_written=[],
            configs_written=[],
            agents_removed=[],
            source="local",
        )
    )
    monkeypatch.setattr("app.cli.seed.install_seed", install_seed)

    app = _make_app()
    client = TestClient(app)
    response = client.post("/api/settings/seed", json=body)

    assert response.status_code == 200
    install_seed.assert_called_once_with(tmp_path, provider_model="__PROVIDER_MODEL__")


def test_install_seed_defaults_rejects_invalid_model() -> None:
    app = _make_app()
    client = TestClient(app)
    response = client.post("/api/settings/seed", json={"provider_model": "gpt-5"})

    assert response.status_code == 422


def test_title_generation_settings_roundtrip(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(
        settings_routes.settings, "OPENAGENTD_CONFIG_DIR", str(tmp_path)
    )

    app = _make_app()
    client = TestClient(app)

    response = client.put(
        "/api/settings/title-generation",
        json={
            "enabled": False,
            "model": "codex:gpt-5.5-mini",
            "wait_timeout_seconds": 0,
        },
    )

    assert response.status_code == 200
    assert response.json() == {
        "enabled": False,
        "model": "codex:gpt-5.5-mini",
        "wait_timeout_seconds": 0.0,
    }
    assert (tmp_path / "settings.yaml").is_file()

    read_response = client.get("/api/settings/title-generation")

    assert read_response.status_code == 200
    assert read_response.json() == response.json()


# ── Daemon reachability probe ───────────────────────────────────────────────


def test_local_provider_reachable_uses_cache(monkeypatch: pytest.MonkeyPatch) -> None:
    """Two probes within the TTL hit the cache instead of re-issuing HTTP."""
    import asyncio

    from app.agent.providers.catalog import find

    entry = find("ollama")
    assert entry is not None

    call_count = 0

    class _FakeResponse:
        status_code = 200

    class _FakeClient:
        def __init__(self, *_args, **_kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

        async def get(self, _url):
            nonlocal call_count
            call_count += 1
            return _FakeResponse()

    monkeypatch.setattr(settings_routes.httpx, "AsyncClient", _FakeClient)
    monkeypatch.setattr(settings_routes.settings, "OLLAMA_BASE_URL", "http://x:1")

    first = asyncio.get_event_loop().run_until_complete(
        settings_routes._local_provider_reachable(entry)
    )
    second = asyncio.get_event_loop().run_until_complete(
        settings_routes._local_provider_reachable(entry)
    )
    assert first is True
    assert second is True
    assert call_count == 1


def test_local_provider_reachable_swallows_errors(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Connection refused / timeout → False (no exception bubbles up)."""
    import asyncio

    import httpx

    from app.agent.providers.catalog import find

    entry = find("ollama")
    assert entry is not None

    class _BoomClient:
        def __init__(self, *_args, **_kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

        async def get(self, _url):
            raise httpx.ConnectError("daemon down")

    monkeypatch.setattr(settings_routes.httpx, "AsyncClient", _BoomClient)
    monkeypatch.setattr(settings_routes.settings, "OLLAMA_BASE_URL", "http://x:1")

    result = asyncio.get_event_loop().run_until_complete(
        settings_routes._local_provider_reachable(entry)
    )
    assert result is False


# ── POST /providers/{id}/models ─────────────────────────────────────────────


def test_list_provider_models_returns_404_for_unknown() -> None:
    app = _make_app()
    client = TestClient(app)
    response = client.post(
        "/api/settings/providers/notreal/models",
        json={"api_key": "x"},
    )
    assert response.status_code == 404


def test_list_provider_models_returns_empty_when_discovery_fails(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The settings model-list endpoint should not mask failed live discovery
    with curated fallback models.
    """

    async def _empty(_entry, **_kwargs):  # type: ignore[no-untyped-def]
        return []

    monkeypatch.setattr(
        "app.agent.providers.model_discovery.discover_provider_models", _empty
    )

    app = _make_app()
    client = TestClient(app)
    response = client.post(
        "/api/settings/providers/vertexai/models",
        json={"extra": {"VERTEXAI_API_KEY": "bad-key"}},
    )

    assert response.status_code == 200
    body = response.json()
    assert body["source"] == "provider"
    assert body["models"] == []


def test_list_provider_models_returns_discovered_models(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """When discovery succeeds, response carries source='provider' with a flat
    list of model IDs (no per-model capability data — see techdebts/model-
    capabilities-registry.md for why)."""

    async def _two_models(_entry, **_kwargs):  # type: ignore[no-untyped-def]
        return ["model-a", "model-b"]

    monkeypatch.setattr(
        "app.agent.providers.model_discovery.discover_provider_models", _two_models
    )

    app = _make_app()
    client = TestClient(app)
    response = client.post(
        "/api/settings/providers/openai/models",
        json={"api_key": "fake"},
    )

    assert response.status_code == 200
    body = response.json()
    assert body["provider"] == "openai"
    assert body["source"] == "provider"
    assert body["models"] == ["model-a", "model-b"]


def test_list_provider_models_filters_non_agent_models(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def _mixed_models(_entry, **_kwargs):  # type: ignore[no-untyped-def]
        return [
            "gemini-3.5-flash",
            "davinci-002",
            "gpt-audio-mini",
            "veo-3.1-generate-preview",
            "imagen-4",
            "lyria-002",
            "nano-banana",
            "sora-2",
            "gemini-3.1-flash-image-preview",
            "text-embedding-3-small",
        ]

    monkeypatch.setattr(
        "app.agent.providers.model_discovery.discover_provider_models", _mixed_models
    )

    app = _make_app()
    client = TestClient(app)
    response = client.post(
        "/api/settings/providers/googlegenai/models",
        json={"api_key": "fake"},
    )

    assert response.status_code == 200
    body = response.json()
    assert body["source"] == "provider"
    assert body["models"] == ["gemini-3.5-flash"]


def test_list_provider_models_does_not_mutate_os_environ(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The /models endpoint must thread credentials via overrides, not env."""
    import os

    sentinel = "PROBE_ENV_VALUE_BEFORE_REQUEST"
    monkeypatch.setenv("OPENAI_API_KEY", sentinel)

    captured: dict[str, object] = {}

    async def _spy(_entry, **kwargs):  # type: ignore[no-untyped-def]
        captured["overrides"] = kwargs.get("overrides")
        captured["env_during"] = os.environ.get("OPENAI_API_KEY")
        return []

    monkeypatch.setattr(
        "app.agent.providers.model_discovery.discover_provider_models", _spy
    )

    app = _make_app()
    client = TestClient(app)
    response = client.post(
        "/api/settings/providers/openai/models",
        json={"api_key": "candidate-key"},
    )

    assert response.status_code == 200
    # os.environ stayed untouched — only the overrides dict carried the key.
    assert os.environ.get("OPENAI_API_KEY") == sentinel
    assert captured["env_during"] == sentinel
    assert captured["overrides"] == {"OPENAI_API_KEY": "candidate-key"}


def test_get_codex_provider_usage_returns_active_limits(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import time

    oauth = CodexOAuth(
        access_token=SecretStr("chatgpt-token"),
        refresh_token=SecretStr("refresh-token"),
        expires_at=time.time() + 3600,
        account_id="account-123",
    )
    monkeypatch.setattr(
        "app.agent.providers.codex.oauth.CodexOAuth.load", lambda: oauth
    )

    captured: dict[str, object] = {}

    class _FakeResponse:
        def raise_for_status(self) -> None:
            return None

        def json(self) -> dict[str, object]:
            return {
                "plan_type": "pro",
                "rate_limit": {
                    "primary_window": {
                        "used_percent": 42,
                        "limit_window_seconds": 3600,
                        "reset_at": 1_735_689_720,
                    },
                    "secondary_window": {
                        "used_percent": 5,
                        "limit_window_seconds": 86400,
                        "reset_at": 1_735_776_000,
                    },
                },
                "credits": {
                    "has_credits": True,
                    "unlimited": False,
                    "balance": "9.99",
                },
                "rate_limit_reached_type": {
                    "type": "workspace_member_usage_limit_reached"
                },
                "additional_rate_limits": [
                    {
                        "limit_name": "codex_other",
                        "metered_feature": "codex_other",
                        "rate_limit": {
                            "primary_window": {
                                "used_percent": 88,
                                "limit_window_seconds": 1800,
                                "reset_at": 1_735_693_200,
                            }
                        },
                    }
                ],
            }

    class _FakeClient:
        def __init__(self, *_args, **_kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

        async def get(self, url, *, headers):  # type: ignore[no-untyped-def]
            captured["url"] = url
            captured["headers"] = headers
            return _FakeResponse()

    monkeypatch.setattr(codex_usage.httpx, "AsyncClient", _FakeClient)

    client = TestClient(_make_app())
    response = client.get("/api/settings/providers/codex/usage")

    assert response.status_code == 200
    assert captured["url"] == "https://chatgpt.com/backend-api/wham/usage"
    assert captured["headers"] == {
        "Authorization": "Bearer chatgpt-token",
        "Accept": "application/json",
        "User-Agent": "openagentd/1.0.0",
        "originator": "openagentd",
        "ChatGPT-Account-Id": "account-123",
    }
    body = response.json()
    assert body["provider"] == "codex"
    assert body["limits"][0]["limit_id"] == "codex"
    assert body["limits"][0]["primary"] == {
        "used_percent": 42.0,
        "window_minutes": 60,
        "resets_at": 1_735_689_720,
    }
    assert body["limits"][0]["secondary"]["window_minutes"] == 1440
    assert body["limits"][0]["credits"]["balance"] == "9.99"
    assert (
        body["limits"][0]["rate_limit_reached_type"]
        == "workspace_member_usage_limit_reached"
    )
    assert body["limits"][1]["limit_id"] == "codex_other"
    assert body["limits"][1]["primary"]["used_percent"] == 88.0


def test_get_codex_provider_usage_returns_unlimited_credits(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import time

    oauth = CodexOAuth(
        access_token=SecretStr("chatgpt-token"),
        refresh_token=SecretStr("refresh-token"),
        expires_at=time.time() + 3600,
        account_id="account-123",
    )
    monkeypatch.setattr(
        "app.agent.providers.codex.oauth.CodexOAuth.load", lambda: oauth
    )

    class _FakeResponse:
        def raise_for_status(self) -> None:
            return None

        def json(self) -> dict[str, object]:
            return {
                "plan_type": "business",
                "rate_limit": None,
                "additional_rate_limits": None,
                "credits": {
                    "has_credits": True,
                    "unlimited": True,
                    "balance": None,
                    "overage_limit_reached": False,
                    "approx_local_messages": None,
                    "approx_cloud_messages": None,
                },
                "rate_limit_reached_type": None,
            }

    class _FakeClient:
        def __init__(self, *_args, **_kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

        async def get(self, _url, *, headers):  # type: ignore[no-untyped-def]
            return _FakeResponse()

    monkeypatch.setattr(codex_usage.httpx, "AsyncClient", _FakeClient)

    client = TestClient(_make_app())
    response = client.get("/api/settings/providers/codex/usage")

    assert response.status_code == 200
    body = response.json()
    assert body == {
        "provider": "codex",
        "limits": [
            {
                "limit_id": "codex",
                "limit_name": None,
                "primary": None,
                "secondary": None,
                "credits": {
                    "has_credits": True,
                    "unlimited": True,
                    "balance": None,
                },
                "plan_type": "business",
                "rate_limit_reached_type": None,
            }
        ],
    }


def test_get_copilot_provider_usage_returns_premium_quota_snapshot(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    oauth = CopilotOAuth(github_token=SecretStr("github-token"))
    monkeypatch.setattr(
        "app.agent.providers.copilot.oauth.CopilotOAuth.load", lambda: oauth
    )

    captured: dict[str, object] = {}

    class _FakeResponse:
        def raise_for_status(self) -> None:
            return None

        def json(self) -> dict[str, object]:
            return {
                "copilot_plan": "individual",
                "quota_reset_date_utc": "2026-06-01T00:00:00.000Z",
                "quota_snapshots": {
                    "chat": {
                        "quota_id": "chat",
                        "percent_remaining": 100.0,
                        "remaining": 0,
                        "entitlement": 0,
                        "unlimited": True,
                        "quota_reset_at": 0,
                    },
                    "premium_interactions": {
                        "quota_id": "premium_interactions",
                        "percent_remaining": 85.6,
                        "remaining": 257,
                        "entitlement": 300,
                        "unlimited": False,
                        "quota_reset_at": 0,
                    },
                },
            }

    class _FakeClient:
        def __init__(self, *_args, **_kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

        async def get(self, url, *, headers):  # type: ignore[no-untyped-def]
            captured["url"] = url
            captured["headers"] = headers
            return _FakeResponse()

    monkeypatch.setattr(copilot_usage.httpx, "AsyncClient", _FakeClient)

    client = TestClient(_make_app())
    response = client.get("/api/settings/providers/copilot/usage")

    assert response.status_code == 200
    assert captured["url"] == "https://api.github.com/copilot_internal/user"
    assert captured["headers"] == {
        "Authorization": "token github-token",
        "Accept": "application/json",
        "User-Agent": "openagentd/1.0.0",
    }
    body = response.json()
    assert body["provider"] == "copilot"
    assert body["limits"][0] == {
        "limit_id": "premium_interactions",
        "limit_name": "Premium requests",
        "primary": {
            "used_percent": pytest.approx(14.4),
            "window_minutes": None,
            "resets_at": 1780272000,
        },
        "secondary": None,
        "credits": {"has_credits": True, "unlimited": False, "balance": "257/300"},
        "plan_type": "individual",
        "rate_limit_reached_type": None,
    }


def test_get_provider_usage_rejects_unsupported_provider() -> None:
    client = TestClient(_make_app())
    response = client.get("/api/settings/providers/openai/usage")
    assert response.status_code == 404


def test_provider_configuration_reads_saved_config_env(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    from app.agent.providers.catalog import find

    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    monkeypatch.setattr(
        settings_routes.settings, "OPENAGENTD_CONFIG_DIR", str(tmp_path)
    )
    (tmp_path / ".env").write_text("OPENAI_API_KEY=saved-key\n", encoding="utf-8")

    entry = find("openai")
    assert entry is not None
    assert settings_routes._provider_is_configured(entry) is True


def test_save_provider_visible_models_writes_runtime_settings(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    from app.core.runtime_settings import RuntimeSettings, save_runtime_settings

    monkeypatch.setattr(
        settings_routes.settings, "OPENAGENTD_CONFIG_DIR", str(tmp_path)
    )
    save_runtime_settings(
        RuntimeSettings(
            providers={
                "openai": {
                    "cached_models": ["gpt-5.1", "gpt-5.1-mini"],
                    "last_listed_at": 123,
                }
            }
        )
    )

    app = _make_app()
    client = TestClient(app)
    response = client.put(
        "/api/settings/providers/openai/visible-models",
        json={"models": ["gpt-5.1", "gpt-5.1-mini", "gpt-5.1"]},
    )

    assert response.status_code == 200
    assert response.json() == {
        "provider": "openai",
        "visible_models": ["gpt-5.1", "gpt-5.1-mini"],
    }
    saved = (tmp_path / "settings.yaml").read_text(encoding="utf-8")
    assert "visible_models" in saved
    assert "cached_models" in saved


def test_save_provider_visible_models_rejects_unknown_provider() -> None:
    app = _make_app()
    client = TestClient(app)
    response = client.put(
        "/api/settings/providers/notreal/visible-models",
        json={"models": ["x"]},
    )

    assert response.status_code == 404


def test_list_provider_models_persists_cached_models_for_saved_credentials(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    from app.core.runtime_settings import provider_cached_models

    monkeypatch.setattr(
        settings_routes.settings, "OPENAGENTD_CONFIG_DIR", str(tmp_path)
    )

    async def _models(_entry, **_kwargs):  # type: ignore[no-untyped-def]
        return ["gpt-5", "gpt-5-mini"]

    monkeypatch.setattr(
        "app.agent.providers.model_discovery.discover_provider_models", _models
    )

    app = _make_app()
    client = TestClient(app)
    response = client.post(
        "/api/settings/providers/openai/models",
        json={"api_key": "", "extra": {}},
    )

    assert response.status_code == 200
    assert response.json()["models"] == ["gpt-5", "gpt-5-mini"]
    assert provider_cached_models("openai") == ["gpt-5", "gpt-5-mini"]


def test_list_provider_models_does_not_persist_candidate_credentials(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    from app.core.runtime_settings import provider_cached_models

    monkeypatch.setattr(
        settings_routes.settings, "OPENAGENTD_CONFIG_DIR", str(tmp_path)
    )

    async def _models(_entry, **_kwargs):  # type: ignore[no-untyped-def]
        return ["candidate-model"]

    monkeypatch.setattr(
        "app.agent.providers.model_discovery.discover_provider_models", _models
    )

    app = _make_app()
    client = TestClient(app)
    response = client.post(
        "/api/settings/providers/openai/models",
        json={"api_key": "new-key", "extra": {}},
    )

    assert response.status_code == 200
    assert response.json()["models"] == ["candidate-model"]
    assert provider_cached_models("openai") == []


def test_save_provider_clears_cached_models(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    from app.core.runtime_settings import (
        RuntimeSettings,
        provider_cached_models,
        save_runtime_settings,
    )

    monkeypatch.setattr(
        settings_routes.settings, "OPENAGENTD_CONFIG_DIR", str(tmp_path)
    )
    save_runtime_settings(
        RuntimeSettings(
            providers={
                "openai": {
                    "cached_models": ["stale-model"],
                    "last_listed_at": 123,
                }
            }
        )
    )

    app = _make_app()
    client = TestClient(app)
    response = client.put(
        "/api/settings/providers/openai",
        json={"api_key": "saved-key", "extra": {}},
    )

    assert response.status_code == 200
    assert provider_cached_models("openai") == []


# ── /agents/registry — cache-first provider models ─────────────────────────


def test_registry_uses_cached_provider_models(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from fastapi import FastAPI

    from app.api.routes.agents import router as agents_router
    from app.core.runtime_settings import RuntimeSettings, save_runtime_settings

    monkeypatch.setattr(
        settings_routes.settings, "OPENAGENTD_CONFIG_DIR", str(tmp_path)
    )
    save_runtime_settings(
        RuntimeSettings(
            providers={"openai": {"cached_models": ["gpt-5", "gpt-5-mini"]}}
        )
    )

    app = FastAPI()
    app.include_router(agents_router, prefix="/api/agents")
    client = TestClient(app)
    response = client.get("/api/agents/registry")

    assert response.status_code == 200
    ids = {m["id"] for m in response.json()["models"]}
    assert "openai:gpt-5" in ids
    assert "openai:gpt-5-mini" in ids


def test_registry_filters_cached_models_by_visible_models(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    from fastapi import FastAPI

    from app.api.routes.agents import router as agents_router
    from app.core.runtime_settings import RuntimeSettings, save_runtime_settings

    monkeypatch.setattr(
        settings_routes.settings, "OPENAGENTD_CONFIG_DIR", str(tmp_path)
    )
    save_runtime_settings(
        RuntimeSettings(
            providers={
                "openai": {
                    "cached_models": ["shown", "hidden"],
                    "visible_models": ["shown"],
                }
            }
        )
    )

    app = FastAPI()
    app.include_router(agents_router, prefix="/api/agents")
    client = TestClient(app)
    response = client.get("/api/agents/registry")

    assert response.status_code == 200
    ids = {m["id"] for m in response.json()["models"]}
    assert "openai:shown" in ids
    assert "openai:hidden" not in ids


def test_registry_ignores_missing_cached_models(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from fastapi import FastAPI

    from app.api.routes.agents import router as agents_router

    monkeypatch.setattr(
        settings_routes.settings, "OPENAGENTD_CONFIG_DIR", str(tmp_path)
    )

    app = FastAPI()
    app.include_router(agents_router, prefix="/api/agents")
    client = TestClient(app)
    response = client.get("/api/agents/registry")

    assert response.status_code == 200
    assert response.json()["models"] == []
