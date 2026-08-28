"""Agent spawning service for isolated worktree child sessions."""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
from pathlib import Path
from uuid import UUID

from loguru import logger
from sqlmodel import col, select
from sqlmodel.ext.asyncio.session import AsyncSession

import app.core.db as db_module
from app.models.chat import ChatSession
from app.services import team_manager
from app.services.worktree_service import (
    create_worktree,
    remove_worktree,
    require_git_repo,
    slugify,
)

MAX_CONCURRENT_CHILDREN = 5
MAX_SPAWN_DEPTH = 2
_spawn_locks: dict[str, asyncio.Lock] = {}


class SpawnError(Exception):
    """Base exception for agent spawning failures."""


class MaxConcurrentChildrenError(SpawnError):
    """Raised when the maximum number of concurrent running children is reached."""


class MaxSpawnDepthError(SpawnError):
    """Raised when maximum recursion spawn depth is reached."""


@dataclass(slots=True)
class SpawnResult:
    session_id: str
    worktree: str
    branch: str
    name: str


async def compute_spawn_depth(db: AsyncSession, session_id: UUID) -> int:
    """Walk up parent_session_id chain to compute current session depth."""
    depth = 0
    current_id: UUID | None = session_id
    visited: set[UUID] = set()
    while current_id and current_id not in visited and depth <= 10:
        visited.add(current_id)
        row = await db.get(ChatSession, current_id)
        if row is None or row.parent_session_id is None:
            break
        depth += 1
        current_id = row.parent_session_id
    return depth


async def count_active_children(db: AsyncSession, parent_session_id: UUID) -> int:
    """Count running child sessions spawned by this parent."""
    result = await db.exec(
        select(ChatSession.id).where(
            col(ChatSession.parent_session_id) == parent_session_id
        )
    )
    child_ids = [str(uid) for uid in result.all()]
    active_count = 0
    for cid in child_ids:
        runtime = team_manager.find_live_team_serving_session(cid)
        if runtime is not None and getattr(runtime, "state", "idle") in (
            "working",
            "busy",
        ):
            active_count += 1
    return active_count


async def _rollback_failed_spawn(
    *,
    child_session_id: str | None,
    source_workspace: str,
    worktree: str,
    db_factory: db_module.DbFactory,
) -> None:
    """Remove the child session and managed worktree after a failed spawn."""
    if child_session_id is not None:
        await team_manager.evict_session_teams({child_session_id})
        async with db_factory() as db:
            async with db.begin():
                child = await db.get(ChatSession, UUID(child_session_id))
                if child is not None:
                    await db.delete(child)
    try:
        await remove_worktree(
            source_workspace=source_workspace,
            directory=worktree,
            db_factory=db_factory,
            delete_branch=True,
        )
    except Exception as cleanup_exc:
        logger.warning(
            "agent_spawn_cleanup_failed worktree={} error={}",
            worktree,
            cleanup_exc,
        )


async def spawn_agent_session(
    *,
    parent_session_id: str,
    parent_workspace: str,
    task: str,
    name: str | None = None,
    db_factory: db_module.DbFactory | None = None,
) -> SpawnResult:
    """Spawn an independent child session in its own git worktree."""
    parent_ws = Path(team_manager.validate_workspace(parent_workspace))
    await require_git_repo(parent_ws)

    parent_uuid = UUID(parent_session_id)
    db_maker = db_factory or db_module.async_session_factory

    spawn_lock = _spawn_locks.setdefault(parent_session_id, asyncio.Lock())
    async with spawn_lock:
        async with db_maker() as db:
            depth = await compute_spawn_depth(db, parent_uuid)
            if depth >= MAX_SPAWN_DEPTH:
                raise MaxSpawnDepthError(
                    f"Maximum spawn depth of {MAX_SPAWN_DEPTH} reached."
                )

            active_children = await count_active_children(db, parent_uuid)
            if active_children >= MAX_CONCURRENT_CHILDREN:
                raise MaxConcurrentChildrenError(
                    f"Maximum concurrent children of {MAX_CONCURRENT_CHILDREN} reached."
                )

        clean_name = slugify(name or task) or "agent"
        wt_result = await create_worktree(
            source_workspace=parent_ws,
            name=f"agent-{clean_name}",
            branch=f"agent/{clean_name}",
            db_factory=db_maker,
        )
        child_session_id: str | None = None
        try:
            async with db_maker() as db:
                async with db.begin():
                    child_session = ChatSession(
                        mode="coding",
                        workspace=wt_result.directory,
                        title=f"Agent: {wt_result.name}",
                        parent_session_id=parent_uuid,
                    )
                    db.add(child_session)
                    await db.flush()
                    child_session_id = str(child_session.id)

            brief = (
                f"{task}\n\n---\n[Spawn Context]\n"
                f"Parent Session ID: {parent_session_id}\n"
                f"Source Workspace: {parent_ws}\n"
                f"Worktree: {wt_result.directory}\n"
                f"Branch: {wt_result.branch}\n"
                "Instructions: Work inside your worktree. When your task is complete, "
                "use `agent_merge` to merge your branch back to the source repository, "
                "then provide your final summary.\n"
            )
            child_team = await team_manager.get_or_start_coding_team(
                wt_result.directory, child_session_id
            )
            from app.services import agent_service

            await agent_service.dispatch_user_message(
                runtime=child_team,
                content=brief,
                session_id=child_session_id,
                origin="agent",
            )
        except Exception:
            await _rollback_failed_spawn(
                child_session_id=child_session_id,
                source_workspace=wt_result.source_workspace,
                worktree=wt_result.directory,
                db_factory=db_maker,
            )
            raise

    assert child_session_id is not None
    logger.info(
        "agent_spawned parent={} child={} worktree={} branch={}",
        parent_session_id,
        child_session_id,
        wt_result.directory,
        wt_result.branch,
    )

    return SpawnResult(
        session_id=child_session_id,
        worktree=wt_result.directory,
        branch=wt_result.branch or "",
        name=wt_result.name,
    )


async def send_agent_message(
    *,
    sender_session_id: str,
    target_session_id: str,
    sender_name: str,
    content: str,
    db_factory: db_module.DbFactory | None = None,
) -> None:
    """Send a message between related parent and child sessions."""
    sender_uuid = UUID(sender_session_id)
    target_uuid = UUID(target_session_id)
    db_maker = db_factory or db_module.async_session_factory

    async with db_maker() as db:
        sender_row = await db.get(ChatSession, sender_uuid)
        target_row = await db.get(ChatSession, target_uuid)

        if sender_row is None or target_row is None:
            raise ValueError("Sender or target session does not exist.")

        is_parent_to_child = target_row.parent_session_id == sender_uuid
        is_child_to_parent = sender_row.parent_session_id == target_uuid
        if not (is_parent_to_child or is_child_to_parent):
            raise PermissionError(
                "Agent messaging is only allowed between parent and child sessions."
            )

    await team_manager.deliver_agent_report(
        parent_session_id=target_session_id,
        child_session_id=sender_session_id,
        child_name=sender_name,
        content=content,
        db_factory=db_maker,
    )
