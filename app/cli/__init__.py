"""openagentd — unified CLI entry point.

Usage
-----
  openagentd               Start server + web UI in the background (production)
  openagentd --dev         Start server + web UI in the foreground with hot-reload
  openagentd init          First-time setup: write .env and seed config files
  openagentd migrate       Import agent config from another local agent tool
  openagentd auth          Authenticate with an OAuth-based provider (e.g. copilot)
  openagentd stop          Stop the background server and web UI
  openagentd status        Show whether the server is running
  openagentd logs          Tail the server log
  openagentd version       Print version and exit
  openagentd doctor        Check system health and report issues
  openagentd update        Update openagentd to the latest version

This package replaces the former monolithic ``app/cli.py`` module.  The
package-level ``__init__`` re-exports the public (and legacy-private) API so
that ``openagentd = "app.cli:main"`` and existing test imports keep working.
"""

from __future__ import annotations

from app.cli.commands.auth import cmd_auth
from app.cli.commands.doctor import cmd_doctor
from app.cli.commands.init import cmd_init
from app.cli.commands.logs import cmd_logs
from app.cli.commands.migrate import cmd_migrate
from app.cli.commands.start import cmd_start
from app.cli.commands.status import cmd_status
from app.cli.commands.stop import cmd_stop
from app.cli.commands.update import cmd_update
from app.cli.commands.version import cmd_version
from app.cli.main import build_parser, main
from app.cli.paths import (
    _config_dir,
    _data_dir,
    _pid_file,
    _server_log,
    _state_dir,
    _web_log,
)
from app.cli.pids import (
    _clear_pids,
    _find_pids,
    _pid_alive,
    _read_pids,
    _write_pids,
)

__all__ = [
    "build_parser",
    "main",
    # commands
    "cmd_auth",
    "cmd_doctor",
    "cmd_init",
    "cmd_logs",
    "cmd_migrate",
    "cmd_start",
    "cmd_status",
    "cmd_stop",
    "cmd_update",
    "cmd_version",
    # path helpers (kept public for tests)
    "_config_dir",
    "_data_dir",
    "_pid_file",
    "_server_log",
    "_state_dir",
    "_web_log",
    # pid helpers
    "_clear_pids",
    "_find_pids",
    "_pid_alive",
    "_read_pids",
    "_write_pids",
]
