from __future__ import annotations

import time
from unittest.mock import AsyncMock, MagicMock, patch

import httpx
import pytest
import respx
from pydantic import SecretStr

from app.agent.providers.catalog import find
from app.agent.providers.grok.oauth import GrokOAuth
from app.agent.providers.model_discovery import discover_provider_models
from app.agent.providers.openai import OpenAIProvider


def _oauth() -> GrokOAuth:
    return GrokOAuth(
        access_token=SecretStr("grok-session-token"),
        refresh_token=SecretStr("grok-refresh-token"),
        expires_at=time.time() + 3600,
    )


def test_grok_build_provider_uses_session_proxy_responses_and_routing_headers() -> None:
    from app.agent.providers.grok import GrokBuildProvider

    with patch("app.agent.providers.grok.grok.GrokOAuth.load", return_value=_oauth()):
        provider = GrokBuildProvider(model="grok-4.5")

    assert isinstance(provider, OpenAIProvider)
    assert provider.base_url == "https://cli-chat-proxy.grok.com/v1"
    assert provider._use_responses is True
    assert provider._responses.preserve_stateless_reasoning is True
    assert provider._responses.headers["Authorization"] == "Bearer grok-session-token"
    assert provider._responses.headers["X-XAI-Token-Auth"] == "xai-grok-cli"
    assert provider._responses.headers["x-grok-model-override"] == "grok-4.5"
    assert provider._responses.headers["x-grok-client-identifier"] == "openagentd"

    body = provider._responses.build_request([], tools=None, stream=False, merged={})
    assert body["store"] is False
    assert body["include"] == ["reasoning.encrypted_content"]


def test_grok_build_provider_honors_explicit_chat_completions_override() -> None:
    from app.agent.providers.grok import GrokBuildProvider

    with patch("app.agent.providers.grok.grok.GrokOAuth.load", return_value=_oauth()):
        provider = GrokBuildProvider(
            model="grok-build",
            model_kwargs={"responses_api": False},
        )

    assert provider._use_responses is False


def test_grok_build_provider_requires_oauth_credentials() -> None:
    from app.agent.providers.grok import GrokBuildProvider

    with patch("app.agent.providers.grok.grok.GrokOAuth.load", return_value=None):
        with pytest.raises(ValueError, match="openagentd auth grok"):
            GrokBuildProvider(model="grok-4.5")


async def test_grok_build_provider_refreshes_expired_session_before_request() -> None:
    from app.agent.providers.grok import GrokBuildProvider

    initial = _oauth()
    expired = GrokOAuth(
        access_token=SecretStr("expired-session-token"),
        refresh_token=SecretStr("grok-refresh-token"),
        expires_at=1,
    )
    fresh = GrokOAuth(
        access_token=SecretStr("fresh-session-token"),
        refresh_token=SecretStr("fresh-refresh-token"),
        expires_at=time.time() + 3600,
    )
    with patch("app.agent.providers.grok.grok.GrokOAuth.load", return_value=initial):
        provider = GrokBuildProvider(model="grok-4.5")

    with (
        patch("app.agent.providers.grok.grok.GrokOAuth.load", return_value=expired),
        patch("app.agent.providers.grok.grok.GrokOAuth.refresh", return_value=fresh),
        patch.object(provider._responses, "chat", new_callable=AsyncMock) as chat,
    ):
        await provider.chat([])

    chat.assert_awaited_once()
    assert provider.api_key == "fresh-session-token"
    assert provider._responses.headers["Authorization"] == (
        "Bearer fresh-session-token"
    )


def test_factory_builds_grok_build_provider() -> None:
    from app.agent.providers.factory import build_provider

    with patch(
        "app.agent.providers.factory.GrokBuildProvider", return_value=MagicMock()
    ) as mock_provider:
        build_provider("grok:grok-4.5", model_kwargs={"thinking_level": "high"})

    assert mock_provider.call_args.kwargs == {
        "model": "grok-4.5",
        "model_kwargs": {"thinking_level": "high"},
    }


@respx.mock
async def test_grok_build_model_discovery_uses_session_proxy_headers() -> None:
    entry = find("grok")
    assert entry is not None
    route = respx.get("https://cli-chat-proxy.grok.com/v1/models").mock(
        return_value=httpx.Response(
            200,
            json={
                "data": [
                    {"id": "grok-4.5"},
                    {"id": "grok-build"},
                    {"id": "grok-imagine-image"},
                ]
            },
        )
    )

    with patch("app.agent.providers.grok.oauth.GrokOAuth.load", return_value=_oauth()):
        models = await discover_provider_models(entry)

    assert models == ["grok-4.5", "grok-build"]
    assert route.calls[0].request.headers["Authorization"] == (
        "Bearer grok-session-token"
    )
    assert route.calls[0].request.headers["X-XAI-Token-Auth"] == "xai-grok-cli"
