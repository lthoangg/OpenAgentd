from __future__ import annotations

import pytest

from app.agent.providers.plugin_api import ProviderPlugin
from app.services import provider_usage


async def _plugin_usage(credentials):
    from app.api.schemas.settings import ProviderUsageResponse

    assert credentials.provider_id == "plugin-oauth"
    return ProviderUsageResponse(provider="plugin-oauth")


@pytest.mark.asyncio
async def test_get_provider_usage_dispatches_to_plugin(monkeypatch):
    plugin = ProviderPlugin(
        id="plugin-oauth",
        label="Plugin OAuth",
        description="Plugin OAuth provider",
        kind="oauth",
        factory=lambda _ctx: None,  # type: ignore[arg-type,return-value]
        get_usage=_plugin_usage,
    )

    monkeypatch.setattr(
        provider_usage, "find_provider_plugin", lambda provider_id: plugin
    )

    result = await provider_usage.get_provider_usage("plugin-oauth")

    assert result.provider == "plugin-oauth"


@pytest.mark.asyncio
async def test_get_provider_usage_plugin_value_error_is_credentials_error(monkeypatch):
    async def _raise_value_error(_credentials):
        raise ValueError("missing token")

    plugin = ProviderPlugin(
        id="plugin-oauth",
        label="Plugin OAuth",
        description="Plugin OAuth provider",
        kind="oauth",
        factory=lambda _ctx: None,  # type: ignore[arg-type,return-value]
        get_usage=_raise_value_error,
    )

    monkeypatch.setattr(
        provider_usage, "find_provider_plugin", lambda provider_id: plugin
    )

    with pytest.raises(provider_usage.ProviderUsageCredentialsError):
        await provider_usage.get_provider_usage("plugin-oauth")


@pytest.mark.asyncio
async def test_get_provider_usage_dispatches_to_grok(monkeypatch):
    from app.api.schemas.settings import ProviderUsageResponse

    async def _grok_usage():
        return ProviderUsageResponse(provider="grok")

    monkeypatch.setattr(provider_usage, "get_grok_usage", _grok_usage)

    result = await provider_usage.get_provider_usage("grok")

    assert result.provider == "grok"
