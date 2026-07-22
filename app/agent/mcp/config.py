"""Config schema and file I/O for ``{CONFIG_DIR}/mcp.json``.

The file is a JSON object with a single top-level key ``servers`` mapping
server names to per-server config. Two transport shapes:

.. code-block:: json

    {
      "servers": {
        "filesystem": {
          "transport": "stdio",
          "command": "npx",
          "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
          "env": {"FOO": "bar"},
          "enabled": true
        },
        "github": {
          "transport": "http",
          "url": "https://mcp.example.com/v1",
          "headers": {"Authorization": "Bearer ..."},
          "enabled": true
        }
      }
    }

Server names must match ``[a-zA-Z][a-zA-Z0-9_-]*`` because they become part
of the tool name (``<server>_<tool>``).
"""

from __future__ import annotations

import json
import os
import re
import tempfile
from collections.abc import Iterable, Mapping
from pathlib import Path
from typing import Annotated, Literal

from dotenv import dotenv_values
from loguru import logger
from pydantic import BaseModel, ConfigDict, Field

from app.core.config import settings

_CONFIG_FILENAME = "mcp.json"
_ENV_REF_RE = re.compile(r"\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)")

_SERVER_NAME_RE = re.compile(r"^[a-zA-Z][a-zA-Z0-9_-]*$")


def validate_server_name(name: str) -> str:
    """Validate and return a server name. Raises ``ValueError`` if invalid."""
    if not _SERVER_NAME_RE.match(name):
        raise ValueError(
            f"Invalid MCP server name {name!r}: must match {_SERVER_NAME_RE.pattern} "
            "(letters, digits, underscore, hyphen; starting with a letter)."
        )
    return name


class StdioServerConfig(BaseModel):
    """Spawn a local subprocess and speak MCP over its stdio."""

    model_config = ConfigDict(extra="forbid")

    transport: Literal["stdio"] = "stdio"
    command: Annotated[str, Field(min_length=1)]
    args: list[str] = Field(default_factory=list)
    env: dict[str, str] = Field(default_factory=dict)
    enabled: bool = True


class OAuthConfig(BaseModel):
    """OAuth settings for remote HTTP MCP servers."""

    model_config = ConfigDict(extra="forbid")

    client_id: str | None = None
    client_secret: str | None = None


class HttpServerConfig(BaseModel):
    """Connect to a remote MCP server over Streamable HTTP."""

    model_config = ConfigDict(extra="forbid")

    transport: Literal["http"] = "http"
    url: Annotated[str, Field(min_length=1)]
    headers: dict[str, str] = Field(default_factory=dict)
    oauth: OAuthConfig | None = None
    enabled: bool = True


def _requires_dotenv(values: Iterable[str]) -> bool:
    return any(
        (match.group(1) or match.group(2)) not in os.environ
        for value in values
        for match in _ENV_REF_RE.finditer(value)
    )


def resolve_secret_refs(
    value: str, *, _dotenv_snapshot: Mapping[str, str | None] | None = None
) -> str:
    """Expand $VAR / ${VAR} using process env or the config .env file."""
    if not _ENV_REF_RE.search(value):
        return value

    dotenv_snapshot = _dotenv_snapshot
    if dotenv_snapshot is None:
        if _requires_dotenv((value,)):
            env_file = Path(settings.OPENAGENTD_CONFIG_DIR) / ".env"
            dotenv_snapshot = dotenv_values(env_file) if env_file.is_file() else {}
        else:
            dotenv_snapshot = {}

    def replace(match: re.Match[str]) -> str:
        name = match.group(1) or match.group(2)
        if name in os.environ:
            return os.environ[name]
        env_value = dotenv_snapshot.get(name)
        if env_value is not None:
            return env_value
        return match.group(0)

    return _ENV_REF_RE.sub(replace, value)


def resolve_headers(headers: dict[str, str]) -> dict[str, str]:
    """Resolve env-var references in HTTP MCP headers at connection time."""
    if not any(_ENV_REF_RE.search(value) for value in headers.values()):
        return dict(headers)

    if _requires_dotenv(headers.values()):
        env_file = Path(settings.OPENAGENTD_CONFIG_DIR) / ".env"
        dotenv_snapshot = dotenv_values(env_file) if env_file.is_file() else {}
    else:
        dotenv_snapshot = {}
    return {
        key: resolve_secret_refs(value, _dotenv_snapshot=dotenv_snapshot)
        for key, value in headers.items()
    }


MCPServerConfig = StdioServerConfig | HttpServerConfig


class MCPConfig(BaseModel):
    """Top-level shape of ``mcp.json``."""

    model_config = ConfigDict(extra="forbid")

    servers: dict[str, MCPServerConfig] = Field(default_factory=dict)


def config_path() -> Path:
    """Return the resolved path to ``mcp.json``."""
    return Path(settings.OPENAGENTD_CONFIG_DIR) / _CONFIG_FILENAME


def load_config(path: Path | None = None) -> MCPConfig:
    """Load ``mcp.json`` from disk. Returns an empty config if the file is missing.

    Raises ``ValueError`` if the file exists but is malformed (invalid JSON,
    schema mismatch, or invalid server names).
    """
    resolved = path or config_path()
    if not resolved.exists():
        return MCPConfig()

    try:
        raw = json.loads(resolved.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise ValueError(f"Invalid JSON in {resolved}: {exc}") from exc

    if not isinstance(raw, dict):
        raise ValueError(f"{resolved}: expected a JSON object at top level")

    cfg = MCPConfig.model_validate(raw)
    for name in cfg.servers:
        validate_server_name(name)
    return cfg


def save_config(cfg: MCPConfig, path: Path | None = None) -> Path:
    """Persist ``cfg`` to disk atomically. Returns the resolved path.

    Server names are validated before any disk write.
    """
    for name in cfg.servers:
        validate_server_name(name)

    resolved = path or config_path()
    resolved.parent.mkdir(parents=True, exist_ok=True)

    payload = cfg.model_dump(mode="json", exclude_defaults=False)
    text = json.dumps(payload, indent=2, sort_keys=True) + "\n"

    # Atomic write: tmp file in same dir, then rename.
    fd, tmp_name = tempfile.mkstemp(
        prefix=".mcp.json.", suffix=".tmp", dir=resolved.parent
    )
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(text)
        os.replace(tmp_name, resolved)
    except Exception:
        try:
            os.unlink(tmp_name)
        except OSError:
            pass
        raise

    logger.info("mcp_config_saved path={} servers={}", resolved, list(cfg.servers))
    return resolved
