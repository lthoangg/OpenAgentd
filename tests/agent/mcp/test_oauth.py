from __future__ import annotations

import urllib.parse

from app.agent.mcp.config import HttpServerConfig, OAuthConfig
from app.agent.mcp.oauth import LoopbackCallback, build_oauth_provider


def test_loopback_redirect_uri_uses_default_callback_path():
    callback = LoopbackCallback()
    try:
        assert callback.redirect_uri.startswith("http://localhost:")
        assert callback.redirect_uri.endswith("/callback")
    finally:
        callback.server.server_close()


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
