"""Argument parser and ``main()`` entry point for the ``openagentd`` CLI.

All command implementations live in :mod:`app.cli.commands`; this module
only wires them up to ``argparse`` subparsers.
"""

from __future__ import annotations

import argparse
from collections.abc import Callable
from pathlib import Path

from app.core.version import VERSION


def _lazy_cmd(module: str, attr: str) -> Callable[[argparse.Namespace], object]:
    """Return a dispatcher that imports the command module at call time.

    Every CLI invocation builds the full parser, so eager ``cmd_*`` imports
    made ``openagentd --version`` pay for the whole server stack (~1.05s
    measured, ~75% through the artifact_cleanup → api.routes.team chain).
    Importing inside the dispatcher defers that cost to the one command
    that actually runs.
    """

    def _dispatch(args: argparse.Namespace) -> object:
        from importlib import import_module

        return getattr(import_module(module), attr)(args)

    return _dispatch


cmd_address = _lazy_cmd("app.cli.commands.address", "cmd_address")
cmd_auth = _lazy_cmd("app.cli.commands.auth", "cmd_auth")
cmd_cleanup = _lazy_cmd("app.cli.commands.cleanup", "cmd_cleanup")
cmd_doctor = _lazy_cmd("app.cli.commands.doctor", "cmd_doctor")
cmd_export = _lazy_cmd("app.cli.commands.export", "cmd_export")
cmd_health = _lazy_cmd("app.cli.commands.health", "cmd_health")
cmd_import = _lazy_cmd("app.cli.commands.importcmd", "cmd_import")
cmd_logs = _lazy_cmd("app.cli.commands.logs", "cmd_logs")
cmd_lsp = _lazy_cmd("app.cli.commands.lsp", "cmd_lsp")
cmd_migrate = _lazy_cmd("app.cli.commands.migrate", "cmd_migrate")
cmd_restart = _lazy_cmd("app.cli.commands.restart", "cmd_restart")
cmd_start = _lazy_cmd("app.cli.commands.start", "cmd_start")
cmd_status = _lazy_cmd("app.cli.commands.status", "cmd_status")
cmd_stop = _lazy_cmd("app.cli.commands.stop", "cmd_stop")
cmd_upgrade = _lazy_cmd("app.cli.commands.upgrade", "cmd_upgrade")


def _add_serve_subparser(sub: argparse._SubParsersAction) -> None:
    """Defer :mod:`app.cli.commands.serve` import to parser build time."""
    from app.cli.commands.serve import _add_serve_subparser as _add

    _add(sub)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="openagentd",
        description="OpenAgentd — on-machine AI agent platform",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "Examples:\n"
            "  openagentd server start --lan --key  # start for mobile/LAN clients\n"
            "  openagentd server status             # check the background server\n"
            "  openagentd auth copilot              # authenticate with an OAuth provider\n"
            "  openagentd transfer migrate openclaw --from ~/.openclaw/workspace --model openai:gpt-5.5\n"
            "  openagentd transfer export           # pack config for migration\n"
            "  openagentd doctor                    # check system health\n"
            "  openagentd lsp status                # inspect managed language servers\n"
            "  openagentd upgrade                   # upgrade to the latest version\n"
        ),
    )
    parser.add_argument("--version", action="version", version=f"openagentd v{VERSION}")
    parser.set_defaults(
        func=cmd_start,
        host=None,
        port=None,
        lan=False,
        key=False,
        wait=False,
        watch=False,
    )

    sub = parser.add_subparsers(dest="command", metavar="command")

    # ── transfer ────────────────────────────────────────────────────────────
    p_transfer = sub.add_parser(
        "transfer", help="Move agent configuration between installations"
    )
    transfer_sub = p_transfer.add_subparsers(dest="transfer_action", required=True)

    # ── migrate ───────────────────────────────────────────────────────────────
    p_migrate = transfer_sub.add_parser(
        "migrate",
        help="Import agent config from another local agent tool",
    )
    p_migrate.add_argument(
        "source",
        choices=("openclaw", "hermes"),
        help="Source format to import",
    )
    p_migrate.add_argument(
        "--from",
        dest="from_dir",
        help="Source directory (defaults to ~/.openclaw/workspace or ~/.hermes)",
    )
    p_migrate.add_argument(
        "--model",
        required=True,
        help="OpenAgentd model id, e.g. openai:gpt-5.5",
    )
    p_migrate.add_argument(
        "--name",
        help="Name for the imported lead agent (default: source name)",
    )
    p_migrate.add_argument(
        "--config-dir",
        help="OpenAgentd config directory (default: XDG config)",
    )
    p_migrate.add_argument(
        "--force",
        action="store_true",
        help="Replace an existing imported agent file",
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
    p_auth.add_argument(
        "--device",
        action="store_true",
        help="Use the headless device-code flow when the provider supports it",
    )
    p_auth.set_defaults(func=cmd_auth)

    def add_start_flags(
        p: argparse.ArgumentParser,
        *,
        include_key: bool = True,
        include_wait: bool = True,
    ) -> None:
        p.add_argument(
            "--host",
            default=argparse.SUPPRESS,
            help="Bind host (default: server.yaml host)",
        )
        p.add_argument(
            "--port",
            type=int,
            default=argparse.SUPPRESS,
            help="API port (default: server.yaml port)",
        )
        p.add_argument(
            "--lan",
            action="store_true",
            default=argparse.SUPPRESS,
            help="Bind on all interfaces for mobile/LAN clients (sets --host 0.0.0.0)",
        )
        if include_key:
            p.add_argument(
                "--key",
                action="store_true",
                default=argparse.SUPPRESS,
                help="Prompt for an access key required by external clients.",
            )
        if include_wait:
            p.add_argument(
                "--wait",
                action="store_true",
                default=argparse.SUPPRESS,
                help="Wait/poll until the background server is fully started and ready.",
            )
            p.add_argument(
                "--watch",
                action="store_true",
                default=argparse.SUPPRESS,
                help="Alias for --wait.",
            )

    # ── server ──────────────────────────────────────────────────────────────
    p_server = sub.add_parser("server", help="Run and inspect the API server")
    server_sub = p_server.add_subparsers(dest="server_action", required=True)

    # ── start ─────────────────────────────────────────────────────────────────
    p_start = server_sub.add_parser("start", help="Start the background server")
    add_start_flags(p_start)
    p_start.set_defaults(func=cmd_start)

    # ── serve (foreground; for desktop / embedding) ───────────────────────────
    _add_serve_subparser(server_sub)

    # ── stop ──────────────────────────────────────────────────────────────────
    server_sub.add_parser("stop", help="Stop the background server").set_defaults(
        func=cmd_stop
    )

    # ── restart ───────────────────────────────────────────────────────────────
    p_restart = server_sub.add_parser("restart", help="Restart the background server")
    add_start_flags(p_restart)
    p_restart.set_defaults(func=cmd_restart)

    # ── status ────────────────────────────────────────────────────────────────
    p_status = server_sub.add_parser(
        "status", help="Show whether the server is running"
    )
    add_start_flags(p_status, include_key=False, include_wait=False)
    p_status.set_defaults(func=cmd_status)

    # ── address ───────────────────────────────────────────────────────────────
    p_address = server_sub.add_parser("address", help="Show local and LAN server URLs")
    add_start_flags(p_address, include_key=False, include_wait=False)
    p_address.set_defaults(func=cmd_address)

    # ── health ────────────────────────────────────────────────────────────────
    p_health = server_sub.add_parser("health", help="Run server and mobile diagnostics")
    add_start_flags(p_health, include_key=False, include_wait=False)
    p_health.set_defaults(func=cmd_health)

    # ── logs ──────────────────────────────────────────────────────────────────
    p_logs = server_sub.add_parser("logs", help="Tail the server log")
    p_logs.add_argument(
        "-n",
        "--lines",
        type=int,
        default=50,
        help="Lines to show initially (default: 50)",
    )
    p_logs.set_defaults(func=cmd_logs)

    # ── lsp ──────────────────────────────────────────────────────────────────
    p_lsp = sub.add_parser("lsp", help="Inspect or install managed LSP tools")
    lsp_sub = p_lsp.add_subparsers(dest="lsp_action", required=True)
    lsp_sub.add_parser("status", help="Show managed LSP tool status")
    p_lsp_install = lsp_sub.add_parser(
        "install", help="Install a managed LSP component"
    )
    p_lsp_install.add_argument("component", choices=("typescript", "python"))
    p_lsp_install.add_argument(
        "tool",
        nargs="?",
        choices=("ruff", "ty"),
        help="Python tool to install (ruff | ty) — required for component=python",
    )
    p_lsp_install.add_argument(
        "--version",
        default=None,
        help="Exact PyPI version to install (default: latest when unpinned)",
    )
    p_lsp_install.add_argument(
        "--force",
        action="store_true",
        help="Re-download even when the version is already installed",
    )
    p_lsp.set_defaults(func=cmd_lsp)

    # ── doctor ────────────────────────────────────────────────────────────────
    sub.add_parser("doctor", help="Check system health and report issues").set_defaults(
        func=cmd_doctor
    )

    # ── cleanup ───────────────────────────────────────────────────────────────
    p_cleanup = sub.add_parser(
        "cleanup",
        help="Dry-run cleanup for generated artifacts",
    )
    p_cleanup.add_argument(
        "--older-than-days",
        type=int,
        default=14,
        help="Only delete artifacts older than this many days (default: 14)",
    )
    p_cleanup.add_argument(
        "--apply",
        action="store_false",
        dest="dry_run",
        help="Delete the listed artifacts instead of only printing them",
    )
    p_cleanup.add_argument(
        "--limit",
        type=int,
        default=50,
        help="Maximum candidate paths to print (default: 50)",
    )
    p_cleanup.set_defaults(func=cmd_cleanup, dry_run=True)

    # ── upgrade ───────────────────────────────────────────────────────────────
    sub.add_parser(
        "upgrade", help="Upgrade openagentd to the latest version"
    ).set_defaults(func=cmd_upgrade)

    # ── export ────────────────────────────────────────────────────────────────
    p_export = transfer_sub.add_parser(
        "export",
        help="Pack config for migration to another server (agents, skills, commands, …)",
        description=(
            "Creates a .tar.gz archive of your portable config layer — agents, skills,\n"
            "commands, plugins, mcp.json, settings.yaml, server.yaml, multimodal.yaml, and .env.\n"
            "\n"
            "Secrets in .env and server.yaml are redacted by default so the archive is safe to\n"
            "copy over untrusted channels. Use --include-secrets to embed them verbatim."
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    p_export.add_argument(
        "--output",
        metavar="PATH",
        help="Archive path (default: openagentd-export-<TIMESTAMP>.tar.gz in CWD)",
    )
    p_export.add_argument(
        "--include-secrets",
        action="store_true",
        dest="include_secrets",
        help="Embed API keys verbatim instead of redacting them (use over trusted channels only)",
    )
    p_export.add_argument(
        "--config-dir",
        metavar="DIR",
        dest="config_dir",
        help="Config directory to export (default: XDG config)",
    )
    p_export.set_defaults(func=cmd_export)

    # ── import ────────────────────────────────────────────────────────────────
    p_import = transfer_sub.add_parser(
        "import",
        help="Unpack a migration archive on the target server",
        description=(
            "Extracts an archive produced by `openagentd transfer export` into your config\n"
            "directory. Existing files are kept by default (fill-in-gaps); pass\n"
            "--force to overwrite them."
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    p_import.add_argument(
        "archive",
        metavar="ARCHIVE",
        help="Path to the .tar.gz archive produced by `openagentd transfer export`",
    )
    p_import.add_argument(
        "--force",
        action="store_true",
        help="Overwrite files that already exist in the config directory",
    )
    p_import.add_argument(
        "--config-dir",
        metavar="DIR",
        dest="config_dir",
        help="Config directory to import into (default: XDG config)",
    )
    p_import.set_defaults(func=cmd_import)

    return parser


def main() -> None:
    import os
    import sys

    if sys.argv and Path(sys.argv[0]).name == "openagentd":
        os.environ.setdefault("APP_ENV", "production")

    parser = build_parser()
    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
