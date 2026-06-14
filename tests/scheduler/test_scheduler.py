"""Tests for app/scheduler/scheduler.py — TaskScheduler engine.

Covers the timer-loop lifecycle, immediate firing of past-due "at" tasks,
add/update/remove/pause/resume/trigger flows, and the database-stamping path
in ``_fire_task``.
"""

from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone
from unittest.mock import MagicMock, patch
from uuid import UUID, uuid4

import pytest
from sqlmodel import select

import app.core.db as _db_module
from app.scheduler.models import ScheduledTask
from app.scheduler.scheduler import TaskScheduler


_UTC = timezone.utc


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def db_factory():
    """Reuse the in-memory session factory wired up by tests/conftest.py."""
    return _db_module.async_session_factory


@pytest.fixture
def scheduler(db_factory):
    return TaskScheduler(db_factory=db_factory)


@pytest.fixture
def mock_dispatch():
    """Patch agent_service.dispatch_user_message + team_manager.get_or_start_team()."""
    sid = str(uuid4())

    async def _get_team():
        return MagicMock()  # truthy team

    async def _disp(*_a, **_kw):
        return (sid, 0)

    with (
        patch(
            "app.services.team_manager.get_or_start_team", side_effect=_get_team
        ) as mock_team,
        patch(
            "app.services.agent_service.dispatch_user_message", side_effect=_disp
        ) as mock_disp,
    ):
        yield {"team": mock_team, "dispatch": mock_disp, "sid": sid}


def _make_task(
    *,
    name: str = "task1",
    schedule_type: str = "every",
    every_seconds: int | None = 60,
    at_datetime: datetime | None = None,
    cron_expression: str | None = None,
    enabled: bool = True,
    run_count: int = 0,
) -> ScheduledTask:
    return ScheduledTask(
        name=name,
        mode="normal",
        workspace=None,
        schedule_type=schedule_type,
        every_seconds=every_seconds,
        at_datetime=at_datetime,
        cron_expression=cron_expression,
        timezone="UTC",
        prompt="hello",
        enabled=enabled,
        run_count=run_count,
    )


async def _persist(db_factory, task: ScheduledTask) -> ScheduledTask:
    async with db_factory() as session:
        session.add(task)
        await session.commit()
        await session.refresh(task)
    return task


# ---------------------------------------------------------------------------
# add() / get_task() / list_tasks()
# ---------------------------------------------------------------------------


class TestAdd:
    async def test_persists_task_and_starts_timer(self, scheduler, db_factory):
        task = _make_task()
        saved = await scheduler.add(task)

        assert saved.id == task.id
        assert saved.next_fire_at is not None
        # Timer should be tracked
        assert task.id in scheduler._tasks
        # Persisted in DB
        async with db_factory() as session:
            result = await session.exec(
                select(ScheduledTask).where(ScheduledTask.id == task.id)
            )
            row = result.first()
        assert row is not None
        assert row.name == "task1"

        await scheduler.stop()

    async def test_disabled_task_persists_but_no_timer(self, scheduler):
        task = _make_task(name="disabled", enabled=False)
        await scheduler.add(task)
        assert task.id not in scheduler._tasks
        await scheduler.stop()


# ---------------------------------------------------------------------------
# remove()
# ---------------------------------------------------------------------------


class TestRemove:
    async def test_removes_task_and_cancels_timer(self, scheduler, db_factory):
        task = _make_task(name="to_remove")
        await scheduler.add(task)
        assert task.id in scheduler._tasks

        await scheduler.remove(task.id)
        assert task.id not in scheduler._tasks

        async with db_factory() as session:
            result = await session.exec(
                select(ScheduledTask).where(ScheduledTask.id == task.id)
            )
            assert result.first() is None

    async def test_remove_nonexistent_id_is_noop(self, scheduler):
        await scheduler.remove(uuid4())  # no exception


# ---------------------------------------------------------------------------
# update()
# ---------------------------------------------------------------------------


class TestUpdate:
    async def test_recomputes_next_fire_and_restarts_timer(self, scheduler, db_factory):
        task = _make_task(name="updatable", every_seconds=60)
        await scheduler.add(task)
        original_timer = scheduler._tasks[task.id]

        # Reload from DB (so we have the persisted copy) and change schedule
        async with db_factory() as session:
            result = await session.exec(
                select(ScheduledTask).where(ScheduledTask.id == task.id)
            )
            fresh = result.one()
        fresh.every_seconds = 30
        updated = await scheduler.update(fresh)

        assert updated.every_seconds == 30
        # Timer was replaced (new asyncio.Task object)
        assert scheduler._tasks[task.id] is not original_timer
        await scheduler.stop()

    async def test_disable_via_update_cancels_timer(self, scheduler, db_factory):
        task = _make_task(name="to_disable")
        await scheduler.add(task)

        async with db_factory() as session:
            result = await session.exec(
                select(ScheduledTask).where(ScheduledTask.id == task.id)
            )
            fresh = result.one()
        fresh.enabled = False
        await scheduler.update(fresh)
        assert task.id not in scheduler._tasks


# ---------------------------------------------------------------------------
# pause() / resume()
# ---------------------------------------------------------------------------


class TestPauseResume:
    async def test_pause_marks_paused_and_cancels_timer(self, scheduler, db_factory):
        task = _make_task(name="pausable")
        await scheduler.add(task)
        paused = await scheduler.pause(task.id)
        assert paused.enabled is False
        assert paused.status == "paused"
        assert task.id not in scheduler._tasks

    async def test_resume_re_enables_and_recomputes(self, scheduler, db_factory):
        task = _make_task(name="resumable")
        await scheduler.add(task)
        await scheduler.pause(task.id)
        resumed = await scheduler.resume(task.id)
        assert resumed.enabled is True
        assert resumed.status == "pending"
        assert resumed.next_fire_at is not None
        assert task.id in scheduler._tasks
        await scheduler.stop()


# ---------------------------------------------------------------------------
# list_tasks() / get_task()
# ---------------------------------------------------------------------------


class TestListAndGet:
    async def test_list_returns_all_persisted(self, scheduler, db_factory):
        await scheduler.add(_make_task(name="a"))
        await scheduler.add(_make_task(name="b"))
        tasks = await scheduler.list_tasks()
        names = sorted(t.name for t in tasks)
        assert names == ["a", "b"]
        await scheduler.stop()

    async def test_get_returns_specific_task(self, scheduler):
        task = _make_task(name="findable")
        await scheduler.add(task)
        found = await scheduler.get_task(task.id)
        assert found is not None
        assert found.name == "findable"
        await scheduler.stop()

    async def test_get_unknown_id_returns_none(self, scheduler):
        result = await scheduler.get_task(uuid4())
        assert result is None


# ---------------------------------------------------------------------------
# start() — past-due "at" tasks fire immediately
# ---------------------------------------------------------------------------


class TestStart:
    async def test_loads_enabled_tasks_only(self, scheduler, db_factory):
        # Persist directly so add() doesn't auto-start them.
        await _persist(db_factory, _make_task(name="enabled_one", enabled=True))
        await _persist(db_factory, _make_task(name="disabled_one", enabled=False))

        await scheduler.start()
        try:
            assert len(scheduler._tasks) == 1
            # The single tracked task is the enabled one.
            tracked = await scheduler.list_tasks()
            enabled = [t for t in tracked if t.enabled]
            assert len(enabled) == 1
            assert enabled[0].name == "enabled_one"
        finally:
            await scheduler.stop()

    async def test_past_due_at_task_fires_immediately(
        self, scheduler, db_factory, mock_dispatch
    ):
        past = datetime.now(_UTC) - timedelta(hours=1)
        task = _make_task(
            name="past_due",
            schedule_type="at",
            every_seconds=None,
            at_datetime=past,
        )
        # Persist with run_count=0 so start() picks it up as past-due.
        await _persist(db_factory, task)

        await scheduler.start()
        # Allow the create_task in start() to run.
        for _ in range(20):
            await asyncio.sleep(0.01)
            if mock_dispatch["dispatch"].called:
                break
        await scheduler.stop()

        assert mock_dispatch["dispatch"].called

    async def test_already_run_at_task_not_refired(
        self, scheduler, db_factory, mock_dispatch
    ):
        past = datetime.now(_UTC) - timedelta(hours=1)
        task = _make_task(
            name="already_done",
            schedule_type="at",
            every_seconds=None,
            at_datetime=past,
            run_count=1,  # already fired
        )
        await _persist(db_factory, task)

        await scheduler.start()
        await asyncio.sleep(0.05)
        await scheduler.stop()

        assert not mock_dispatch["dispatch"].called

    async def test_overdue_cron_task_fires_and_restarts_timer(
        self, scheduler, db_factory, mock_dispatch
    ):
        task = _make_task(
            name="daily-vnt",
            schedule_type="cron",
            every_seconds=None,
            cron_expression="0 14 * * *",
        )
        task.timezone = "Asia/Ho_Chi_Minh"
        task.next_fire_at = datetime.now(_UTC) - timedelta(minutes=1)
        await _persist(db_factory, task)

        await scheduler.start()
        for _ in range(50):
            await asyncio.sleep(0.01)
            if mock_dispatch["dispatch"].called and task.id in scheduler._tasks:
                break

        async with db_factory() as session:
            row = await session.get(ScheduledTask, task.id)

        assert mock_dispatch["dispatch"].called
        assert row is not None
        assert row.run_count == 1
        assert row.status == "pending"
        assert row.next_fire_at is not None
        assert row.next_fire_at > datetime.now(_UTC)
        assert task.id in scheduler._tasks

        await scheduler.stop()


# ---------------------------------------------------------------------------
# stop() — cancels all timers
# ---------------------------------------------------------------------------


class TestStop:
    async def test_cancels_all_running_timers(self, scheduler):
        await scheduler.add(_make_task(name="t1"))
        await scheduler.add(_make_task(name="t2"))
        assert len(scheduler._tasks) == 2

        await scheduler.stop()
        assert scheduler._tasks == {}

    async def test_stop_with_no_tasks_is_safe(self, scheduler):
        await scheduler.stop()  # no exception
        assert scheduler._tasks == {}


# ---------------------------------------------------------------------------
# trigger() — fires immediately without affecting the schedule
# ---------------------------------------------------------------------------


class TestTrigger:
    async def test_fires_task_immediately(self, scheduler, db_factory, mock_dispatch):
        task = _make_task(name="trigger_me")
        await scheduler.add(task)

        await scheduler.trigger(task.id)
        # Allow the spawned _fire_task coroutine to run.
        for _ in range(20):
            await asyncio.sleep(0.01)
            if mock_dispatch["dispatch"].called:
                break

        await scheduler.stop()
        assert mock_dispatch["dispatch"].called

    async def test_trigger_paused_task_enables_it(
        self, scheduler, db_factory, mock_dispatch
    ):
        task = _make_task(name="trigger_paused_me")
        task.enabled = False
        task.status = "paused"
        await scheduler.add(task)

        await scheduler.trigger(task.id)
        for _ in range(20):
            await asyncio.sleep(0.01)
            if mock_dispatch["dispatch"].called:
                break

        await scheduler.stop()
        assert mock_dispatch["dispatch"].called

        async with db_factory() as session:
            db_task = await session.get(ScheduledTask, task.id)
            assert db_task is not None
            assert db_task.enabled is True
            assert db_task.status == "pending"
            assert db_task.next_fire_at is not None


# ---------------------------------------------------------------------------
# _fire_task — error paths and stat updates
# ---------------------------------------------------------------------------


class TestFireTaskErrors:
    async def test_no_team_marks_failed(self, scheduler, db_factory):
        task = _make_task(name="needs_team")
        await scheduler.add(task)
        await scheduler.stop()  # cancel timer so we drive _fire_task directly

        async def _no_team():
            return None

        with patch("app.services.team_manager.get_or_start_team", side_effect=_no_team):
            await scheduler._fire_task(task)

        async with db_factory() as session:
            result = await session.exec(
                select(ScheduledTask).where(ScheduledTask.id == task.id)
            )
            row = result.one()

        assert row.status == "failed"
        assert row.last_error == "No team configured."
        assert row.run_count == 1

    async def test_dispatch_exception_marks_failed(self, scheduler, db_factory):
        task = _make_task(name="boom")
        await scheduler.add(task)
        await scheduler.stop()

        async def _explode(*_a, **_kw):
            raise RuntimeError("kaboom")

        async def _get_team():
            return MagicMock()

        with (
            patch("app.services.team_manager.get_or_start_team", side_effect=_get_team),
            patch(
                "app.services.agent_service.dispatch_user_message",
                side_effect=_explode,
            ),
        ):
            await scheduler._fire_task(task)

        async with db_factory() as session:
            result = await session.exec(
                select(ScheduledTask).where(ScheduledTask.id == task.id)
            )
            row = result.one()

        assert row.status == "failed"
        assert row.last_error == "kaboom"
        assert row.run_count == 1

    async def test_at_task_marks_completed_on_success(
        self, scheduler, db_factory, mock_dispatch
    ):
        future = datetime.now(_UTC) + timedelta(days=1)
        task = _make_task(
            name="at_success",
            schedule_type="at",
            every_seconds=None,
            at_datetime=future,
        )
        await scheduler.add(task)
        await scheduler.stop()

        await scheduler._fire_task(task)

        async with db_factory() as session:
            result = await session.exec(
                select(ScheduledTask).where(ScheduledTask.id == task.id)
            )
            row = result.one()
        assert row.status == "completed"
        assert row.last_error is None
        assert row.run_count == 1

    async def test_every_task_returns_to_pending_after_success(
        self, scheduler, db_factory, mock_dispatch
    ):
        task = _make_task(name="every_success")
        await scheduler.add(task)
        await scheduler.stop()

        await scheduler._fire_task(task)

        async with db_factory() as session:
            result = await session.exec(
                select(ScheduledTask).where(ScheduledTask.id == task.id)
            )
            row = result.one()
        assert row.status == "pending"
        assert row.next_fire_at is not None


# ---------------------------------------------------------------------------
# session_id resolution
# ---------------------------------------------------------------------------


class TestSessionResolution:
    async def test_auto_session_id_resolves_to_uuid5_per_name(
        self, scheduler, db_factory
    ):
        task = _make_task(name="auto_sid")
        task.session_id = "auto"
        await scheduler.add(task)
        await scheduler.stop()

        captured: dict[str, object] = {}

        async def _capture(team, *, content, session_id, attachments=None, **_kw):
            captured["session_id"] = session_id
            return (session_id, 0)

        async def _get_team():
            return MagicMock()

        with (
            patch("app.services.team_manager.get_or_start_team", side_effect=_get_team),
            patch(
                "app.services.agent_service.dispatch_user_message",
                side_effect=_capture,
            ),
        ):
            await scheduler._fire_task(task)

        sid = captured["session_id"]
        assert isinstance(sid, str)
        # Valid UUID
        UUID(sid)
        # Deterministic: same task name → same uuid
        from uuid import NAMESPACE_URL, uuid5

        assert sid == str(uuid5(NAMESPACE_URL, f"scheduler:{task.name}"))

    async def test_explicit_session_id_passes_through(self, scheduler, db_factory):
        explicit = str(uuid4())
        task = _make_task(name="explicit_sid")
        task.session_id = explicit
        await scheduler.add(task)
        await scheduler.stop()

        captured: dict[str, object] = {}

        async def _capture(team, *, content, session_id, attachments=None, **_kw):
            captured["session_id"] = session_id
            return (session_id, 0)

        async def _get_team():
            return MagicMock()

        with (
            patch("app.services.team_manager.get_or_start_team", side_effect=_get_team),
            patch(
                "app.services.agent_service.dispatch_user_message",
                side_effect=_capture,
            ),
        ):
            await scheduler._fire_task(task)

        assert captured["session_id"] == explicit

    async def test_none_session_id_passes_none(self, scheduler, db_factory):
        task = _make_task(name="no_sid")
        task.session_id = None
        await scheduler.add(task)
        await scheduler.stop()

        captured: dict[str, object] = {"session_id": "sentinel"}

        async def _capture(team, *, content, session_id, attachments=None, **_kw):
            captured["session_id"] = session_id
            return (str(uuid4()), 0)

        async def _get_team():
            return MagicMock()

        with (
            patch("app.services.team_manager.get_or_start_team", side_effect=_get_team),
            patch(
                "app.services.agent_service.dispatch_user_message",
                side_effect=_capture,
            ),
        ):
            await scheduler._fire_task(task)

        assert captured["session_id"] is None
