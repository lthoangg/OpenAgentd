"""``openagentd cleanup`` — prune generated artifacts."""

from __future__ import annotations

import argparse
import asyncio

from sqlalchemy.exc import OperationalError

from app.cli.ui import _bold, _cyan, _dim, _green, _yellow
from app.core.db import get_session
from app.services.artifact_cleanup import CleanupResult, cleanup_generated_artifacts


def _format_bytes(size: int) -> str:
    value = float(size)
    for unit in ("B", "KB", "MB", "GB"):
        if value < 1024 or unit == "GB":
            return f"{value:.1f} {unit}" if unit != "B" else f"{int(value)} B"
        value /= 1024
    return f"{value:.1f} GB"


def _is_missing_chat_sessions_table(exc: OperationalError) -> bool:
    detail = str(getattr(exc, "orig", exc)).lower()
    return "no such table" in detail and "chat_sessions" in detail


async def _cleanup_result(args: argparse.Namespace) -> tuple[CleanupResult, str | None]:
    async for db in get_session():
        try:
            result = await cleanup_generated_artifacts(
                db,
                older_than_days=args.older_than_days,
                dry_run=args.dry_run,
            )
        except OperationalError as exc:
            if not _is_missing_chat_sessions_table(exc):
                raise
            result = CleanupResult(dry_run=args.dry_run, candidates=[], deleted=[])
            return (
                result,
                "Database not initialized yet; session-backed cleanup was skipped.",
            )
        return result, None

    return CleanupResult(dry_run=args.dry_run, candidates=[], deleted=[]), None


async def _run_cleanup(args: argparse.Namespace) -> None:
    result, warning = await _cleanup_result(args)

    mode = "dry run" if result.dry_run else "deleted"
    print(f"  {_bold(_cyan('Generated artifact cleanup'))} ({mode})")
    print(f"  {_dim('Expired sessions:')} {result.expired_sessions}")
    print(f"  {_dim('Expired messages:')} {result.expired_messages}")
    print(f"  {_dim('Candidates:')} {len(result.candidates)}")
    print(f"  {_dim('Total:')}      {_format_bytes(result.total_bytes)}")

    if warning:
        print(f"  {_yellow(warning)}")

    if result.dry_run:
        print(
            f"  {_yellow('No files deleted.')} Re-run with {_bold('--apply')} to delete."
        )
    else:
        print(f"  {_green('Deleted')} {len(result.deleted)} paths.")


def cmd_cleanup(args: argparse.Namespace) -> None:
    """Run generated artifact cleanup."""
    asyncio.run(_run_cleanup(args))
