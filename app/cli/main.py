"""Argument parser and ``main()`` entry point for the ``openagentd`` CLI.

All command implementations live in :mod:`app.cli.commands`; this module
only wires them up to ``argparse`` subparsers.
"""

from __future__ import annotations

import argparse

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
from app.core.version import VERSION


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="openagentd",
        description="OpenAgentd — on-machine AI agent platform",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "Examples:\n"
            "  openagentd init           # first-time setup (provider, API key, config)\n"
            "  openagentd migrate openclaw --from ~/.openclaw/workspace --model openai:gpt-5.5\n"
            "  openagentd auth copilot   # authenticate with an OAuth provider\n"
            "  openagentd                # start in background (production)\n"
            "  openagentd --dev          # start in foreground with hot-reload\n"
            "  openagentd stop           # stop background processes\n"
            "  openagentd status         # check if running\n"
            "  openagentd logs           # tail the server log\n"
            "  openagentd doctor         # check system health\n"
            "  openagentd upgrade        # upgrade to the latest version\n"
        ),
    )
    parser.add_argument("--version", action="version", version=f"openagentd v{VERSION}")
    parser.add_argument(
        "--dev", action="store_true", help="Foreground mode with hot-reload"
    )
    parser.add_argument(
        "--host", default="127.0.0.1", help="Bind host (default: 127.0.0.1)"
    )
    # Port default is mode-dependent: 4082 in production (single bundled
    # server), 8000 in --dev so Vite's hard-coded `/api → :8000` proxy
    # (web/vite.config.ts) and the `make dev` workflow line up. Resolved
    # in cmd_start() so an explicit --port still overrides everything.
    parser.add_argument(
        "--port",
        type=int,
        default=None,
        help="API port (default: 8000 in --dev, 4082 otherwise)",
    )
    parser.add_argument(
        "--web-port",
        dest="web_port",
        type=int,
        default=5173,
        help="Web UI port (default: 5173)",
    )
    parser.set_defaults(func=cmd_start)

    sub = parser.add_subparsers(dest="command", metavar="command")

    # ── init ──────────────────────────────────────────────────────────────────
    p_init = sub.add_parser(
        "init",
        help="First-time setup: write .env and seed config files",
    )
    p_init.add_argument(
        "--dev",
        action="store_true",
        help="Set up for development mode (.env in project root, .openagentd/ tree)",
    )
    p_init.set_defaults(func=cmd_init)

    # ── migrate ───────────────────────────────────────────────────────────────
    p_migrate = sub.add_parser(
        "migrate",
        help="Import agent config from another local agent tool",
    )
    p_migrate.add_argument(
        "source",
        choices=("openclaw",),
        help="Source format to import",
    )
    p_migrate.add_argument(
        "--from",
        dest="from_dir",
        default="~/.openclaw/workspace",
        help="OpenClaw workspace directory (default: ~/.openclaw/workspace)",
    )
    p_migrate.add_argument(
        "--model",
        required=True,
        help="OpenAgentd model id, e.g. openai:gpt-5.5",
    )
    p_migrate.add_argument(
        "--name",
        default="openclaw",
        help="Name for the imported lead agent (default: openclaw)",
    )
    p_migrate.add_argument(
        "--config-dir",
        help="OpenAgentd config directory (default: XDG config, or .openagentd/config with --dev)",
    )
    p_migrate.add_argument(
        "--force",
        action="store_true",
        help="Replace an existing imported agent file",
    )
    p_migrate.add_argument(
        "--dev",
        action="store_true",
        help="Use development config dir (.openagentd/config)",
    )
    p_migrate.set_defaults(func=cmd_migrate)

    # ── auth ──────────────────────────────────────────────────────────────────
    p_auth = sub.add_parser(
        "auth",
        help="Authenticate with an OAuth-based LLM provider",
    )
    p_auth.add_argument(
        "provider",
        nargs="?",
        help="Provider to authenticate (e.g. copilot)",
    )
    p_auth.add_argument(
        "--list",
        action="store_true",
        dest="list_providers",
        help="List available OAuth providers",
    )
    p_auth.set_defaults(func=cmd_auth)

    # ── stop ──────────────────────────────────────────────────────────────────
    sub.add_parser("stop", help="Stop background server and web UI").set_defaults(
        func=cmd_stop
    )

    # ── status ────────────────────────────────────────────────────────────────
    sub.add_parser("status", help="Show whether the server is running").set_defaults(
        func=cmd_status
    )

    # ── logs ──────────────────────────────────────────────────────────────────
    p_logs = sub.add_parser("logs", help="Tail the server log")
    p_logs.add_argument(
        "-n",
        "--lines",
        type=int,
        default=50,
        help="Lines to show initially (default: 50)",
    )
    p_logs.set_defaults(func=cmd_logs)

    # ── version ───────────────────────────────────────────────────────────────
    sub.add_parser("version", help="Print version and exit").set_defaults(
        func=cmd_version
    )

    # ── doctor ────────────────────────────────────────────────────────────────
    sub.add_parser("doctor", help="Check system health and report issues").set_defaults(
        func=cmd_doctor
    )

    # ── update / upgrade ──────────────────────────────────────────────────────
    for _alias in ("update", "upgrade"):
        sub.add_parser(
            _alias, help="Upgrade openagentd to the latest version"
        ).set_defaults(func=cmd_update)

    return parser


def main() -> None:
    parser = build_parser()
    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
