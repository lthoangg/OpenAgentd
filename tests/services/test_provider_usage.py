from __future__ import annotations

import importlib
import subprocess
import sys

import pytest

from app.agent.providers.plugin_api import ProviderPlugin
from app.services import provider_usage


def test_provider_usage_import_defers_provider_implementations() -> None:
    code = (
        "import sys; import app.services.provider_usage; "
        "eager = sorted(name for name in sys.modules "
        "if name in {'app.agent.providers.codex.usage', "
        "'app.agent.providers.copilot.usage', 'app.agent.providers.grok.usage', "
        "'app.agent.providers.plugin_registry'}); "
        "assert not eager, f'eager builtin usage imports: {eager}'"
    )

    result = subprocess.run(
        [sys.executable, "-c", code],
        capture_output=True,
        text=True,
        check=False,
    )

    assert result.returncode == 0, result.stderr


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


@pytest.mark.parametrize(
    ("provider_id", "error_name"),
    [
        ("codex", "CodexUsageCredentialsError"),
        ("copilot", "CopilotUsageCredentialsError"),
        ("grok", "GrokUsageCredentialsError"),
    ],
)
async def test_builtin_credentials_errors_are_mapped(
    monkeypatch, provider_id: str, error_name: str
):
    module = importlib.import_module(f"app.agent.providers.{provider_id}.usage")
    error_type = getattr(module, error_name)

    async def _raise_credentials_error():
        raise error_type("credentials missing")

    monkeypatch.setattr(
        provider_usage, f"get_{provider_id}_usage", _raise_credentials_error
    )

    with pytest.raises(provider_usage.ProviderUsageCredentialsError):
        await provider_usage.get_provider_usage(provider_id)


@pytest.mark.parametrize(
    ("provider_id", "error_name"),
    [
        ("codex", "CodexUsageUnavailableError"),
        ("copilot", "CopilotUsageUnavailableError"),
        ("grok", "GrokUsageUnavailableError"),
    ],
)
async def test_builtin_unavailable_errors_are_mapped(
    monkeypatch, provider_id: str, error_name: str
):
    module = importlib.import_module(f"app.agent.providers.{provider_id}.usage")
    error_type = getattr(module, error_name)

    async def _raise_unavailable_error():
        raise error_type("upstream unavailable")

    monkeypatch.setattr(
        provider_usage, f"get_{provider_id}_usage", _raise_unavailable_error
    )

    with pytest.raises(provider_usage.ProviderUsageUnavailableError):
        await provider_usage.get_provider_usage(provider_id)


@pytest.mark.asyncio
async def test_get_provider_usage_dispatches_to_grok(monkeypatch):
    from app.api.schemas.settings import ProviderUsageResponse

    async def _grok_usage():
        return ProviderUsageResponse(provider="grok")

    monkeypatch.setattr(provider_usage, "get_grok_usage", _grok_usage)

    result = await provider_usage.get_provider_usage("grok")

    assert result.provider == "grok"
