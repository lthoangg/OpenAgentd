"""Retention sweep for out-of-tree workspace snapshot repositories.

Snapshots are anchored through ``refs/openagentd/snapshots/*`` so the object
store can be repacked without deleting live undo/redo points. This sweep
derives the live set from the database, reclaims everything else, and caps
each session repo so a long-running session cannot grow without bound.

Defaults
--------
- Enabled                          (``SNAPSHOT_MAINTENANCE_ENABLED``)
- Sweep every 6 h                   (``SNAPSHOT_MAINTENANCE_INTERVAL_HOURS``)
- First sweep 60 s after boot       (``SNAPSHOT_MAINTENANCE_START_DELAY_SECONDS``)
- 256 MiB per session repo          (``SNAPSHOT_MAX_BYTES``)

The sweeper is a background asyncio task started in the FastAPI lifespan. It
runs one sweep shortly after boot, then sleeps until the next interval.
Failures in one session do not abort the sweep; they are logged and skipped.
"""

from __future__ import annotations

import asyncio
import os
from dataclasses import dataclass

from loguru import logger
from sqlmodel import col, select
from sqlmodel.ext.asyncio.session import AsyncSession

from app.models.chat import ChatSession, SessionMessage
from app.services import snapshot_service
from app.services.chat_service_revert import message_snapshot, order_by_pos, redo_anchor


# ── Config helpers (env-driven, no Settings dependency) ──────────────────────


def _int_env(name: str, default: int, *, min_value: int = 0) -> int:
    raw = os.getenv(name)
    if raw is None:
        return default
    try:
        value = int(raw)
    except ValueError:
        return default
    return max(min_value, value)


def _bool_env(name: str, default: bool) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def _maintenance_enabled() -> bool:
    return _bool_env("SNAPSHOT_MAINTENANCE_ENABLED", True)


def _interval_seconds() -> float:
    hours = _int_env("SNAPSHOT_MAINTENANCE_INTERVAL_HOURS", 6, min_value=1)
    return float(hours * 3600)


def _start_delay_seconds() -> float:
    return float(_int_env("SNAPSHOT_MAINTENANCE_START_DELAY_SECONDS", 60))


def _max_bytes() -> int:
    return _int_env("SNAPSHOT_MAX_BYTES", 256 * 1024 * 1024, min_value=0)


# ── Keep-set + sweep ─────────────────────────────────────────────────────────


@dataclass(frozen=True)
class SnapshotSweepResult:
    """Summary of one snapshot-maintenance pass."""

    sessions: int = 0
    freed_bytes: int = 0


async def collect_keep_snapshots(
    db: AsyncSession, session_id
) -> tuple[list[str], list[str]]:
    """Return ``(ordered_keep, protected)`` snapshot hashes for a session.

    ``ordered_keep`` lists every snapshot a retained message row still points
    at, oldest first. Undone rows count: redo restores their snapshots. The
    redo anchor is *protected* because dropping it would strand a pending
    ``/redo``.
    """
    rows = (
        await db.exec(
            order_by_pos(
                select(SessionMessage).where(
                    col(SessionMessage.session_id) == session_id
                )
            )
        )
    ).all()
    ordered: list[str] = []
    for row in rows:
        snapshot = message_snapshot(row)
        if snapshot and snapshot not in ordered:
            ordered.append(snapshot)
    session = await db.get(ChatSession, session_id)
    anchor = redo_anchor(session)
    return ordered, ([anchor] if anchor else [])


async def sweep_snapshots(
    db: AsyncSession, *, max_bytes: int | None = None
) -> SnapshotSweepResult:
    """Prune every live session's snapshot repo to its database references."""
    session_ids = (await db.exec(select(ChatSession.id))).all()
    sessions = 0
    freed = 0
    for session_id in session_ids:
        sid = str(session_id)
        before = await snapshot_service.local_size_bytes(sid)
        if before == 0:
            continue
        ordered, protected = await collect_keep_snapshots(db, session_id)
        try:
            await snapshot_service.prune(
                sid, ordered, max_bytes=max_bytes, protected=protected
            )
        except Exception as exc:  # noqa: BLE001  one session never aborts the sweep
            logger.warning(
                "snapshot_maintenance_session_failed session_id={} error={}",
                sid,
                exc,
            )
            continue
        sessions += 1
        after = await snapshot_service.local_size_bytes(sid)
        if after < before:
            freed += before - after
    logger.info(
        "snapshot_maintenance_swept sessions={} freed_bytes={}", sessions, freed
    )
    return SnapshotSweepResult(sessions=sessions, freed_bytes=freed)


async def run_snapshot_maintenance_once() -> SnapshotSweepResult:
    """Open a database session and run one sweep."""
    from app.core.db import async_session_factory

    try:
        max_bytes = _max_bytes()
    except Exception:  # noqa: BLE001  defensive: never abort the loop
        max_bytes = None
    async with async_session_factory() as db:
        return await sweep_snapshots(db, max_bytes=max_bytes or None)


# ── Background scheduler ─────────────────────────────────────────────────────


_task: asyncio.Task[None] | None = None


async def _maintenance_loop() -> None:
    interval = _interval_seconds()
    delay = _start_delay_seconds()
    if delay:
        await asyncio.sleep(delay)
    while True:
        try:
            await run_snapshot_maintenance_once()
        except Exception as exc:  # noqa: BLE001  never kill the scheduler
            logger.warning("snapshot_maintenance_failed error={}", exc)
        try:
            await asyncio.sleep(interval)
        except asyncio.CancelledError:
            raise


def start_snapshot_maintenance() -> None:
    """Launch the background snapshot-maintenance task. Idempotent."""
    global _task
    if not _maintenance_enabled():
        logger.info("snapshot_maintenance_disabled")
        return
    if _task is not None and not _task.done():
        return
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        # No event loop yet — skip silently; called from a non-async context.
        return
    _task = loop.create_task(_maintenance_loop(), name="snapshot-maintenance")
    logger.info(
        "snapshot_maintenance_started interval_h={} max_bytes={}",
        int(_interval_seconds() // 3600),
        _max_bytes(),
    )


async def stop_snapshot_maintenance() -> None:
    """Cancel the background task, if any."""
    global _task
    if _task is None:
        return
    _task.cancel()
    try:
        await _task
    except asyncio.CancelledError:
        pass
    finally:
        _task = None
