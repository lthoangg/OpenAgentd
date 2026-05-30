"""TaskScheduler — asyncio-based scheduled task engine.

Manages a set of :class:`~app.scheduler.models.ScheduledTask` rows, each
backed by a long-running ``asyncio.Task`` that sleeps until ``next_fire_at``
and then dispatches the configured prompt to the agent team.
"""

from __future__ import annotations

import asyncio
from datetime import datetime, timezone
from typing import TYPE_CHECKING
from uuid import UUID, uuid5, NAMESPACE_URL

from loguru import logger
from sqlmodel import col, select

from app.core.db import DbFactory
from app.scheduler.cron import next_fire
from app.scheduler.models import ScheduledTask

if TYPE_CHECKING:
    from app.scheduler.schemas import ScheduledTaskCreate, ScheduledTaskUpdate

_utc = timezone.utc


class TaskNotFoundError(Exception):
    """Raised when a scheduled task lookup by id has no matching row."""


class InvalidTaskTargetError(Exception):
    """Raised when a task's mode/workspace combination is invalid.

    Examples: ``mode='coding'`` with a workspace path that does not exist
    or is not a directory.
    """


def _validate_target(mode: str, workspace: str | None) -> None:
    """Raise :exc:`InvalidTaskTargetError` if (mode, workspace) cannot route.

    Cheap on-disk check only — no team is loaded.  Pairs with the Pydantic
    ``mode``/``workspace`` cross-field validator (which only checks
    presence) by adding the filesystem-existence check.
    """
    from app.services import team_manager

    if mode == "coding":
        if not workspace:
            raise InvalidTaskTargetError("workspace is required when mode='coding'")
        try:
            team_manager.validate_workspace(workspace)
        except ValueError as exc:
            raise InvalidTaskTargetError(str(exc)) from exc


async def _validate_session_compat(
    db_factory: DbFactory,
    *,
    session_id: str | None,
    mode: str,
    workspace: str | None,
) -> None:
    """Ensure ``session_id`` (if explicit) matches the task's (mode, workspace).

    Skipped for:

    * ``session_id is None`` — scheduler mints a new uuid per fire.
    * ``session_id == 'auto'`` — deterministic uuid5 per task; the row is
      created by the scheduler under the task's own mode/workspace, so
      mismatch is impossible by construction.
    * Explicit UUID that does not yet exist in the DB — first fire will
      create it under the task's mode/workspace.

    Raises :exc:`InvalidTaskTargetError` when an existing session row
    disagrees with the requested target.  Mirrors the workspace-mismatch
    check in ``POST /team/chat`` (``app/api/routes/team/chat.py:135-148``).
    """
    if not session_id or session_id == "auto":
        return
    try:
        sid_uuid = UUID(session_id)
    except ValueError:
        raise InvalidTaskTargetError(
            f"session_id must be a UUID or 'auto'; got {session_id!r}"
        ) from None

    # Late import — chat models import from app.core which already imports
    # scheduler indirectly, so keeping this scoped avoids a cycle.
    from app.models.chat import ChatSession

    async with db_factory() as db:
        row = await db.get(ChatSession, sid_uuid)
        if row is None:
            return  # session doesn't exist yet; first fire creates it
        if row.mode != mode:
            raise InvalidTaskTargetError(
                f"Session {session_id} has mode='{row.mode}', "
                f"but task has mode='{mode}'."
            )
        if mode == "coding" and row.workspace != workspace:
            raise InvalidTaskTargetError(
                f"Session {session_id} is bound to workspace "
                f"'{row.workspace}', but task targets '{workspace}'."
            )


class TaskScheduler:
    """Lifecycle manager for scheduled tasks.

    Instantiate once at module level and call :meth:`start` / :meth:`stop`
    from the FastAPI lifespan.
    """

    def __init__(self, db_factory: DbFactory) -> None:
        self._db = db_factory
        # task_id → running asyncio.Task
        self._tasks: dict[UUID, asyncio.Task[None]] = {}

    # ── Lifecycle ─────────────────────────────────────────────────────────────

    async def start(self) -> None:
        """Load all enabled tasks from DB and start their timer loops."""
        tasks = await self._enabled_tasks()

        now = datetime.now(_utc)
        for task in tasks:
            # One-shot "at" tasks whose fire time is in the past and haven't
            # run yet should fire immediately on startup.
            if (
                task.schedule_type == "at"
                and task.at_datetime is not None
                and task.run_count == 0
                and task.at_datetime <= now
            ):
                asyncio.create_task(self._fire_task(task))
            else:
                self._start_timer(task)

        logger.info("scheduler_started tasks={}", len(tasks))

    async def has_enabled_tasks(self) -> bool:
        """Return whether the DB has any enabled scheduled tasks."""
        return bool(await self._enabled_tasks())

    async def _enabled_tasks(self) -> list[ScheduledTask]:
        async with self._db() as session:
            result = await session.exec(
                select(ScheduledTask).where(col(ScheduledTask.enabled).is_(True))
            )
            return list(result.all())

    async def stop(self) -> None:
        """Cancel all running timer tasks."""
        for t in list(self._tasks.values()):
            t.cancel()
        if self._tasks:
            await asyncio.gather(*self._tasks.values(), return_exceptions=True)
        self._tasks.clear()
        logger.info("scheduler_stopped")

    # ── Public API ────────────────────────────────────────────────────────────

    async def add(self, task: ScheduledTask) -> ScheduledTask:
        """Persist *task* to DB and start its timer."""
        task.next_fire_at = next_fire(
            task.schedule_type,
            cron_expression=task.cron_expression,
            every_seconds=task.every_seconds,
            at_datetime=task.at_datetime,
            timezone=task.timezone,
            run_count=task.run_count,
        )
        async with self._db() as session:
            session.add(task)
            await session.commit()
            await session.refresh(task)

        if task.enabled:
            self._start_timer(task)
        return task

    async def create(self, body: "ScheduledTaskCreate") -> ScheduledTask:
        """Validate *body*, build a ``ScheduledTask``, persist, and start timer.

        Raises:
            InvalidTaskTargetError: If ``body.mode``/``body.workspace`` is
                not a routable target (e.g. workspace path missing), or
                if ``body.session_id`` references an existing session whose
                mode/workspace disagrees with the task.
            sqlalchemy.exc.IntegrityError: On duplicate task name.
        """
        _validate_target(body.mode, body.workspace)
        await _validate_session_compat(
            self._db,
            session_id=body.session_id,
            mode=body.mode,
            workspace=body.workspace,
        )

        task = ScheduledTask(
            name=body.name,
            mode=body.mode,
            workspace=body.workspace,
            schedule_type=body.schedule_type,
            at_datetime=body.at_datetime,
            every_seconds=body.every_seconds,
            cron_expression=body.cron_expression,
            timezone=body.timezone,
            prompt=body.prompt,
            session_id=body.session_id,
            enabled=body.enabled,
        )
        return await self.add(task)

    async def apply_update(
        self, task_id: UUID, body: "ScheduledTaskUpdate"
    ) -> ScheduledTask:
        """Apply a partial update from *body* onto an existing task.

        Re-validates the routing target if ``mode`` or ``workspace`` change.

        Raises:
            TaskNotFoundError: If *task_id* does not exist.
            InvalidTaskTargetError: If the merged (mode, workspace) is invalid.
        """
        task = await self.get_task(task_id)
        if task is None:
            raise TaskNotFoundError(str(task_id))

        new_mode = body.mode if body.mode is not None else task.mode
        new_workspace = body.workspace if body.workspace is not None else task.workspace
        new_session_id = (
            body.session_id if body.session_id is not None else task.session_id
        )
        if body.mode is not None or body.workspace is not None:
            _validate_target(new_mode, new_workspace)
            task.mode = new_mode
            task.workspace = new_workspace

        # Re-validate the session pairing whenever any of (mode, workspace,
        # session_id) change.  A mode-only change can newly conflict with an
        # already-stored session_id, so we always check against the merged
        # state.
        if (
            body.mode is not None
            or body.workspace is not None
            or body.session_id is not None
        ):
            await _validate_session_compat(
                self._db,
                session_id=new_session_id,
                mode=new_mode,
                workspace=new_workspace,
            )

        if body.schedule_type is not None:
            task.schedule_type = body.schedule_type
        if body.at_datetime is not None:
            task.at_datetime = body.at_datetime
        if body.every_seconds is not None:
            task.every_seconds = body.every_seconds
        if body.cron_expression is not None:
            task.cron_expression = body.cron_expression
        if body.timezone is not None:
            task.timezone = body.timezone
        if body.prompt is not None:
            task.prompt = body.prompt
        if body.session_id is not None:
            task.session_id = body.session_id
        if body.enabled is not None:
            task.enabled = body.enabled

        return await self.update(task)

    async def remove(self, task_id: UUID) -> None:
        """Cancel timer and delete *task_id* from DB."""
        self._cancel_timer(task_id)
        async with self._db() as session:
            result = await session.exec(
                select(ScheduledTask).where(ScheduledTask.id == task_id)
            )
            task = result.first()
            if task is not None:
                await session.delete(task)
                await session.commit()

    async def update(self, task: ScheduledTask) -> ScheduledTask:
        """Persist updated *task* and restart/cancel its timer."""
        self._cancel_timer(task.id)
        task.next_fire_at = next_fire(
            task.schedule_type,
            cron_expression=task.cron_expression,
            every_seconds=task.every_seconds,
            at_datetime=task.at_datetime,
            timezone=task.timezone,
            run_count=task.run_count,
        )
        async with self._db() as session:
            session.add(task)
            await session.commit()
            await session.refresh(task)

        if task.enabled:
            self._start_timer(task)
        return task

    async def pause(self, task_id: UUID) -> ScheduledTask:
        """Disable task and cancel its timer."""
        self._cancel_timer(task_id)
        async with self._db() as session:
            result = await session.exec(
                select(ScheduledTask).where(ScheduledTask.id == task_id)
            )
            task = result.one()
            task.enabled = False
            task.status = "paused"
            session.add(task)
            await session.commit()
            await session.refresh(task)
        return task

    async def resume(self, task_id: UUID) -> ScheduledTask:
        """Re-enable task, recompute next_fire_at, and start timer."""
        async with self._db() as session:
            result = await session.exec(
                select(ScheduledTask).where(ScheduledTask.id == task_id)
            )
            task = result.one()
            task.enabled = True
            task.status = "pending"
            task.next_fire_at = next_fire(
                task.schedule_type,
                cron_expression=task.cron_expression,
                every_seconds=task.every_seconds,
                at_datetime=task.at_datetime,
                timezone=task.timezone,
                run_count=task.run_count,
            )
            session.add(task)
            await session.commit()
            await session.refresh(task)

        self._start_timer(task)
        return task

    async def trigger(self, task_id: UUID) -> None:
        """Fire task immediately and ensure it is enabled."""
        async with self._db() as session:
            result = await session.exec(
                select(ScheduledTask).where(ScheduledTask.id == task_id)
            )
            task = result.one()
            was_disabled = not task.enabled or task.status == "paused"
            if was_disabled:
                task.enabled = True
                task.status = "pending"
                task.next_fire_at = next_fire(
                    task.schedule_type,
                    cron_expression=task.cron_expression,
                    every_seconds=task.every_seconds,
                    at_datetime=task.at_datetime,
                    timezone=task.timezone,
                    run_count=task.run_count,
                )
                session.add(task)
                await session.commit()
                await session.refresh(task)

        if was_disabled:
            self._start_timer(task)

        asyncio.create_task(self._fire_task(task))

    async def list_tasks(self) -> list[ScheduledTask]:
        async with self._db() as session:
            result = await session.exec(select(ScheduledTask))
            return list(result.all())

    async def get_task(self, task_id: UUID) -> ScheduledTask | None:
        async with self._db() as session:
            result = await session.exec(
                select(ScheduledTask).where(ScheduledTask.id == task_id)
            )
            return result.first()

    # ── Internal helpers ──────────────────────────────────────────────────────

    def _start_timer(self, task: ScheduledTask) -> None:
        """Spawn an asyncio task for *task*'s timer loop."""
        self._cancel_timer(task.id)
        t = asyncio.create_task(self._timer_loop(task), name=f"scheduler:{task.name}")
        self._tasks[task.id] = t

    def _cancel_timer(self, task_id: UUID) -> None:
        existing = self._tasks.pop(task_id, None)
        if existing is not None:
            existing.cancel()

    async def _timer_loop(self, task: ScheduledTask) -> None:
        """Sleep until next_fire_at, fire, repeat (or exit for one-shots)."""
        while True:
            # Recompute next fire from current state
            nxt = next_fire(
                task.schedule_type,
                cron_expression=task.cron_expression,
                every_seconds=task.every_seconds,
                at_datetime=task.at_datetime,
                timezone=task.timezone,
                run_count=task.run_count,
            )
            if nxt is None:
                # Schedule exhausted (e.g. "at" already ran)
                break

            now = datetime.now(_utc)
            delay = (nxt - now).total_seconds()
            if delay > 0:
                try:
                    await asyncio.sleep(delay)
                except asyncio.CancelledError:
                    return

            await self._fire_task(task)

            # Reload task state from DB so run_count / status are fresh
            async with self._db() as session:
                result = await session.exec(
                    select(ScheduledTask).where(ScheduledTask.id == task.id)
                )
                fresh = result.first()
            if fresh is None:
                break
            task = fresh

            # One-shot "at" tasks exit after firing
            if task.schedule_type == "at":
                break

        # Remove ourselves from the tracking dict
        self._tasks.pop(task.id, None)

    async def _fire_task(self, task: ScheduledTask) -> None:
        """Execute one scheduled firing of *task*."""
        from app.services import team_manager
        from app.services.agent_service import NoTeamConfigured, dispatch_user_message

        now = datetime.now(_utc)

        # 1. Mark running
        async with self._db() as session:
            result = await session.exec(
                select(ScheduledTask).where(ScheduledTask.id == task.id)
            )
            db_task = result.first()
            if db_task is None:
                return
            db_task.status = "running"
            db_task.last_run_at = now
            session.add(db_task)
            await session.commit()

        # 2. Resolve session_id
        # "auto" → deterministic uuid5 derived from the task name so the same
        # persistent session is reused across every firing, and it is always a
        # valid UUID (required by handle_user_message / ChatSession PK).
        raw_sid = task.session_id
        if raw_sid is None:
            resolved_sid: str | None = None  # dispatch_user_message will mint one
        elif raw_sid == "auto":
            resolved_sid = str(uuid5(NAMESPACE_URL, f"scheduler:{task.name}"))
        else:
            resolved_sid = raw_sid

        # 3. Dispatch — route to the lead of the matching team.
        error: str | None = None
        fired_sid: str | None = None
        try:
            if task.mode == "coding":
                if not task.workspace:
                    raise NoTeamConfigured(
                        "Task has mode='coding' but no workspace configured."
                    )
                team = await team_manager.get_or_start_coding_team(
                    task.workspace, f"scheduler:{task.id}"
                )
            else:
                team = await team_manager.get_or_start_team()
                if team is None:
                    raise NoTeamConfigured("No team configured.")
            fired_sid, _ = await dispatch_user_message(
                team,
                content=f"[Scheduled Task: {task.name}]\n{task.prompt}",
                session_id=resolved_sid,
                mode=task.mode,
                workspace=task.workspace,
            )
        except NoTeamConfigured as exc:
            error = str(exc)
            logger.warning(
                "scheduler_no_team task_id={} name={} mode={} error={}",
                task.id,
                task.name,
                task.mode,
                exc,
            )
        except Exception as exc:
            error = str(exc)
            logger.error(
                "scheduler_fire_error task_id={} name={} error={}",
                task.id,
                task.name,
                exc,
            )

        # 3b. Stamp the chat session so it's identifiable as scheduler-created.
        # fired_sid is always a valid UUID string at this point:
        #   None     → dispatch_user_message mints a uuid7
        #   "auto"   → resolved to uuid5(NAMESPACE_URL, "scheduler:<name>") above
        #   explicit → caller-supplied UUID string passed through unchanged
        if fired_sid and not error:
            from app.models.chat import ChatSession

            try:
                async with self._db() as db:
                    chat_row = await db.get(ChatSession, UUID(fired_sid))
                    if chat_row is not None:
                        chat_row.scheduled_task_name = task.name
                        db.add(chat_row)
                        await db.commit()
            except Exception as stamp_exc:
                logger.warning(
                    "scheduler_stamp_failed task_id={} sid={} error={}",
                    task.id,
                    fired_sid,
                    stamp_exc,
                )

        # 4. Update stats
        nxt = next_fire(
            task.schedule_type,
            cron_expression=task.cron_expression,
            every_seconds=task.every_seconds,
            at_datetime=task.at_datetime,
            timezone=task.timezone,
            after=datetime.now(_utc),
            run_count=task.run_count + 1,
        )
        async with self._db() as session:
            result = await session.exec(
                select(ScheduledTask).where(ScheduledTask.id == task.id)
            )
            db_task = result.first()
            if db_task is None:
                return
            db_task.run_count += 1
            db_task.last_error = error
            db_task.next_fire_at = nxt
            if error:
                db_task.status = "failed"
            elif task.schedule_type == "at":
                db_task.status = "completed"
            else:
                db_task.status = "pending"
            session.add(db_task)
            await session.commit()

        logger.info(
            "scheduler_fired task_id={} name={} run_count={} error={}",
            task.id,
            task.name,
            task.run_count + 1,
            error,
        )


# ── Module-level singleton ────────────────────────────────────────────────────

from app.core.db import async_session_factory  # noqa: E402

task_scheduler = TaskScheduler(db_factory=async_session_factory)
