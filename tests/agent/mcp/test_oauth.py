from __future__ import annotations

import json
import urllib.parse
from pathlib import Path

import httpx2
import pytest

from app.agent.mcp.config import HttpServerConfig, OAuthConfig
from app.agent.mcp.oauth import (
    LoopbackCallback,
    OAuthRequiredError,
    _root_slash_variant,
    build_oauth_provider,
)


def test_root_issuer_compatibility_is_limited_to_empty_path_slashes():
    assert _root_slash_variant("https://mcp.example.com/", "https://mcp.example.com")
    assert not _root_slash_variant(
        "https://other.example.com/", "https://mcp.example.com"
    )
    assert not _root_slash_variant(
        "https://mcp.example.com/tenant/", "https://mcp.example.com/tenant"
    )


def test_loopback_redirect_uri_uses_default_callback_path():
    callback = LoopbackCallback()
    try:
        assert callback.redirect_uri.startswith("http://localhost:")
        assert callback.redirect_uri.endswith("/callback")
    finally:
        callback.server.server_close()


async def test_oauth_provider_accepts_root_issuer_trailing_slash(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(
        "app.agent.mcp.oauth.settings.OPENAGENTD_CACHE_DIR", str(tmp_path)
    )
    cfg = HttpServerConfig(
        url="https://mcp.example.com/mcp",
        oauth=OAuthConfig(),
    )
    provider = build_oauth_provider("example", cfg)
    assert provider is not None

    flow = provider.async_auth_flow(httpx2.Request("POST", cfg.url))
    initial_request = await anext(flow)
    protected_resource_request = await flow.asend(
        httpx2.Response(
            401,
            headers={
                "WWW-Authenticate": (
                    'Bearer resource_metadata="https://mcp.example.com/'
                    '.well-known/oauth-protected-resource"'
                )
            },
            request=initial_request,
        )
    )
    authorization_server_request = await flow.asend(
        httpx2.Response(
            200,
            json={
                "resource": "https://mcp.example.com",
                "authorization_servers": ["https://mcp.example.com"],
            },
            request=protected_resource_request,
        )
    )

    try:
        authorization_server_metadata = {
            "issuer": "https://mcp.example.com/",
            "authorization_endpoint": "https://mcp.example.com/authorize",
            "token_endpoint": "https://mcp.example.com/token",
            "registration_endpoint": "https://mcp.example.com/register",
            "response_types_supported": ["code"],
            "code_challenge_methods_supported": ["S256"],
        }
        registration_request = await flow.asend(
            httpx2.Response(
                200,
                headers={"Content-Type": "application/json"},
                stream=httpx2.ByteStream(
                    json.dumps(authorization_server_metadata).encode()
                ),
                request=authorization_server_request,
            )
        )
        assert str(registration_request.url) == "https://mcp.example.com/register"
    finally:
        await flow.aclose()


def test_build_oauth_provider_uses_matching_redirect_uri_for_client_metadata():
    cfg = HttpServerConfig(
        url="https://mcp.example.com/mcp",
        oauth=OAuthConfig(client_id="client-id"),
    )

    provider = build_oauth_provider("example", cfg)

    assert provider is not None
    redirect_uris = provider.context.client_metadata.redirect_uris
    assert redirect_uris is not None
    parsed = urllib.parse.urlparse(str(redirect_uris[0]))
    assert parsed.scheme == "http"
    assert parsed.hostname == "localhost"
    assert parsed.path == "/callback"
    assert parsed.port is not None


@pytest.mark.asyncio
async def test_build_oauth_provider_redirect_handler_raises_oauth_required_error():
    cfg = HttpServerConfig(
        url="https://mcp.example.com/mcp",
        oauth=OAuthConfig(client_id="client-id"),
    )

    provider = build_oauth_provider("example", cfg)

    assert provider is not None
    with pytest.raises(OAuthRequiredError, match="needs OAuth"):
        await provider.context.redirect_handler("https://example.com/authorize")
