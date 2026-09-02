"""openagentd — unified CLI entry point.

Usage
-----
  openagentd               Start server + web UI in the background
  openagentd server        Start, stop, and inspect the background server
  openagentd auth          Authenticate with an OAuth-based provider (e.g. copilot)
  openagentd transfer      Import, export, or migrate agent configuration
  openagentd doctor        Check system health and report issues
  openagentd lsp           Inspect or install managed language servers
  openagentd upgrade       Upgrade openagentd to the latest version

This package replaces the former monolithic ``app/cli.py`` module.  The
package-level ``__init__`` re-exports the public (and legacy-private) API so
that ``openagentd = "app.cli:main"`` and existing test imports keep working.

Re-exports are lazy (PEP 562): every CLI invocation pays this package's
import cost, and the eager command imports used to pull the whole server
stack (measured ~1.05s, ~75% of it through the artifact_cleanup →
api.routes.agent chain) before even parsing ``--version``. Command modules
are now imported on first attribute access or at dispatch time in
:mod:`app.cli.main`.
"""

from __future__ import annotations

import os
from typing import Any

# The installed CLI is a production launcher. Set this before importing command
# modules because they transitively construct the global settings object.
os.environ.setdefault("APP_ENV", "production")

#: name → defining module for every lazy re-export.
_LAZY_EXPORTS: dict[str, str] = {
    "build_parser": "app.cli.main",
    "main": "app.cli.main",
    # commands — resolved to the lazy dispatchers in app.cli.main so that
    # ``app.cli.cmd_x is parser_args.func`` identity holds. The dispatchers
    # import the real command module only when invoked.
    "cmd_auth": "app.cli.main",
    "cmd_cleanup": "app.cli.main",
    "cmd_doctor": "app.cli.main",
    "cmd_health": "app.cli.main",
    "cmd_logs": "app.cli.main",
    "cmd_migrate": "app.cli.main",
    "cmd_restart": "app.cli.main",
    "cmd_run": "app.cli.main",
    "cmd_start": "app.cli.main",
    "cmd_status": "app.cli.main",
    "cmd_stop": "app.cli.main",
    "cmd_upgrade": "app.cli.main",
    # path helpers (kept public for tests)
    "_config_dir": "app.cli.paths",
    "_data_dir": "app.cli.paths",
    "_pid_file": "app.cli.paths",
    "_server_log": "app.cli.paths",
    "_state_dir": "app.cli.paths",
    "_web_log": "app.cli.paths",
    # pid helpers
    "_clear_pids": "app.cli.pids",
    "_find_pids": "app.cli.pids",
    "_pid_alive": "app.cli.pids",
    "_read_pids": "app.cli.pids",
    "_write_pids": "app.cli.pids",
}

__all__ = list(_LAZY_EXPORTS)


def __getattr__(name: str) -> Any:
    """Resolve re-exports on first access (PEP 562 module ``__getattr__``)."""
    module_name = _LAZY_EXPORTS.get(name)
    if module_name is None:
        raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
    from importlib import import_module

    value = getattr(import_module(module_name), name)
    globals()[name] = value  # cache — __getattr__ won't fire for it again
    return value


def __dir__() -> list[str]:
    return sorted(set(globals()) | set(_LAZY_EXPORTS))
