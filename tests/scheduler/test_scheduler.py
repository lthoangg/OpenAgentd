"""Tests for app/scheduler/scheduler.py — TaskScheduler engine.

Covers the timer-loop lifecycle, immediate firing of past-due "at" tasks,
add/update/remove/pause/resume/trigger flows, and the database-stamping path
in ``_fire_task``.
"""

from __future__ import annotations

import asyncio
import tempfile
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from unittest.mock import MagicMock, patch
from uuid import UUID, uuid4

import pytest
from sqlmodel import select

import app.core.db as _db_module
import app.services.agent_manager as _agent_manager
from app.scheduler.models import ScheduledTask
from app.scheduler.scheduler import TaskScheduler
from app.scheduler.schemas import ScheduledTaskUpdate

# The scheduler tests intentionally keep mock call sites compact while they
# exercise many concurrent trigger variants.
# fmt: off


async def _db_task(db_factory, task_id):
    async with db_factory() as session:
        return await session.get(ScheduledTask, task_id)


async def _wait_for_task_start(started: asyncio.Event) -> None:
    await asyncio.wait_for(started.wait(), timeout=1)


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


@pytest.fixture(autouse=True)
def scheduler_team_compat(monkeypatch):
    """Route legacy test patches to the coding-team scheduler hook."""

    async def _coding_team(*args, **kwargs):
        return await _agent_manager.get_or_start_agent_session()

    monkeypatch.setattr(_agent_manager, "get_or_start_agent_session", _coding_team)


@pytest.fixture
def mock_dispatch():
    """Patch agent_service.dispatch_user_message + agent_manager.get_or_start_agent_session()."""
    sid = str(uuid4())

    async def _get_team(*_args, **_kwargs):
        team = MagicMock()
        team.has_active_user_turn.return_value = False
        return team

    async def _disp(*_a, **_kw):
        return (sid, 0, str(uuid4()))

    with (
        patch(
            "app.services.agent_manager.get_or_start_agent_session",
            side_effect=_get_team,
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
    max_runs: int | None = None,
) -> ScheduledTask:
    from app.scheduler.utils import slugify

    return ScheduledTask(
        name=name,
        slug=slugify(name),
        workspace=tempfile.mkdtemp(prefix="openagentd-test-workspace-"),
        schedule_type=schedule_type,
        every_seconds=every_seconds,
        at_datetime=at_datetime,
        cron_expression=cron_expression,
        timezone="UTC",
        prompt="hello",
        enabled=enabled,
        run_count=run_count,
        max_runs=max_runs,
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
        assert task.slug in scheduler._tasks
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
        assert task.slug not in scheduler._tasks
        await scheduler.stop()


# ---------------------------------------------------------------------------
# remove()
# ---------------------------------------------------------------------------


class TestRemove:
    async def test_remove_during_fire_prevents_dispatch_and_finalizer(
        self, scheduler, db_factory
    ):
        task = await scheduler.add(_make_task(name="remove_firing"))
        await scheduler.stop()
        dispatch_started = asyncio.Event()
        release_dispatch = asyncio.Event()

        async def _get_team(*_args, **_kwargs):
            dispatch_started.set()
            await release_dispatch.wait()
            return MagicMock()

        with (
            patch(
                "app.services.agent_manager.get_or_start_agent_session",
                side_effect=_get_team,
            ) as get_team,
            patch(
                "app.services.agent_service.dispatch_user_message",
                return_value=(str(uuid4()), 0, str(uuid4())),
            ) as dispatch,
        ):
            firing = asyncio.create_task(scheduler._fire_task(task))
            await _wait_for_task_start(dispatch_started)
            await scheduler.remove(task.slug)
            release_dispatch.set()
            await firing

        assert get_team.call_count == 1
        assert dispatch.call_count == 0
        assert await _db_task(db_factory, task.id) is None

    async def test_removes_task_and_cancels_timer(self, scheduler, db_factory):
        task = _make_task(name="to_remove")
        await scheduler.add(task)
        assert task.slug in scheduler._tasks

        await scheduler.remove(task.slug)
        assert task.slug not in scheduler._tasks

        async with db_factory() as session:
            result = await session.exec(
                select(ScheduledTask).where(ScheduledTask.id == task.id)
            )
            assert result.first() is None

    async def test_remove_nonexistent_slug_is_noop(self, scheduler):
        await scheduler.remove("nonexistent-slug")  # no exception


# ---------------------------------------------------------------------------
# update()
# ---------------------------------------------------------------------------


class TestUpdate:
    async def test_update_during_team_resolution_clears_running_without_dispatch(
        self, scheduler, db_factory
    ):
        task = await scheduler.add(
            _make_task(name="update_resolving", every_seconds=60)
        )
        await scheduler.stop()
        team_started = asyncio.Event()
        release_team = asyncio.Event()

        async def _block_team(*_args, **_kwargs):
            team_started.set()
            await release_team.wait()
            return MagicMock()

        with (
            patch(
                "app.services.agent_manager.get_or_start_agent_session", side_effect=_block_team
            ),
            patch("app.services.agent_service.dispatch_user_message") as dispatch,
        ):
            firing = asyncio.create_task(scheduler._fire_task(task))
            await _wait_for_task_start(team_started)
            fresh = await scheduler.get_task(task.slug)
            assert fresh is not None
            fresh.every_seconds = 30
            await scheduler.update(fresh)
            release_team.set()
            await firing

        row = await _db_task(db_factory, task.id)
        assert row is not None
        assert dispatch.call_count == 0
        assert row.every_seconds == 30
        assert row.status == "pending"
        assert row.run_count == 0

    async def test_update_during_dispatch_preserves_schedule_and_accounts_run(
        self, scheduler, db_factory
    ):
        task = await scheduler.add(
            _make_task(name="update_dispatching", every_seconds=60)
        )
        await scheduler.stop()
        dispatch_started = asyncio.Event()
        release_dispatch = asyncio.Event()

        async def _get_team(*_args, **_kwargs):
            return MagicMock()

        async def _block_dispatch(*_args, **_kwargs):
            dispatch_started.set()
            await release_dispatch.wait()
            return (str(uuid4()), 0, str(uuid4()))

        with (
            patch("app.services.agent_manager.get_or_start_agent_session", side_effect=_get_team),
            patch(
                "app.services.agent_service.dispatch_user_message",
                side_effect=_block_dispatch,
            ),
        ):
            firing = asyncio.create_task(scheduler._fire_task(task))
            await _wait_for_task_start(dispatch_started)
            fresh = await scheduler.get_task(task.slug)
            assert fresh is not None
            fresh.every_seconds = 30
            await scheduler.update(fresh)
            release_dispatch.set()
            await firing

        row = await _db_task(db_factory, task.id)
        assert row is not None
        assert row.every_seconds == 30
        assert row.status == "pending"
        assert row.run_count == 1

    async def test_rename_during_dispatch_preserves_new_slug_and_accounts_run(
        self, scheduler, db_factory
    ):
        task = await scheduler.add(
            _make_task(name="rename_dispatching", every_seconds=60)
        )
        await scheduler.stop()
        dispatch_started = asyncio.Event()
        release_dispatch = asyncio.Event()

        async def _get_team(*_args, **_kwargs):
            return MagicMock()

        async def _block_dispatch(*_args, **_kwargs):
            dispatch_started.set()
            await release_dispatch.wait()
            return (str(uuid4()), 0, str(uuid4()))

        with (
            patch("app.services.agent_manager.get_or_start_agent_session", side_effect=_get_team),
            patch(
                "app.services.agent_service.dispatch_user_message",
                side_effect=_block_dispatch,
            ),
        ):
            firing = asyncio.create_task(scheduler._fire_task(task))
            await _wait_for_task_start(dispatch_started)
            await scheduler.apply_update(
                task.slug,
                ScheduledTaskUpdate(slug="renamed-dispatch", every_seconds=30),
            )
            release_dispatch.set()
            await firing

        assert await scheduler.get_task(task.slug) is None
        row = await scheduler.get_task("renamed-dispatch")
        assert row is not None
        assert row.every_seconds == 30
        assert row.status == "pending"
        assert row.run_count == 1

    async def test_rename_during_fire_deduplicates_by_task_id(
        self, scheduler, db_factory
    ):
        task = await scheduler.add(
            _make_task(name="rename_deduplicate", every_seconds=1)
        )
        await scheduler.stop()
        first_dispatch_started = asyncio.Event()
        release_dispatch = asyncio.Event()
        dispatch_count = 0

        async def _get_team(*_args, **_kwargs):
            return MagicMock()

        async def _block_dispatch(*_args, **_kwargs):
            nonlocal dispatch_count
            dispatch_count += 1
            first_dispatch_started.set()
            await release_dispatch.wait()
            return (str(uuid4()), 0, str(uuid4()))

        with (
            patch("app.services.agent_manager.get_or_start_agent_session", side_effect=_get_team),
            patch(
                "app.services.agent_service.dispatch_user_message",
                side_effect=_block_dispatch,
            ),
        ):
            first = asyncio.create_task(scheduler._fire_task(task))
            await _wait_for_task_start(first_dispatch_started)
            renamed = await scheduler.apply_update(
                task.slug,
                ScheduledTaskUpdate(slug="rename-deduplicated", every_seconds=1),
            )
            second = asyncio.create_task(scheduler._fire_task(renamed))
            await asyncio.sleep(0)
            release_dispatch.set()
            await asyncio.gather(first, second)

        row = await scheduler.get_task("rename-deduplicated")
        assert row is not None
        assert dispatch_count == 1
        assert row.run_count == 1

    async def test_slug_rename_during_fire_invalidates_old_slug(
        self, scheduler, db_factory
    ):
        task = await scheduler.add(_make_task(name="rename_firing"))
        await scheduler.stop()
        team_started = asyncio.Event()
        release_team = asyncio.Event()

        async def _block_team(*_args, **_kwargs):
            team_started.set()
            await release_team.wait()
            return MagicMock()

        with (
            patch(
                "app.services.agent_manager.get_or_start_agent_session", side_effect=_block_team
            ),
            patch("app.services.agent_service.dispatch_user_message") as dispatch,
        ):
            firing = asyncio.create_task(scheduler._fire_task(task))
            await _wait_for_task_start(team_started)
            await scheduler.apply_update(task.slug, ScheduledTaskUpdate(slug="renamed"))
            # Keep this mock compatible with the agent-session resolver.
            release_team.set()
            await firing

        assert dispatch.call_count == 0
        assert await scheduler.get_task(task.slug) is None
        row = await scheduler.get_task("renamed")
        assert row is not None
        assert row.status == "pending"
        assert row.run_count == 0

    async def test_recomputes_next_fire_and_restarts_timer(self, scheduler, db_factory):
        task = _make_task(name="updatable", every_seconds=60)
        await scheduler.add(task)
        original_timer = scheduler._tasks[task.slug]

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
        assert scheduler._tasks[task.slug] is not original_timer
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
        assert task.slug not in scheduler._tasks

    async def test_update_marks_exhausted_finite_task_completed(
        self, scheduler, db_factory
    ):
        task = _make_task(name="finite_done", run_count=2, max_runs=2)

        updated = await scheduler.update(task)

        assert updated.enabled is False
        assert updated.status == "completed"
        assert updated.next_fire_at is None
        assert task.slug not in scheduler._tasks


# ---------------------------------------------------------------------------
# pause() / resume()
# ---------------------------------------------------------------------------


class TestPauseResume:
    async def test_active_session_skip_does_not_unpause_during_admin_pause(
        self, scheduler, db_factory
    ):
        task = await scheduler.add(_make_task(name="skip_pause"))
        task.session_id = "auto"
        await scheduler.update(task)
        await scheduler.stop()
        skip_checked = asyncio.Event()

        class _Team:
            def has_active_user_turn(self):
                skip_checked.set()
                return True

        async def _get_team(*_args, **_kwargs):
            return _Team()

        with patch(
            "app.services.agent_manager.get_or_start_agent_session", side_effect=_get_team
        ):
            firing = asyncio.create_task(scheduler._fire_task(task))
            await _wait_for_task_start(skip_checked)
            await scheduler.pause(task.slug)
            await firing

        row = await _db_task(db_factory, task.id)
        assert row is not None
        assert row.status == "paused"
        assert row.enabled is False

    async def test_pause_during_fire_is_not_overwritten_by_finalizer(
        self, scheduler, db_factory
    ):
        task = await scheduler.add(_make_task(name="pause_firing"))
        await scheduler.stop()
        dispatch_started = asyncio.Event()
        release_dispatch = asyncio.Event()

        async def _get_team(*_args, **_kwargs):
            return MagicMock()

        async def _block_dispatch(*_args, **_kwargs):
            dispatch_started.set()
            await release_dispatch.wait()
            return (str(uuid4()), 0, str(uuid4()))

        with (
            patch("app.services.agent_manager.get_or_start_agent_session", side_effect=_get_team),
            patch(
                "app.services.agent_service.dispatch_user_message",
                side_effect=_block_dispatch,
            ),
        ):
            firing = asyncio.create_task(scheduler._fire_task(task))
            await _wait_for_task_start(dispatch_started)
            await scheduler.pause(task.slug)
            release_dispatch.set()
            await firing

        row = await _db_task(db_factory, task.id)
        assert row is not None
        assert row.status == "paused"
        assert row.enabled is False
        assert row.run_count == 1

    async def test_pause_after_dispatch_accounts_max_run_without_unpausing(
        self, scheduler, db_factory
    ):
        task = await scheduler.add(_make_task(name="pause_max_runs", max_runs=1))
        await scheduler.stop()
        dispatch_started = asyncio.Event()
        release_dispatch = asyncio.Event()

        async def _get_team(*_args, **_kwargs):
            return MagicMock()

        async def _block_dispatch(*_args, **_kwargs):
            dispatch_started.set()
            await release_dispatch.wait()
            return (str(uuid4()), 0, str(uuid4()))

        with (
            patch("app.services.agent_manager.get_or_start_agent_session", side_effect=_get_team),
            patch(
                "app.services.agent_service.dispatch_user_message",
                side_effect=_block_dispatch,
            ),
        ):
            firing = asyncio.create_task(scheduler._fire_task(task))
            await _wait_for_task_start(dispatch_started)
            await scheduler.pause(task.slug)
            release_dispatch.set()
            await firing

        row = await _db_task(db_factory, task.id)
        assert row is not None
        assert row.status == "paused"
        assert row.enabled is False
        assert row.run_count == 1

    async def test_pause_marks_paused_and_cancels_timer(self, scheduler, db_factory):
        task = _make_task(name="pausable")
        await scheduler.add(task)
        paused = await scheduler.pause(task.slug)
        assert paused.enabled is False
        assert paused.status == "paused"
        assert task.slug not in scheduler._tasks

    async def test_resume_re_enables_and_recomputes(self, scheduler, db_factory):
        task = _make_task(name="resumable")
        await scheduler.add(task)
        await scheduler.pause(task.slug)
        resumed = await scheduler.resume(task.slug)
        assert resumed.enabled is True
        assert resumed.status == "pending"
        assert resumed.next_fire_at is not None
        assert task.slug in scheduler._tasks
        await scheduler.stop()

    async def test_resume_exhausted_finite_task_stays_completed(
        self, scheduler, db_factory
    ):
        task = _make_task(name="finite_resumable", max_runs=1)
        await scheduler.add(task)
        await scheduler.stop()

        async with db_factory() as session:
            row = await session.get(ScheduledTask, task.id)
            assert row is not None
            row.run_count = 1
            row.enabled = False
            row.status = "paused"
            session.add(row)
            await session.commit()

        resumed = await scheduler.resume(task.slug)

        assert resumed.enabled is False
        assert resumed.status == "completed"
        assert resumed.next_fire_at is None
        assert task.slug not in scheduler._tasks


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
        found = await scheduler.get_task(task.slug)
        assert found is not None
        assert found.name == "findable"
        await scheduler.stop()

    async def test_get_unknown_slug_returns_none(self, scheduler):
        result = await scheduler.get_task("nonexistent-slug")
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
            if mock_dispatch["dispatch"].called and task.slug in scheduler._tasks:
                break

        async with db_factory() as session:
            row = await session.get(ScheduledTask, task.id)

        assert mock_dispatch["dispatch"].called
        assert row is not None
        assert row.run_count == 1
        assert row.status == "pending"
        assert row.next_fire_at is not None
        assert row.next_fire_at > datetime.now(_UTC)
        assert task.slug in scheduler._tasks

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
    async def test_pause_racing_trigger_wins_over_trigger_enable(
        self, scheduler, db_factory
    ):
        task = _make_task(name="trigger_pause_race")
        task.enabled = False
        task.status = "paused"
        await scheduler.add(task)

        trigger_commit_started = asyncio.Event()
        release_trigger_commit = asyncio.Event()
        factory_calls = 0

        @asynccontextmanager
        async def delayed_first_commit_factory():
            nonlocal factory_calls
            factory_calls += 1
            async with db_factory() as session:
                if factory_calls == 1:
                    original_commit = session.commit

                    async def delayed_commit():
                        trigger_commit_started.set()
                        await release_trigger_commit.wait()
                        await original_commit()

                    session.commit = delayed_commit
                yield session

        scheduler._db = delayed_first_commit_factory

        trigger = asyncio.create_task(scheduler.trigger(task.slug))
        await _wait_for_task_start(trigger_commit_started)
        pause = asyncio.create_task(scheduler.pause(task.slug))
        await asyncio.sleep(0)
        assert not pause.done()
        release_trigger_commit.set()
        await asyncio.gather(trigger, pause)

        row = await _db_task(db_factory, task.id)
        assert row is not None
        assert row.enabled is False
        assert row.status == "paused"
        await scheduler.stop()

    async def test_update_before_queued_trigger_fire_prevents_stale_dispatch(
        self, scheduler
    ):
        task = await scheduler.add(_make_task(name="queued_trigger_update"))
        await scheduler.stop()
        queued_fires = []

        def queue_fire(coroutine, *, task_id):
            scheduler._pending_fire_counts[task_id] = 1
            queued_fires.append(coroutine)

        scheduler._spawn_fire = queue_fire

        await scheduler.trigger(task.slug)
        await scheduler.apply_update(
            task.slug, ScheduledTaskUpdate(prompt="replacement prompt")
        )

        with (
            patch("app.services.agent_manager.get_or_start_agent_session") as get_team,
            patch("app.services.agent_service.dispatch_user_message") as dispatch,
        ):
            await queued_fires.pop()

        get_team.assert_not_called()
        dispatch.assert_not_called()
        await scheduler.stop()

    async def test_stop_cancels_owned_trigger_fire_without_leaving_task_running(
        self, scheduler, db_factory
    ):
        task = _make_task(name="cancel_trigger")
        task.enabled = False
        task.status = "paused"
        await scheduler.add(task)

        dispatch_started = asyncio.Event()
        release_dispatch = asyncio.Event()

        async def _get_team(*_args, **_kwargs):
            return MagicMock()

        async def _block_dispatch(*_args, **_kwargs):
            dispatch_started.set()
            await release_dispatch.wait()
            return (str(uuid4()), 0, str(uuid4()))

        with (
            patch("app.services.agent_manager.get_or_start_agent_session", side_effect=_get_team),
            patch(
                "app.services.agent_service.dispatch_user_message",
                side_effect=_block_dispatch,
            ),
        ):
            await scheduler.trigger(task.slug)
            await _wait_for_task_start(dispatch_started)
            await scheduler.stop()

        row = await _db_task(db_factory, task.id)
        assert row is not None
        assert row.status != "running"

    async def test_fires_task_immediately(self, scheduler, db_factory, mock_dispatch):
        task = _make_task(name="trigger_me")
        await scheduler.add(task)

        await scheduler.trigger(task.slug)
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

        await scheduler.trigger(task.slug)
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
    async def test_success_emits_scheduled_session_turn_started(
        self, scheduler, mock_dispatch
    ):
        task = _make_task(name="scheduled event")
        await scheduler.add(task)
        await scheduler.stop()
        published = []

        async def fake_publish(event, payload):
            published.append((event, payload))

        with patch("app.services.event_broadcaster.publish", new=fake_publish):
            await scheduler._fire_task(task)

        event, payload = published[0]
        assert event == "session_turn_started"
        assert payload["session_id"] == mock_dispatch["sid"]
        assert payload["source"] == "scheduled_task"
        assert payload["task_slug"] == task.slug
        assert payload["task_name"] == task.name
        assert payload["workspace"] == task.workspace
        assert isinstance(payload["started_at"], str)

    async def test_concurrent_fires_dispatch_once(self, scheduler, db_factory):
        task = _make_task(name="single_dispatch")
        await scheduler.add(task)
        await scheduler.stop()

        dispatch_started = asyncio.Event()
        release_dispatch = asyncio.Event()
        dispatch_count = 0

        async def _get_team(*_args, **_kwargs):
            return MagicMock()

        async def _block_dispatch(*_args, **_kwargs):
            nonlocal dispatch_count
            dispatch_count += 1
            dispatch_started.set()
            await release_dispatch.wait()
            return (str(uuid4()), 0, str(uuid4()))

        with (
            patch("app.services.agent_manager.get_or_start_agent_session", side_effect=_get_team),
            patch(
                "app.services.agent_service.dispatch_user_message",
                side_effect=_block_dispatch,
            ),
        ):
            first = asyncio.create_task(scheduler._fire_task(task))
            await _wait_for_task_start(dispatch_started)
            second = asyncio.create_task(scheduler._fire_task(task))
            await asyncio.sleep(0)
            assert dispatch_count == 1
            release_dispatch.set()
            await asyncio.gather(first, second)

        row = await _db_task(db_factory, task.id)
        assert row is not None
        assert dispatch_count == 1
        assert row.run_count == 1

    async def test_dispatch_exception_marks_failed(self, scheduler, db_factory):
        task = _make_task(name="boom")
        await scheduler.add(task)
        await scheduler.stop()

        async def _explode(*_a, **_kw):
            raise RuntimeError("kaboom")

        async def _get_team(*_args, **_kwargs):
            return MagicMock()

        with (
            patch(
                "app.services.agent_manager.get_or_start_agent_session",
                side_effect=_get_team,
            ),
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

    async def test_active_session_skip_does_not_increment_run_count(
        self, scheduler, db_factory
    ):
        task = _make_task(name="active_skip")
        task.session_id = str(uuid4())
        await scheduler.add(task)
        await scheduler.stop()

        team = MagicMock()
        team.has_active_user_turn.return_value = True

        async def _get_team(*_args, **_kwargs):
            return team

        with (
            patch("app.services.agent_manager.get_or_start_agent_session", side_effect=_get_team),
            patch("app.services.agent_service.dispatch_user_message") as dispatch,
        ):
            await scheduler._fire_task(task)

        async with db_factory() as session:
            row = await session.get(ScheduledTask, task.id)

        dispatch.assert_not_called()
        assert row is not None
        assert row.run_count == 0
        assert row.status == "pending"
        assert row.next_fire_at is not None

    async def test_every_task_completes_after_max_runs(
        self, scheduler, db_factory, mock_dispatch
    ):
        task = _make_task(name="finite_every", max_runs=2, run_count=1)
        await scheduler.add(task)
        await scheduler.stop()

        await scheduler._fire_task(task)

        async with db_factory() as session:
            result = await session.exec(
                select(ScheduledTask).where(ScheduledTask.id == task.id)
            )
            row = result.one()

        assert row.run_count == 2
        assert row.enabled is False
        assert row.status == "completed"
        assert row.next_fire_at is None

    async def test_timer_loop_exits_after_max_runs(
        self, scheduler, db_factory, mock_dispatch
    ):
        task = _make_task(name="finite_timer", every_seconds=1, max_runs=1)
        await scheduler.add(task)

        for _ in range(150):
            await asyncio.sleep(0.01)
            if task.slug not in scheduler._tasks:
                break

        async with db_factory() as session:
            row = await session.get(ScheduledTask, task.id)

        assert row is not None
        assert row.run_count == 1
        assert row.enabled is False
        assert row.status == "completed"
        assert row.next_fire_at is None
        assert task.slug not in scheduler._tasks

    async def test_failed_finite_task_does_not_complete(self, scheduler, db_factory):
        task = _make_task(name="finite_failed", max_runs=1)
        await scheduler.add(task)
        await scheduler.stop()

        async def _explode(*_a, **_kw):
            raise RuntimeError("boom")

        async def _get_team(*_args, **_kwargs):
            return MagicMock()

        with (
            patch("app.services.agent_manager.get_or_start_agent_session", side_effect=_get_team),
            patch(
                "app.services.agent_service.dispatch_user_message",
                side_effect=_explode,
            ),
        ):
            await scheduler._fire_task(task)

        async with db_factory() as session:
            row = await session.get(ScheduledTask, task.id)

        assert row is not None
        assert row.run_count == 1
        assert row.enabled is True
        assert row.status == "failed"
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
            return (session_id, 0, str(uuid4()))

        async def _get_team(*_args, **_kwargs):
            return MagicMock()

        with (
            patch("app.services.agent_manager.get_or_start_agent_session", side_effect=_get_team),
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
            return (session_id, 0, str(uuid4()))

        async def _get_team(*_args, **_kwargs):
            return MagicMock()

        with (
            patch("app.services.agent_manager.get_or_start_agent_session", side_effect=_get_team),
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
            return (str(uuid4()), 0, str(uuid4()))

        async def _get_team(*_args, **_kwargs):
            return MagicMock()

        with (
            patch("app.services.agent_manager.get_or_start_agent_session", side_effect=_get_team),
            patch(
                "app.services.agent_service.dispatch_user_message",
                side_effect=_capture,
            ),
        ):
            await scheduler._fire_task(task)

        assert captured["session_id"] is None

# fmt: on
