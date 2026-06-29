"""Tests for MCP config module (replaces the removed mcp-installer skill script tests).

The mcp-installer builtin skill was removed; its logic now lives in
``app.agent.mcp.config`` (HttpServerConfig, OAuthConfig, save_config).
"""

from __future__ import annotations

import json
from pathlib import Path


def test_http_server_config_stores_headers_and_oauth() -> None:
    """HttpServerConfig accepts headers and a public-client OAuth block."""
    from app.agent.mcp.config import HttpServerConfig, OAuthConfig

    cfg = HttpServerConfig(
        url="https://mcp.example.com/mcp",
        headers={"Authorization": "Bearer ${PRIVATE_MCP_TOKEN}"},
        oauth=OAuthConfig(client_id="public-client-id", client_secret=None),
    )

    assert cfg.transport == "http"
    assert cfg.url == "https://mcp.example.com/mcp"
    assert cfg.headers == {"Authorization": "Bearer ${PRIVATE_MCP_TOKEN}"}
    assert cfg.oauth is not None
    assert cfg.oauth.client_id == "public-client-id"
    assert cfg.oauth.client_secret is None


def test_save_config_writes_oauth_secrets_verbatim(tmp_path: Path, monkeypatch) -> None:
    """save_config persists OAuth client_id / client_secret into mcp.json as-is.

    Callers are expected to store env-var references (e.g. ``${SLACK_MCP_CLIENT_ID}``)
    rather than raw secrets when writing to disk.
    """
    from app.agent.mcp.config import (
        HttpServerConfig,
        MCPConfig,
        OAuthConfig,
        save_config,
    )

    monkeypatch.setattr(
        "app.agent.mcp.config.config_path", lambda: tmp_path / "mcp.json"
    )

    cfg = MCPConfig(
        servers={
            "slack": HttpServerConfig(
                url="https://mcp.slack.com/mcp",
                headers={},
                oauth=OAuthConfig(
                    client_id="${SLACK_MCP_CLIENT_ID}",
                    client_secret="${SLACK_MCP_CLIENT_SECRET}",
                ),
            )
        }
    )
    save_config(cfg, tmp_path / "mcp.json")

    data = json.loads((tmp_path / "mcp.json").read_text(encoding="utf-8"))
    assert data["servers"]["slack"]["oauth"] == {
        "client_id": "${SLACK_MCP_CLIENT_ID}",
        "client_secret": "${SLACK_MCP_CLIENT_SECRET}",
    }
