from __future__ import annotations

import argparse
import asyncio

from app.services.lsp.managed import (
    TYPESCRIPT_LANGUAGE_SERVER_VERSION,
    TYPESCRIPT_VERSION,
    ManagedLspStatus,
    managed_lsp_tools,
)


def _print_status(status: ManagedLspStatus) -> None:
    print("\n  OpenAgentd LSP tools\n")
    for name, available in (
        ("ty", status.ty_available),
        ("ruff", status.ruff_available),
    ):
        managed_version = managed_lsp_tools.python_tool_version(name)
        suffix = f" (managed {managed_version})" if managed_version else ""
        print(f"  Python {name:4s}: {'ready' if available else 'missing'}{suffix}")
    print(
        "  TypeScript:    "
        f"{status.state} (language-server {TYPESCRIPT_LANGUAGE_SERVER_VERSION}, "
        f"typescript {TYPESCRIPT_VERSION})"
    )
    if status.detail:
        print(f"  Detail:        {status.detail}")
    if not status.downloads_enabled:
        print("  Downloads:     disabled by OPENAGENTD_DISABLE_LSP_DOWNLOAD")
    print()


def cmd_lsp(args: argparse.Namespace) -> None:
    if args.lsp_action == "status":
        _print_status(managed_lsp_tools.status())
        return
    if args.lsp_action == "install":
        if args.component == "typescript":
            try:
                status = asyncio.run(managed_lsp_tools.install_typescript())
            except (PermissionError, RuntimeError, ValueError) as exc:
                raise SystemExit(f"TypeScript LSP installation failed: {exc}") from exc
            except Exception as exc:
                raise SystemExit(
                    "TypeScript LSP installation failed; check backend logs."
                ) from exc
            _print_status(status)
            return
        if args.component == "python":
            if args.tool not in {"ruff", "ty"}:
                raise SystemExit(
                    "Usage: openagentd lsp install python <ruff|ty> "
                    "[--version X] [--force]"
                )
            try:
                command = asyncio.run(
                    managed_lsp_tools.install_python_tool(
                        args.tool, args.version, force=args.force
                    )
                )
            except (RuntimeError, ValueError) as exc:
                raise SystemExit(f"Python LSP installation failed: {exc}") from exc
            except Exception as exc:
                raise SystemExit(
                    "Python LSP installation failed; check backend logs."
                ) from exc
            print(f"Installed {args.tool} -> {' '.join(command)}")
            _print_status(managed_lsp_tools.status())
            return
    raise SystemExit("Unknown LSP command")
