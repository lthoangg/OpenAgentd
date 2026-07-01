"""Diagnostics endpoint.

Returns a redacted snapshot the user can copy-paste into bug reports
without leaking secrets. Covers: version, runtime, configured dirs (paths
only, never contents), provider keys (boolean ``present`` only), MCP
status, last N lines of the app log, app error log path, OS/arch.

Used by the desktop "Copy diagnostics" button. CLI users can hit it
directly with ``curl /api/diagnostics``.
"""

from __future__ import annotations

import os
import platform
import sys
import typing
from collections.abc import Iterable
from pathlib import Path
from typing import Any

from fastapi import APIRouter
from pydantic import BaseModel, SecretStr

from app.core.config import settings
from app.core.version import VERSION

router = APIRouter()

# Cap entry counts so listing a 50k-session workspace dir doesn't make
# /api/diagnostics take seconds.
_MAX_DIR_ENTRIES = 1000


class DiagnosticsDirInfo(BaseModel):
    path: str
    exists: bool
    entries: int | None = None
    entries_truncated: bool | None = None


class DiagnosticsRuntimeInfo(BaseModel):
    python: str
    implementation: str
    os: str
    machine: str
    executable: str
    desktop_session: bool
    sidecar_version: str


class DiagnosticsDirs(BaseModel):
    data: DiagnosticsDirInfo
    config: DiagnosticsDirInfo
    state: DiagnosticsDirInfo
    cache: DiagnosticsDirInfo
    workspace: DiagnosticsDirInfo
    agents: DiagnosticsDirInfo
    skills: DiagnosticsDirInfo


class DiagnosticsTeam(BaseModel):
    loaded: bool
    loadable: bool | None


class DiagnosticsMcp(BaseModel):
    servers: int


class DiagnosticsResponse(BaseModel):
    version: str
    app_env: str
    runtime: DiagnosticsRuntimeInfo
    dirs: DiagnosticsDirs
    providers: dict[str, bool]
    env: dict[str, str]
    team: DiagnosticsTeam
    mcp: DiagnosticsMcp
    log_tail: list[str]
    log_path: str
    error_log_path: str


def _annotation_contains_secret(annotation: object) -> bool:
    """Return True if ``annotation`` is ``SecretStr`` or a union containing it.

    Walks ``typing.get_args`` to handle ``SecretStr | None``,
    ``Optional[SecretStr]``, ``Annotated[SecretStr, …]``, and any combination
    thereof — across Python's three different union representations
    (``Union``, PEP 604 ``|``, and ``Optional``).
    """
    if annotation is SecretStr:
        return True
    args = typing.get_args(annotation)
    if not args:
        return False
    return any(_annotation_contains_secret(a) for a in args)


# Settings fields whose mere presence is sensitive (we report ``present:
# true/false`` instead of the value).
_SECRET_FIELDS: tuple[str, ...] = tuple(
    name
    for name, field in settings.__class__.model_fields.items()
    if _annotation_contains_secret(field.annotation)
)


def _truthy_secret(value: object) -> bool:
    """Return True if a SecretStr/str setting has a non-empty value."""
    if value is None:
        return False
    if isinstance(value, SecretStr):
        return bool(value.get_secret_value().strip())
    if isinstance(value, str):
        return bool(value.strip())
    return bool(value)


def _tail(path: Path, n: int = 200) -> list[str]:
    """Last ``n`` lines of ``path``, or empty list if the file is missing.

    Reads bytes from the end of the file rather than loading the whole
    log — important when the file is megabytes large.
    """
    if n <= 0 or not path.is_file():
        return []
    try:
        size = path.stat().st_size
        chunk = min(size, max(8192, n * 200))
        with path.open("rb") as f:
            f.seek(max(0, size - chunk))
            data = f.read()
        text = data.decode("utf-8", errors="replace")
        return text.splitlines()[-n:]
    except OSError:
        return []


def _dir_info(path: str) -> dict[str, Any]:
    p = Path(path)
    info: dict[str, Any] = {"path": str(p), "exists": p.exists()}
    if p.is_dir():
        try:
            count = 0
            truncated = False
            for _ in p.iterdir():
                count += 1
                if count >= _MAX_DIR_ENTRIES:
                    truncated = True
                    break
            info["entries"] = count
            if truncated:
                info["entries_truncated"] = True
        except OSError:
            info["entries"] = None
    return info


def _provider_status() -> dict[str, bool]:
    out: dict[str, bool] = {}
    for name in _SECRET_FIELDS:
        out[name] = _truthy_secret(getattr(settings, name, None))
    return out


def _safe_env_keys(allowed_prefixes: Iterable[str]) -> dict[str, str]:
    out: dict[str, str] = {}
    prefixes = tuple(allowed_prefixes)
    for k, v in os.environ.items():
        if not k.startswith(prefixes):
            continue
        # Even within allow-listed prefixes, never echo a value that
        # looks like a secret. Cheap heuristic: anything containing
        # ``KEY``, ``TOKEN``, ``SECRET``, ``PASSWORD`` gets boolean'd.
        upper = k.upper()
        if any(s in upper for s in ("KEY", "TOKEN", "SECRET", "PASSWORD")):
            out[k] = "<set>" if v.strip() else "<empty>"
        else:
            out[k] = v
    return out


@router.get("")
async def diagnostics(tail: int = 200) -> DiagnosticsResponse:
    """Return a redacted diagnostics snapshot.

    Query params:

    - ``tail`` (int, default 200): number of log lines to include
      from the app log.
    """
    tail = max(0, min(tail, 2000))

    from app.agent.mcp import mcp_manager
    from app.services import team_manager

    state_dir = Path(settings.OPENAGENTD_STATE_DIR)
    log_path = state_dir / "logs" / "app" / "app.log"
    error_log_path = state_dir / "logs" / "app" / "app-error.log"

    def _agents_dir_loadable() -> bool | None:
        """``True`` if the agents directory parses, ``False`` if missing/empty,
        ``None`` if it raises (treated as a soft 'unknown' in diagnostics)."""
        try:
            return team_manager.validate_agents_dir()
        except Exception:
            return None

    return DiagnosticsResponse(
        version=VERSION,
        app_env=settings.APP_ENV,
        runtime=DiagnosticsRuntimeInfo(
            python=sys.version.split()[0],
            implementation=platform.python_implementation(),
            os=platform.platform(),
            machine=platform.machine(),
            executable=sys.executable,
            desktop_session=bool(os.environ.get("OPENAGENTD_DESKTOP_TOKEN")),
            sidecar_version=VERSION,
        ),
        dirs=DiagnosticsDirs(
            data=DiagnosticsDirInfo(**_dir_info(settings.OPENAGENTD_DATA_DIR)),
            config=DiagnosticsDirInfo(**_dir_info(settings.OPENAGENTD_CONFIG_DIR)),
            state=DiagnosticsDirInfo(**_dir_info(settings.OPENAGENTD_STATE_DIR)),
            cache=DiagnosticsDirInfo(**_dir_info(settings.OPENAGENTD_CACHE_DIR)),
            workspace=DiagnosticsDirInfo(
                **_dir_info(settings.OPENAGENTD_WORKSPACE_DIR)
            ),
            agents=DiagnosticsDirInfo(**_dir_info(settings.AGENTS_DIR)),
            skills=DiagnosticsDirInfo(**_dir_info(settings.SKILLS_DIR)),
        ),
        providers=_provider_status(),
        env=_safe_env_keys(("OPENAGENTD_", "APP_", "PYTHON")),
        team=DiagnosticsTeam(
            loaded=team_manager.current_team() is not None,
            loadable=_agents_dir_loadable(),
        ),
        mcp=DiagnosticsMcp(
            servers=len(mcp_manager.server_names()),
        ),
        log_tail=_tail(log_path, tail),
        log_path=str(log_path),
        error_log_path=str(error_log_path),
    )
