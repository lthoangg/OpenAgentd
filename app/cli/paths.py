"""XDG-aware directory resolvers and standard log/PID file paths.

Uses the XDG base-directory layout under ``$HOME``.  Each resolver honours an
``OPENAGENTD_*`` env var override so tests (and power users) can redirect paths.
"""

from __future__ import annotations

import os
from pathlib import Path

_ROOT = Path(__file__).resolve().parent.parent.parent
_WEB_DIR = _ROOT / "web"


def _state_dir() -> Path:
    """Return the state directory (logs, pid files).

    Defaults to ``~/.local/state/openagentd`` (XDG_STATE_HOME). Respects an
    explicit ``OPENAGENTD_STATE_DIR`` env var.
    """
    if "OPENAGENTD_STATE_DIR" in os.environ:
        return Path(os.environ["OPENAGENTD_STATE_DIR"])
    return Path.home() / ".local" / "state" / "openagentd"


def _data_dir() -> Path:
    """Return the data directory (DB, workspaces).

    Defaults to ``~/.local/share/openagentd`` (XDG_DATA_HOME).
    """
    if "OPENAGENTD_DATA_DIR" in os.environ:
        return Path(os.environ["OPENAGENTD_DATA_DIR"])
    return Path.home() / ".local" / "share" / "openagentd"


def _config_dir() -> Path:
    """Return the config directory (agents, skills, .env).

    Defaults to ``~/.config/openagentd`` (XDG_CONFIG_HOME).
    """
    if "OPENAGENTD_CONFIG_DIR" in os.environ:
        return Path(os.environ["OPENAGENTD_CONFIG_DIR"])
    return Path.home() / ".config" / "openagentd"


def _pid_file() -> Path:
    return _state_dir() / "openagentd.pid"


def _server_log() -> Path:
    return _state_dir() / "logs" / "app" / "app.log"


def _server_error_log() -> Path:
    return _state_dir() / "logs" / "app" / "app-error.log"


def _web_log() -> Path:
    return _state_dir() / "logs" / "web.log"
