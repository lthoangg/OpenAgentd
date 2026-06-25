"""Cleanup helpers for generated OpenAgentd artifacts."""

from __future__ import annotations

import shutil
from collections.abc import Iterable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path
from uuid import UUID

from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from app.agent.artifacts import SESSIONS_DIR
from app.core.config import settings
from app.models.chat import ChatSession


@dataclass(frozen=True)
class CleanupCandidate:
    """One path selected for cleanup."""

    path: Path
    reason: str
    bytes: int


@dataclass(frozen=True)
class CleanupResult:
    """Summary from an artifact cleanup pass."""

    dry_run: bool
    candidates: list[CleanupCandidate]
    deleted: list[Path]

    @property
    def total_bytes(self) -> int:
        return sum(candidate.bytes for candidate in self.candidates)


def _older_than_cutoff(days: int | None) -> datetime | None:
    if days is None:
        return None
    return datetime.now(UTC) - timedelta(days=days)


def _path_mtime(path: Path) -> datetime:
    return datetime.fromtimestamp(path.stat().st_mtime, UTC)


def _is_old_enough(path: Path, cutoff: datetime | None) -> bool:
    return cutoff is None or _path_mtime(path) < cutoff


def _dir_size(path: Path) -> int:
    if path.is_file():
        return path.stat().st_size
    total = 0
    for child in path.rglob("*"):
        if child.is_file():
            try:
                total += child.stat().st_size
            except OSError:
                continue
    return total


def _safe_child_dirs(root: Path) -> Iterable[Path]:
    if not root.exists() or not root.is_dir():
        return []
    return (child for child in root.iterdir() if child.is_dir())


def _is_uuid(value: str) -> bool:
    try:
        UUID(value)
    except ValueError:
        return False
    return True


async def cleanup_generated_artifacts(
    db: AsyncSession,
    *,
    older_than_days: int | None = None,
    dry_run: bool = True,
) -> CleanupResult:
    """Clean generated artifacts that are safe to derive or delete.

    The pass targets:
    - normal session workspaces whose DB session no longer exists;
    - app-managed state logs/telemetry/OTEL directories older than the cutoff;
    - app-managed session artifact directories whose DB session no longer exists.

    It intentionally does not delete config, cache credentials, or the DB.
    """
    cutoff = _older_than_cutoff(older_than_days)
    rows = (await db.exec(select(ChatSession))).all()
    live_ids = {str(row.id) for row in rows}

    candidates: list[CleanupCandidate] = []

    workspace_root = Path(settings.OPENAGENTD_WORKSPACE_DIR)
    for child in _safe_child_dirs(workspace_root):
        if (
            child.name not in live_ids
            and _is_uuid(child.name)
            and _is_old_enough(child, cutoff)
        ):
            candidates.append(
                CleanupCandidate(
                    child, "orphaned normal session workspace", _dir_size(child)
                )
            )

    state_root = Path(settings.OPENAGENTD_STATE_DIR)
    for rel, reason in (
        (Path("logs") / "sessions", "old session logs"),
        (Path("telemetry"), "old telemetry files"),
        (Path("otel"), "old otel files"),
    ):
        root = state_root / rel
        for child in _safe_child_dirs(root):
            if _is_old_enough(child, cutoff):
                candidates.append(CleanupCandidate(child, reason, _dir_size(child)))

    sessions_root = Path(settings.OPENAGENTD_DATA_DIR) / SESSIONS_DIR
    for child in _safe_child_dirs(sessions_root):
        if (
            child.name not in live_ids
            and _is_uuid(child.name)
            and _is_old_enough(child, cutoff)
        ):
            candidates.append(
                CleanupCandidate(child, "orphaned session artifacts", _dir_size(child))
            )

    deleted: list[Path] = []
    if not dry_run:
        for candidate in candidates:
            shutil.rmtree(candidate.path, ignore_errors=True)
            deleted.append(candidate.path)

    return CleanupResult(dry_run=dry_run, candidates=candidates, deleted=deleted)
