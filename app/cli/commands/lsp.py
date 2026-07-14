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
    print(f"  Python ty:    {'ready' if status.ty_available else 'missing'}")
    print(f"  Python ruff:  {'ready' if status.ruff_available else 'missing'}")
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
    if args.lsp_action == "install" and args.component == "typescript":
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
    raise SystemExit("Unknown LSP command")
