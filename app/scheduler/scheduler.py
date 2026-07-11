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


def _schedule_exhausted(task: ScheduledTask) -> bool:
    return task.max_runs is not None and task.run_count >= task.max_runs


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
        # task slug → running asyncio.Task
        self._tasks: dict[str, asyncio.Task[None]] = {}
        self._fire_tasks: set[asyncio.Task[None]] = set()
        self._firing_slugs: set[str] = set()

    # ── Lifecycle ─────────────────────────────────────────────────────────────

    async def start(self) -> None:
        """Load all enabled tasks from DB and start their timer loops."""
        tasks = await self._enabled_tasks()

        now = datetime.now(_utc)
        for task in tasks:
            if task.next_fire_at is not None and task.next_fire_at <= now:
                self._spawn_fire(self._fire_overdue_and_restart(task))
                continue

            # One-shot "at" tasks whose fire time is in the past and haven't
            # run yet should fire immediately on startup.
            if (
                task.schedule_type == "at"
                and task.at_datetime is not None
                and task.run_count == 0
                and task.at_datetime <= now
            ):
                self._spawn_fire(self._fire_task(task))
            else:
                self._start_timer(task)

        logger.info("scheduler_started tasks={}", len(tasks))

    async def _fire_overdue_and_restart(self, task: ScheduledTask) -> None:
        """Fire a persisted overdue task, then restart recurring timers."""
        await self._fire_task(task)

        async with self._db() as session:
            result = await session.exec(
                select(ScheduledTask).where(ScheduledTask.slug == task.slug)
            )
            fresh = result.first()

        if fresh is not None and fresh.enabled and fresh.schedule_type != "at":
            self._start_timer(fresh)

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
        """Cancel and await all timer and firing tasks."""
        tasks = [*self._tasks.values(), *self._fire_tasks]
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        self._tasks.clear()
        self._fire_tasks.clear()
        logger.info("scheduler_stopped")

    # ── Public API ────────────────────────────────────────────────────────────

    async def add(self, task: ScheduledTask) -> ScheduledTask:
        """Persist *task* to DB and start its timer."""
        if _schedule_exhausted(task):
            task.enabled = False
            task.status = "completed"
            task.next_fire_at = None
        else:
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
        assert body.slug is not None

        task = ScheduledTask(
            name=body.name,
            slug=body.slug,
            mode=body.mode,
            workspace=body.workspace,
            schedule_type=body.schedule_type,
            at_datetime=body.at_datetime,
            every_seconds=body.every_seconds,
            cron_expression=body.cron_expression,
            timezone=body.timezone,
            prompt=body.prompt,
            session_id=body.session_id,
            max_runs=body.max_runs,
            enabled=body.enabled,
        )
        return await self.add(task)

    async def apply_update(
        self, slug: str, body: "ScheduledTaskUpdate"
    ) -> ScheduledTask:
        """Apply a partial update from *body* onto an existing task.

        Re-validates the routing target if ``mode`` or ``workspace`` change.

        Raises:
            TaskNotFoundError: If *slug* does not exist.
            InvalidTaskTargetError: If the merged (mode, workspace) is invalid.
        """
        task = await self.get_task(slug)
        if task is None:
            raise TaskNotFoundError(slug)

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

        if body.slug is not None and body.slug != task.slug:
            self._cancel_timer(task.slug)
            task.slug = body.slug
        if body.schedule_type is not None:
            task.schedule_type = body.schedule_type
            task.at_datetime = None
            task.every_seconds = None
            task.cron_expression = None
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
        if "max_runs" in body.model_fields_set:
            task.max_runs = body.max_runs
        if body.enabled is not None:
            task.enabled = body.enabled

        return await self.update(task)

    async def remove(self, slug: str) -> None:
        """Cancel timer and delete *slug* from DB."""
        self._cancel_timer(slug)
        async with self._db() as session:
            result = await session.exec(
                select(ScheduledTask).where(ScheduledTask.slug == slug)
            )
            task = result.first()
            if task is not None:
                await session.delete(task)
                await session.commit()

    async def update(self, task: ScheduledTask) -> ScheduledTask:
        """Persist updated *task* and restart/cancel its timer."""
        self._cancel_timer(task.slug)
        if _schedule_exhausted(task):
            task.enabled = False
            task.status = "completed"
            task.next_fire_at = None
        else:
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

    async def pause(self, slug: str) -> ScheduledTask:
        """Disable task and cancel its timer."""
        self._cancel_timer(slug)
        async with self._db() as session:
            result = await session.exec(
                select(ScheduledTask).where(ScheduledTask.slug == slug)
            )
            task = result.one()
            task.enabled = False
            task.status = "paused"
            session.add(task)
            await session.commit()
            await session.refresh(task)
        return task

    async def resume(self, slug: str) -> ScheduledTask:
        """Re-enable task, recompute next_fire_at, and start timer."""
        async with self._db() as session:
            result = await session.exec(
                select(ScheduledTask).where(ScheduledTask.slug == slug)
            )
            task = result.one()
            task.enabled = True
            task.status = "pending"
            if _schedule_exhausted(task):
                task.enabled = False
                task.status = "completed"
                task.next_fire_at = None
            else:
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

        if task.enabled:
            self._start_timer(task)
        return task

    async def trigger(self, slug: str) -> None:
        """Fire task immediately and ensure it is enabled."""
        async with self._db() as session:
            result = await session.exec(
                select(ScheduledTask).where(ScheduledTask.slug == slug)
            )
            task = result.one()
            if _schedule_exhausted(task):
                task.enabled = False
                task.status = "completed"
                task.next_fire_at = None
                session.add(task)
                await session.commit()
                return
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

        self._spawn_fire(self._fire_task(task))

    async def list_tasks(self) -> list[ScheduledTask]:
        async with self._db() as session:
            result = await session.exec(select(ScheduledTask))
            return list(result.all())

    async def get_task(self, slug: str) -> ScheduledTask | None:
        async with self._db() as session:
            result = await session.exec(
                select(ScheduledTask).where(ScheduledTask.slug == slug)
            )
            return result.first()

    # ── Internal helpers ──────────────────────────────────────────────────────

    def _spawn_fire(self, coroutine) -> None:
        """Track a detached firing task so lifecycle shutdown owns it."""
        task = asyncio.create_task(coroutine)
        self._fire_tasks.add(task)
        task.add_done_callback(self._fire_tasks.discard)

    def _start_timer(self, task: ScheduledTask) -> None:
        """Spawn an asyncio task for *task*'s timer loop."""
        self._cancel_timer(task.slug)
        t = asyncio.create_task(self._timer_loop(task), name=f"scheduler:{task.name}")
        self._tasks[task.slug] = t

    def _cancel_timer(self, slug: str) -> None:
        existing = self._tasks.pop(slug, None)
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
                    select(ScheduledTask).where(ScheduledTask.slug == task.slug)
                )
                fresh = result.first()
            if fresh is None:
                break
            task = fresh

            if not task.enabled or _schedule_exhausted(task):
                break

            # One-shot "at" tasks exit after firing
            if task.schedule_type == "at":
                break

        # Remove ourselves from the tracking dict
        self._tasks.pop(task.slug, None)

    async def _fire_task(self, task: ScheduledTask) -> None:
        """Execute one non-overlapping scheduled firing of *task*."""
        if task.slug in self._firing_slugs:
            return
        self._firing_slugs.add(task.slug)
        try:
            await self._fire_task_locked(task)
        except asyncio.CancelledError:
            await self._mark_fire_cancelled(task.slug)
            raise
        finally:
            self._firing_slugs.discard(task.slug)

    async def _mark_fire_cancelled(self, slug: str) -> None:
        """Restore a firing row interrupted by scheduler shutdown."""
        async with self._db() as session:
            result = await session.exec(
                select(ScheduledTask).where(ScheduledTask.slug == slug)
            )
            task = result.first()
            if task is not None and task.status == "running":
                task.status = "pending" if task.enabled else "paused"
                task.next_fire_at = (
                    next_fire(
                        task.schedule_type,
                        cron_expression=task.cron_expression,
                        every_seconds=task.every_seconds,
                        at_datetime=task.at_datetime,
                        timezone=task.timezone,
                        run_count=task.run_count,
                    )
                    if task.enabled
                    else None
                )
                session.add(task)
                await session.commit()

    async def _fire_task_locked(self, task: ScheduledTask) -> None:
        """Execute the dispatch and bookkeeping for one firing."""
        from app.services import team_manager
        from app.services.agent_service import NoTeamConfigured, dispatch_user_message

        now = datetime.now(_utc)

        # 1. Mark running
        async with self._db() as session:
            result = await session.exec(
                select(ScheduledTask).where(ScheduledTask.slug == task.slug)
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
                    task.workspace, f"scheduler:{task.slug}"
                )
            else:
                team = await team_manager.get_or_start_team()
                if team is None:
                    raise NoTeamConfigured("No team configured.")
            if resolved_sid is not None and team.has_active_user_turn() is True:
                async with self._db() as session:
                    result = await session.exec(
                        select(ScheduledTask).where(ScheduledTask.slug == task.slug)
                    )
                    db_task = result.first()
                    if db_task is not None:
                        db_task.status = "pending"
                        db_task.next_fire_at = next_fire(
                            db_task.schedule_type,
                            cron_expression=db_task.cron_expression,
                            every_seconds=db_task.every_seconds,
                            at_datetime=db_task.at_datetime,
                            timezone=db_task.timezone,
                            after=datetime.now(_utc),
                            run_count=db_task.run_count,
                        )
                        session.add(db_task)
                        await session.commit()
                logger.info(
                    "scheduler_skip_active_session task_slug={} name={} session_id={}",
                    task.slug,
                    task.name,
                    resolved_sid,
                )
                return
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
                "scheduler_no_team task_slug={} name={} mode={} error={}",
                task.slug,
                task.name,
                task.mode,
                exc,
            )
        except Exception as exc:
            error = str(exc)
            logger.error(
                "scheduler_fire_error task_slug={} name={} error={}",
                task.slug,
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
                    "scheduler_stamp_failed task_slug={} sid={} error={}",
                    task.slug,
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
                select(ScheduledTask).where(ScheduledTask.slug == task.slug)
            )
            db_task = result.first()
            if db_task is None:
                return
            db_task.run_count += 1
            db_task.last_error = error
            finite_complete = (
                not error
                and db_task.max_runs is not None
                and db_task.run_count >= db_task.max_runs
            )
            db_task.next_fire_at = None if finite_complete else nxt
            if error:
                db_task.status = "failed"
            elif finite_complete:
                db_task.enabled = False
                db_task.status = "completed"
            elif task.schedule_type == "at":
                db_task.status = "completed"
            else:
                db_task.status = "pending"
            session.add(db_task)
            await session.commit()

        logger.info(
            "scheduler_fired task_slug={} name={} run_count={} error={}",
            task.slug,
            task.name,
            task.run_count + 1,
            error,
        )


# ── Module-level singleton ────────────────────────────────────────────────────

from app.core.db import async_session_factory  # noqa: E402

task_scheduler = TaskScheduler(db_factory=async_session_factory)
