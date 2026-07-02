"""Tests for the connected-provider usage summary aggregator.

Covers ``app/services/provider_usage.py::get_connected_provider_usage_summary``
— the fan-in used by the desktop tray's "Usage Limits" submenu. Exercises
builtin OAuth providers and provider plugins uniformly since both flow
through the same ``_usage_capable_connected_providers`` + ``get_provider_usage``
path.
"""

from __future__ import annotations

import pytest

from app.agent.providers.plugin_api import ProviderPlugin
from app.api.schemas.settings import ProviderUsageLimit, ProviderUsageResponse
from app.services import provider_usage


@pytest.fixture(autouse=True)
def _reset_summary_cache():
    """The aggregator caches its last result process-wide; isolate tests."""
    provider_usage._summary_cache = None
    provider_usage._last_good_items.clear()
    provider_usage._background_refresh_task = None
    yield
    provider_usage._summary_cache = None
    provider_usage._last_good_items.clear()
    provider_usage._background_refresh_task = None


def _catalog_entries(configured: dict[str, bool]):
    entries = {
        "codex": {"id": "codex", "label": "OpenAI Codex", "kind": "oauth"},
        "copilot": {"id": "copilot", "label": "GitHub Copilot", "kind": "oauth"},
    }

    def _find(provider_id: str):
        return entries.get(provider_id)

    return _find


@pytest.mark.asyncio
async def test_summary_includes_only_connected_builtin_providers(monkeypatch):
    monkeypatch.setattr("app.agent.providers.catalog.find", _catalog_entries({}))
    monkeypatch.setattr(provider_usage, "provider_plugins", lambda: {})

    def _is_configured(entry):
        return entry["id"] == "codex"

    monkeypatch.setattr(provider_usage, "provider_is_configured", _is_configured)

    async def _fake_get_usage(provider_id: str) -> ProviderUsageResponse:
        assert provider_id == "codex"
        return ProviderUsageResponse(
            provider="codex",
            limits=[ProviderUsageLimit(limit_id="codex")],
        )

    monkeypatch.setattr(provider_usage, "get_provider_usage", _fake_get_usage)

    body = await provider_usage.get_connected_provider_usage_summary()

    assert [item.provider for item in body.items] == ["codex"]
    assert body.items[0].status == "ok"
    assert body.items[0].usage is not None
    assert body.cached is False


@pytest.mark.asyncio
async def test_summary_includes_connected_plugin_providers(monkeypatch):
    monkeypatch.setattr("app.agent.providers.catalog.find", lambda _pid: None)

    plugin = ProviderPlugin(
        id="agy",
        label="Antigravity Gemini Auth",
        description="Antigravity",
        kind="oauth",
        factory=lambda _ctx: None,  # type: ignore[arg-type,return-value]
        get_usage=lambda _creds: None,  # type: ignore[arg-type]
    )
    monkeypatch.setattr(provider_usage, "provider_plugins", lambda: {"agy": plugin})
    monkeypatch.setattr(
        provider_usage, "provider_is_configured", lambda entry: entry["id"] == "agy"
    )

    async def _fake_get_usage(provider_id: str) -> ProviderUsageResponse:
        assert provider_id == "agy"
        return ProviderUsageResponse(provider="agy", limits=[])

    monkeypatch.setattr(provider_usage, "get_provider_usage", _fake_get_usage)

    body = await provider_usage.get_connected_provider_usage_summary()

    assert [item.provider for item in body.items] == ["agy"]
    assert body.items[0].label == "Antigravity Gemini Auth"


@pytest.mark.asyncio
async def test_summary_excludes_plugin_without_get_usage(monkeypatch):
    monkeypatch.setattr("app.agent.providers.catalog.find", lambda _pid: None)

    plugin = ProviderPlugin(
        id="no-usage-plugin",
        label="No Usage Plugin",
        description="",
        kind="oauth",
        factory=lambda _ctx: None,  # type: ignore[arg-type,return-value]
    )
    monkeypatch.setattr(
        provider_usage, "provider_plugins", lambda: {"no-usage-plugin": plugin}
    )
    monkeypatch.setattr(provider_usage, "provider_is_configured", lambda entry: False)

    body = await provider_usage.get_connected_provider_usage_summary()

    assert body.items == []


@pytest.mark.asyncio
async def test_one_failing_provider_does_not_sink_the_summary(monkeypatch):
    monkeypatch.setattr("app.agent.providers.catalog.find", _catalog_entries({}))
    monkeypatch.setattr(provider_usage, "provider_plugins", lambda: {})
    monkeypatch.setattr(provider_usage, "provider_is_configured", lambda entry: True)

    async def _fake_get_usage(provider_id: str) -> ProviderUsageResponse:
        if provider_id == "codex":
            raise provider_usage.ProviderUsageUnavailableError("upstream 503")
        return ProviderUsageResponse(provider=provider_id, limits=[])

    monkeypatch.setattr(provider_usage, "get_provider_usage", _fake_get_usage)

    body = await provider_usage.get_connected_provider_usage_summary()

    by_provider = {item.provider: item for item in body.items}
    assert by_provider["codex"].status == "unavailable"
    assert by_provider["codex"].error == "upstream 503"
    assert by_provider["copilot"].status == "ok"


@pytest.mark.asyncio
async def test_credentials_error_maps_to_credentials_missing_status(monkeypatch):
    monkeypatch.setattr("app.agent.providers.catalog.find", _catalog_entries({}))
    monkeypatch.setattr(provider_usage, "provider_plugins", lambda: {})
    monkeypatch.setattr(
        provider_usage, "provider_is_configured", lambda entry: entry["id"] == "codex"
    )

    async def _fake_get_usage(provider_id: str) -> ProviderUsageResponse:
        raise provider_usage.ProviderUsageCredentialsError("token missing")

    monkeypatch.setattr(provider_usage, "get_provider_usage", _fake_get_usage)

    body = await provider_usage.get_connected_provider_usage_summary()

    assert body.items[0].status == "credentials_missing"
    assert body.items[0].error == "token missing"


@pytest.mark.asyncio
async def test_summary_is_cached_until_force_refresh(monkeypatch):
    monkeypatch.setattr("app.agent.providers.catalog.find", _catalog_entries({}))
    monkeypatch.setattr(provider_usage, "provider_plugins", lambda: {})
    monkeypatch.setattr(
        provider_usage, "provider_is_configured", lambda entry: entry["id"] == "codex"
    )

    calls = {"n": 0}

    async def _fake_get_usage(provider_id: str) -> ProviderUsageResponse:
        calls["n"] += 1
        return ProviderUsageResponse(provider=provider_id, limits=[])

    monkeypatch.setattr(provider_usage, "get_provider_usage", _fake_get_usage)

    first = await provider_usage.get_connected_provider_usage_summary()
    second = await provider_usage.get_connected_provider_usage_summary()

    assert calls["n"] == 1
    assert first.cached is False
    assert second.cached is True

    third = await provider_usage.get_connected_provider_usage_summary(
        force_refresh=True
    )
    assert calls["n"] == 2
    assert third.cached is False


def _codex_only(monkeypatch, fake_get_usage):
    """Wire the aggregator to a single connected builtin provider (codex)."""
    monkeypatch.setattr("app.agent.providers.catalog.find", _catalog_entries({}))
    monkeypatch.setattr(provider_usage, "provider_plugins", lambda: {})
    monkeypatch.setattr(
        provider_usage, "provider_is_configured", lambda entry: entry["id"] == "codex"
    )
    monkeypatch.setattr(provider_usage, "get_provider_usage", fake_get_usage)


@pytest.mark.asyncio
async def test_stale_cache_is_served_immediately_and_revalidated_in_background(
    monkeypatch,
):
    calls = {"n": 0}

    async def _fake_get_usage(provider_id: str) -> ProviderUsageResponse:
        calls["n"] += 1
        return ProviderUsageResponse(provider=provider_id, limits=[])

    _codex_only(monkeypatch, _fake_get_usage)

    first = await provider_usage.get_connected_provider_usage_summary()
    assert calls["n"] == 1

    # Age the cache past the fresh TTL but inside the stale window.
    cached_at, cached_body = provider_usage._summary_cache
    provider_usage._summary_cache = (
        cached_at - provider_usage._SUMMARY_CACHE_TTL_S - 1,
        cached_body,
    )

    stale = await provider_usage.get_connected_provider_usage_summary()
    # Served instantly from the stale snapshot (no upstream call yet)...
    assert stale.cached is True
    assert stale.checked_at == first.checked_at

    # ...while a background task revalidates.
    task = provider_usage._background_refresh_task
    assert task is not None
    await task
    assert calls["n"] == 2
    fresh = await provider_usage.get_connected_provider_usage_summary()
    assert fresh.cached is True  # now served from the revalidated fresh cache
    assert calls["n"] == 2


@pytest.mark.asyncio
async def test_stale_cache_past_stale_ttl_blocks_for_a_fresh_fetch(monkeypatch):
    calls = {"n": 0}

    async def _fake_get_usage(provider_id: str) -> ProviderUsageResponse:
        calls["n"] += 1
        return ProviderUsageResponse(provider=provider_id, limits=[])

    _codex_only(monkeypatch, _fake_get_usage)

    await provider_usage.get_connected_provider_usage_summary()
    cached_at, cached_body = provider_usage._summary_cache
    provider_usage._summary_cache = (
        cached_at - provider_usage._SUMMARY_STALE_TTL_S - 1,
        cached_body,
    )

    body = await provider_usage.get_connected_provider_usage_summary()
    assert calls["n"] == 2
    assert body.cached is False


@pytest.mark.asyncio
async def test_transient_failure_serves_last_known_good_marked_stale(monkeypatch):
    behavior = {"fail": False}

    async def _fake_get_usage(provider_id: str) -> ProviderUsageResponse:
        if behavior["fail"]:
            raise provider_usage.ProviderUsageUnavailableError("upstream 503")
        return ProviderUsageResponse(
            provider=provider_id, limits=[ProviderUsageLimit(limit_id=provider_id)]
        )

    _codex_only(monkeypatch, _fake_get_usage)

    ok = await provider_usage.get_connected_provider_usage_summary(force_refresh=True)
    assert ok.items[0].status == "ok"
    assert ok.items[0].stale is False

    behavior["fail"] = True
    body = await provider_usage.get_connected_provider_usage_summary(force_refresh=True)
    item = body.items[0]
    # Last-known-good payload substituted, flagged stale, error preserved.
    assert item.status == "ok"
    assert item.stale is True
    assert item.usage is not None
    assert item.error == "upstream 503"


@pytest.mark.asyncio
async def test_last_known_good_expires_after_max_age(monkeypatch):
    behavior = {"fail": False}

    async def _fake_get_usage(provider_id: str) -> ProviderUsageResponse:
        if behavior["fail"]:
            raise provider_usage.ProviderUsageUnavailableError("upstream 503")
        return ProviderUsageResponse(provider=provider_id, limits=[])

    _codex_only(monkeypatch, _fake_get_usage)

    await provider_usage.get_connected_provider_usage_summary(force_refresh=True)

    # Age the recorded last-good snapshot past the substitution window.
    recorded_at, item = provider_usage._last_good_items["codex"]
    provider_usage._last_good_items["codex"] = (
        recorded_at - provider_usage._LAST_GOOD_MAX_AGE_S - 1,
        item,
    )

    behavior["fail"] = True
    body = await provider_usage.get_connected_provider_usage_summary(force_refresh=True)
    assert body.items[0].status == "unavailable"
    assert body.items[0].stale is False
    assert body.items[0].error == "upstream 503"


@pytest.mark.asyncio
async def test_credentials_error_never_falls_back_to_last_known_good(monkeypatch):
    behavior = {"fail": False}

    async def _fake_get_usage(provider_id: str) -> ProviderUsageResponse:
        if behavior["fail"]:
            raise provider_usage.ProviderUsageCredentialsError("token deleted")
        return ProviderUsageResponse(provider=provider_id, limits=[])

    _codex_only(monkeypatch, _fake_get_usage)

    await provider_usage.get_connected_provider_usage_summary(force_refresh=True)

    behavior["fail"] = True
    body = await provider_usage.get_connected_provider_usage_summary(force_refresh=True)
    # Reconnect-required must surface even though a last-good snapshot exists.
    assert body.items[0].status == "credentials_missing"
    assert body.items[0].stale is False
