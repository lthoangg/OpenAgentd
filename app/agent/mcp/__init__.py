"""MCP (Model Context Protocol) client integration.

Connects to external MCP servers (stdio subprocesses or remote Streamable HTTP
endpoints) and exposes their tools to agents via the standard ``Tool`` registry.

Tools are namespaced ``<server>_<tool>`` to avoid collisions with built-ins
and across servers. Sessions are long-lived: spawned best-effort in
``lifespan()`` startup, kept alive for the server's lifetime, and shut down on
stop.

Public API:

* :class:`MCPManager` — lifecycle owner, accessed via :data:`mcp_manager`.
* :class:`MCPServerConfig` / :class:`MCPConfig` — config schema for ``mcp.json``.
* :func:`load_config` / :func:`save_config` — file I/O helpers.
"""

from __future__ import annotations

from app.agent.mcp.config import (
    MCPConfig,
    MCPServerConfig,
    StdioServerConfig,
    HttpServerConfig,
    load_config,
    save_config,
)
from app.agent.mcp.manager import MCPManager, MCPServerStatus, mcp_manager

__all__ = [
    "MCPConfig",
    "MCPServerConfig",
    "StdioServerConfig",
    "HttpServerConfig",
    "MCPManager",
    "MCPServerStatus",
    "load_config",
    "save_config",
    "mcp_manager",
]
