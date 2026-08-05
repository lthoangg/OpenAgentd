"""Cleanup helpers for generated OpenAgentd artifacts."""

from __future__ import annotations

import asyncio
import shutil
from collections.abc import Iterable, Sequence
from stat import S_ISREG
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path
from uuid import UUID

from sqlalchemy.exc import OperationalError
from sqlmodel import col, delete, func, select
from sqlmodel.ext.asyncio.session import AsyncSession

from app.agent.artifacts import SESSIONS_DIR
from app.api.routes.team.worktrees import find_managed_worktree_source
from app.core.config import settings
from app.models.chat import ChatSession, SessionMessage
from app.services import snapshot_service


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
    expired_sessions: int = 0
    expired_messages: int = 0

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
        try:
            child_stat = child.stat()
        except OSError:
            continue
        if S_ISREG(child_stat.st_mode):
            total += child_stat.st_size
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


def _is_missing_chat_sessions_table(exc: OperationalError) -> bool:
    detail = str(getattr(exc, "orig", exc)).lower()
    return "no such table" in detail and "chat_sessions" in detail


@dataclass(frozen=True)
class _CleanupSession:
    id: UUID
    mode: str
    workspace: str | None
    created_at: datetime


async def _session_rows(db: AsyncSession) -> Sequence[_CleanupSession] | None:
    try:
        rows = (
            await db.exec(
                select(
                    ChatSession.id,
                    ChatSession.mode,
                    ChatSession.workspace,
                    ChatSession.created_at,
                )
            )
        ).all()
        return [_CleanupSession(*row) for row in rows]
    except OperationalError as exc:
        if not _is_missing_chat_sessions_table(exc):
            raise
        return None


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
    - app-managed session artifact directories whose DB session no longer exists;
    - old snapshot repositories for sessions whose DB rows are gone;
    - old managed git worktrees under ``OPENAGENTD_DATA_DIR/worktrees``.

    It intentionally does not delete config, cache credentials, or the DB.
    """
    cutoff = _older_than_cutoff(older_than_days)
    rows = await _session_rows(db)
    live_ids = {str(row.id) for row in rows} if rows is not None else set()
    expired_session_ids: set[str] = set()
    normal_session_ids: set[str] = set()
    coding_session_ids: set[str] = set()
    coding_workspaces: set[str] = set()
    if rows is not None:
        for row in rows:
            sid = str(row.id)
            if row.mode == "coding":
                coding_session_ids.add(sid)
                if row.workspace:
                    coding_workspaces.add(str(Path(row.workspace).resolve()))
            else:
                normal_session_ids.add(sid)
            if cutoff is not None and row.created_at < cutoff:
                expired_session_ids.add(sid)

    candidates: list[CleanupCandidate] = []

    workspace_root = Path(settings.OPENAGENTD_WORKSPACE_DIR)
    for child in _safe_child_dirs(workspace_root):
        if (
            _is_uuid(child.name)
            and child.name in expired_session_ids
            and child.name in normal_session_ids
        ):
            candidates.append(
                CleanupCandidate(
                    child,
                    "expired normal session workspace",
                    await asyncio.to_thread(_dir_size, child),
                )
            )
        elif (
            child.name not in live_ids
            and _is_uuid(child.name)
            and _is_old_enough(child, cutoff)
        ):
            candidates.append(
                CleanupCandidate(
                    child,
                    "orphaned normal session workspace",
                    await asyncio.to_thread(_dir_size, child),
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
                candidates.append(
                    CleanupCandidate(
                        child, reason, await asyncio.to_thread(_dir_size, child)
                    )
                )

    sessions_root = Path(settings.OPENAGENTD_DATA_DIR) / SESSIONS_DIR
    for child in _safe_child_dirs(sessions_root):
        if _is_uuid(child.name) and child.name in expired_session_ids:
            reason = (
                "expired coding session artifacts"
                if child.name in coding_session_ids
                else "expired session artifacts"
            )
            candidates.append(
                CleanupCandidate(
                    child, reason, await asyncio.to_thread(_dir_size, child)
                )
            )
        elif (
            child.name not in live_ids
            and _is_uuid(child.name)
            and _is_old_enough(child, cutoff)
        ):
            candidates.append(
                CleanupCandidate(
                    child,
                    "orphaned session artifacts",
                    await asyncio.to_thread(_dir_size, child),
                )
            )

    snapshot_root = Path(settings.OPENAGENTD_STATE_DIR) / "snapshot"
    for child in _safe_child_dirs(snapshot_root):
        if _is_uuid(child.name) and child.name in expired_session_ids:
            reason = (
                "expired coding session snapshots"
                if child.name in coding_session_ids
                else "expired session snapshots"
            )
            candidates.append(
                CleanupCandidate(
                    child, reason, await asyncio.to_thread(_dir_size, child)
                )
            )
        elif (
            child.name not in live_ids
            and _is_uuid(child.name)
            and _is_old_enough(child, cutoff)
        ):
            candidates.append(
                CleanupCandidate(
                    child,
                    "old session snapshots",
                    await asyncio.to_thread(_dir_size, child),
                )
            )

    worktrees_root = Path(settings.OPENAGENTD_DATA_DIR) / "worktrees"
    for repo_root in _safe_child_dirs(worktrees_root):
        for child in _safe_child_dirs(repo_root):
            resolved = str(child.resolve())
            if resolved in coding_workspaces:
                continue
            if _is_old_enough(child, cutoff) and await find_managed_worktree_source(
                child
            ):
                candidates.append(
                    CleanupCandidate(
                        child,
                        "old managed git worktrees",
                        await asyncio.to_thread(_dir_size, child),
                    )
                )

    deleted: list[Path] = []
    expired_messages = 0
    if expired_session_ids:
        expired_ids = [UUID(value) for value in expired_session_ids]
        expired_messages = (
            await db.exec(
                select(func.count())
                .select_from(SessionMessage)
                .where(col(SessionMessage.session_id).in_(expired_ids))
            )
        ).one()
    if not dry_run:
        if expired_session_ids:
            expired_ids = [UUID(value) for value in expired_session_ids]
            await db.exec(
                delete(SessionMessage).where(
                    col(SessionMessage.session_id).in_(expired_ids)
                )
            )
            await db.exec(
                delete(ChatSession).where(col(ChatSession.id).in_(expired_ids))
            )
            await db.commit()
        for candidate in candidates:
            await asyncio.to_thread(shutil.rmtree, candidate.path, ignore_errors=True)
            deleted.append(candidate.path)
            if candidate.reason in {
                "old session snapshots",
                "expired session snapshots",
            }:
                snapshot_service._locks.pop(candidate.path.name, None)

    return CleanupResult(
        dry_run=dry_run,
        candidates=candidates,
        deleted=deleted,
        expired_sessions=len(expired_session_ids),
        expired_messages=expired_messages,
    )
