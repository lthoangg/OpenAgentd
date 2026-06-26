"""Tests for app/agent/tools/builtin/schedule.py — schedule_task tool."""

from __future__ import annotations

from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock, patch
from uuid import uuid7

import pytest

from app.agent.errors import ToolArgumentError
from app.agent.tools.builtin.schedule import schedule_task


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def mock_task_scheduler():
    """Mock the task_scheduler singleton."""
    return AsyncMock()


@pytest.fixture
def sample_task():
    """Create a sample ScheduledTask-like object for testing."""
    task = MagicMock()
    task.id = uuid7()
    task.slug = "test-task"
    task.name = "test-task"
    task.mode = "normal"
    task.workspace = None
    task.schedule_type = "every"
    task.every_seconds = 3600
    task.at_datetime = None
    task.cron_expression = None
    task.timezone = "UTC"
    task.prompt = "Check email"
    task.session_id = None
    task.enabled = True
    task.status = "pending"
    task.run_count = 0
    task.max_runs = None
    task.next_fire_at = datetime.now(timezone.utc)
    return task


# Reusable ``_injected`` payloads — production runs receive these from the
# tool executor; tests pass them in directly via ``Tool.arun``.
_NORMAL_INJECTED = {"_mode": "normal", "_workspace": None}


def _coding_injected(workspace: str) -> dict[str, object]:
    return {"_mode": "coding", "_workspace": workspace}


# ---------------------------------------------------------------------------
# Action: list
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_list_no_tasks(mock_task_scheduler):
    """Returns 'No scheduled tasks.' when scheduler returns empty list."""
    mock_task_scheduler.list_tasks.return_value = []

    with patch("app.scheduler.scheduler.task_scheduler", mock_task_scheduler):
        result = await schedule_task.arun(action="list")

    assert result == "No scheduled tasks."
    mock_task_scheduler.list_tasks.assert_called_once()


@pytest.mark.asyncio
async def test_list_single_task(mock_task_scheduler, sample_task, clean_db):
    """Returns formatted task line for a single task."""
    mock_task_scheduler.list_tasks.return_value = [sample_task]

    with patch("app.scheduler.scheduler.task_scheduler", mock_task_scheduler):
        result = await schedule_task.arun(action="list")

    assert "Scheduled tasks (1):" in result
    assert f"id={sample_task.id}" in result
    assert f"slug={sample_task.slug}" in result
    assert "name=test-task" in result
    assert "mode=normal" in result
    assert "schedule=every 3600s" in result
    assert "status=enabled/pending" in result
    assert "runs=0" in result


@pytest.mark.asyncio
async def test_list_task_with_max_runs(mock_task_scheduler, sample_task, clean_db):
    sample_task.max_runs = 5
    mock_task_scheduler.list_tasks.return_value = [sample_task]

    with patch("app.scheduler.scheduler.task_scheduler", mock_task_scheduler):
        result = await schedule_task.arun(action="list")

    assert "runs=0/5" in result


@pytest.mark.asyncio
async def test_list_includes_workspace_for_coding(mock_task_scheduler, sample_task):
    """Coding tasks render workspace in the listing line when listed by the
    matching coding-team lead."""
    sample_task.mode = "coding"
    sample_task.workspace = "/tmp/project"
    mock_task_scheduler.list_tasks.return_value = [sample_task]

    with patch("app.scheduler.scheduler.task_scheduler", mock_task_scheduler):
        result = await schedule_task.arun(
            action="list", _injected=_coding_injected("/tmp/project")
        )

    assert "mode=coding workspace=/tmp/project" in result


@pytest.mark.asyncio
async def test_list_task_with_at_schedule(mock_task_scheduler):
    """Formats 'at' schedule type correctly."""
    task = MagicMock()
    task.id = uuid7()
    task.name = "one-shot"
    task.mode = "normal"
    task.workspace = None
    task.schedule_type = "at"
    task.at_datetime = datetime(2026, 5, 1, 9, 0, 0, tzinfo=timezone.utc)
    task.every_seconds = None
    task.cron_expression = None
    task.timezone = "UTC"
    task.prompt = "Run once"
    task.session_id = None
    task.enabled = True
    task.status = "pending"
    task.run_count = 0
    task.next_fire_at = task.at_datetime

    mock_task_scheduler.list_tasks.return_value = [task]

    with patch("app.scheduler.scheduler.task_scheduler", mock_task_scheduler):
        result = await schedule_task.arun(action="list")

    assert "at 2026-05-01 09:00:00+00:00" in result


# ---------------------------------------------------------------------------
# Action: create — validation errors
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_create_missing_name(mock_task_scheduler):
    """Returns error when name is missing."""
    with patch("app.scheduler.scheduler.task_scheduler", mock_task_scheduler):
        result = await schedule_task.arun(
            action="create",
            schedule_type="every",
            every_seconds=3600,
            prompt="Check email",
            _injected=_NORMAL_INJECTED,
        )

    assert "Error:" in result
    assert "name" in result
    assert "required" in result


@pytest.mark.asyncio
async def test_create_missing_schedule_type(mock_task_scheduler):
    """Returns error when schedule_type is missing."""
    with patch("app.scheduler.scheduler.task_scheduler", mock_task_scheduler):
        result = await schedule_task.arun(
            action="create",
            name="test-task",
            prompt="Check email",
            _injected=_NORMAL_INJECTED,
        )

    assert "Error:" in result
    assert "schedule_type" in result
    assert "required" in result


@pytest.mark.asyncio
async def test_create_missing_prompt(mock_task_scheduler):
    """Returns error when prompt is missing."""
    with patch("app.scheduler.scheduler.task_scheduler", mock_task_scheduler):
        result = await schedule_task.arun(
            action="create",
            name="test-task",
            schedule_type="every",
            every_seconds=3600,
            _injected=_NORMAL_INJECTED,
        )

    assert "Error:" in result
    assert "prompt" in result
    assert "required" in result


@pytest.mark.asyncio
async def test_create_invalid_at_datetime_format(mock_task_scheduler):
    """Returns error for invalid at_datetime format."""
    with patch("app.scheduler.scheduler.task_scheduler", mock_task_scheduler):
        result = await schedule_task.arun(
            action="create",
            name="test-task",
            schedule_type="at",
            at_datetime="not-a-datetime",
            prompt="Run once",
            _injected=_NORMAL_INJECTED,
        )

    assert "Error:" in result
    assert "at_datetime" in result
    assert "invalid" in result


@pytest.mark.asyncio
async def test_create_invalid_schedule_type(mock_task_scheduler):
    """Raises ToolArgumentError for invalid schedule_type value."""
    from app.agent.errors import ToolArgumentError

    with patch("app.scheduler.scheduler.task_scheduler", mock_task_scheduler):
        with pytest.raises(ToolArgumentError):
            await schedule_task.arun(
                action="create",
                name="test-task",
                schedule_type="weekly",  # Invalid
                prompt="Run weekly",
                _injected=_NORMAL_INJECTED,
            )


@pytest.mark.asyncio
async def test_create_invalid_cron_expression(mock_task_scheduler):
    """Returns error for invalid cron expression."""
    with patch("app.scheduler.scheduler.task_scheduler", mock_task_scheduler):
        result = await schedule_task.arun(
            action="create",
            name="test-task",
            schedule_type="cron",
            cron_expression="not-a-cron",
            prompt="Run on schedule",
            _injected=_NORMAL_INJECTED,
        )

    assert "Error:" in result
    assert "invalid task configuration" in result


# ---------------------------------------------------------------------------
# Action: create — successful cases
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_create_every_success(mock_task_scheduler, sample_task, clean_db):
    """Successfully creates an 'every' task with mode auto-injected as 'normal'."""
    mock_task_scheduler.create.return_value = sample_task

    with patch("app.scheduler.scheduler.task_scheduler", mock_task_scheduler):
        result = await schedule_task.arun(
            action="create",
            name="test-task",
            schedule_type="every",
            every_seconds=3600,
            prompt="Check email",
            _injected=_NORMAL_INJECTED,
        )

    assert "Scheduled task created." in result
    assert f"id          : {sample_task.id}" in result
    assert "name        : test-task" in result
    assert "mode        : normal" in result
    assert "schedule    : every" in result
    assert "prompt      : 'Check email'" in result
    mock_task_scheduler.create.assert_called_once()
    payload = mock_task_scheduler.create.call_args[0][0]
    assert payload.mode == "normal"
    assert payload.workspace is None


@pytest.mark.asyncio
async def test_create_in_coding_context_auto_injects_workspace(
    mock_task_scheduler, sample_task, clean_db
):
    """When the calling agent runs in a coding team, the task inherits
    ``mode='coding'`` and the team's workspace — no LLM-supplied value."""
    sample_task.mode = "coding"
    sample_task.workspace = "/tmp/project"
    mock_task_scheduler.create.return_value = sample_task

    with patch("app.scheduler.scheduler.task_scheduler", mock_task_scheduler):
        result = await schedule_task.arun(
            action="create",
            name="test-task",
            schedule_type="every",
            every_seconds=3600,
            prompt="Check email",
            _injected=_coding_injected("/tmp/project"),
        )

    assert "Scheduled task created." in result
    assert "mode        : coding" in result
    assert "workspace   : /tmp/project" in result
    payload = mock_task_scheduler.create.call_args[0][0]
    assert payload.mode == "coding"
    assert payload.workspace == "/tmp/project"


@pytest.mark.asyncio
async def test_create_at_success(mock_task_scheduler, sample_task, clean_db):
    """Successfully creates an 'at' task with ISO datetime string."""
    sample_task.schedule_type = "at"
    sample_task.at_datetime = datetime(2026, 5, 1, 9, 0, 0, tzinfo=timezone.utc)
    sample_task.every_seconds = None
    mock_task_scheduler.create.return_value = sample_task

    with patch("app.scheduler.scheduler.task_scheduler", mock_task_scheduler):
        result = await schedule_task.arun(
            action="create",
            name="test-task",
            schedule_type="at",
            at_datetime="2026-05-01T09:00:00+00:00",
            prompt="Run once",
            _injected=_NORMAL_INJECTED,
        )

    assert "Scheduled task created." in result
    assert "schedule    : at" in result
    mock_task_scheduler.create.assert_called_once()
    payload = mock_task_scheduler.create.call_args[0][0]
    assert payload.at_datetime == datetime(2026, 5, 1, 9, 0, 0, tzinfo=timezone.utc)


@pytest.mark.asyncio
async def test_create_at_naive_string_uses_supplied_timezone(
    mock_task_scheduler, sample_task, clean_db
):
    """A naive ISO string for ``at_datetime`` must be interpreted in the
    user-supplied ``timezone``, not silently treated as UTC."""
    from zoneinfo import ZoneInfo

    sample_task.schedule_type = "at"
    sample_task.every_seconds = None
    expected = datetime(2026, 5, 10, 1, 12, 42, tzinfo=ZoneInfo("Asia/Ho_Chi_Minh"))
    sample_task.at_datetime = expected
    mock_task_scheduler.create.return_value = sample_task

    with patch("app.scheduler.scheduler.task_scheduler", mock_task_scheduler):
        result = await schedule_task.arun(
            action="create",
            name="test-task",
            schedule_type="at",
            at_datetime="2026-05-10T01:12:42",  # naive — no offset
            timezone="Asia/Ho_Chi_Minh",
            prompt="Run once",
            _injected=_NORMAL_INJECTED,
        )

    assert "Scheduled task created." in result
    payload = mock_task_scheduler.create.call_args[0][0]
    assert payload.at_datetime is not None
    assert payload.at_datetime.tzinfo is not None
    assert payload.at_datetime == expected
    assert payload.at_datetime.astimezone(timezone.utc) == datetime(
        2026, 5, 9, 18, 12, 42, tzinfo=timezone.utc
    )


@pytest.mark.asyncio
async def test_create_at_aware_string_passthrough(
    mock_task_scheduler, sample_task, clean_db
):
    """An ISO string that already carries an offset is left untouched."""
    sample_task.schedule_type = "at"
    sample_task.every_seconds = None
    sample_task.at_datetime = datetime(2026, 5, 1, 9, 0, 0, tzinfo=timezone.utc)
    mock_task_scheduler.create.return_value = sample_task

    with patch("app.scheduler.scheduler.task_scheduler", mock_task_scheduler):
        result = await schedule_task.arun(
            action="create",
            name="test-task",
            schedule_type="at",
            at_datetime="2026-05-01T09:00:00+00:00",
            timezone="Asia/Ho_Chi_Minh",
            prompt="Run once",
            _injected=_NORMAL_INJECTED,
        )

    assert "Scheduled task created." in result
    payload = mock_task_scheduler.create.call_args[0][0]
    assert payload.at_datetime == datetime(2026, 5, 1, 9, 0, 0, tzinfo=timezone.utc)


@pytest.mark.asyncio
async def test_create_at_unknown_timezone_returns_error(
    mock_task_scheduler, sample_task, clean_db
):
    """A naive datetime + unknown IANA zone must surface a clear error."""
    mock_task_scheduler.create.return_value = sample_task

    with patch("app.scheduler.scheduler.task_scheduler", mock_task_scheduler):
        result = await schedule_task.arun(
            action="create",
            name="test-task",
            schedule_type="at",
            at_datetime="2026-05-10T01:12:42",
            timezone="Mars/Olympus_Mons",
            prompt="Run once",
            _injected=_NORMAL_INJECTED,
        )

    assert "Error" in result
    assert "Mars/Olympus_Mons" in result
    mock_task_scheduler.create.assert_not_called()


@pytest.mark.asyncio
async def test_create_cron_success(mock_task_scheduler, sample_task, clean_db):
    """Successfully creates a 'cron' task."""
    sample_task.schedule_type = "cron"
    sample_task.cron_expression = "0 9 * * 1-5"
    sample_task.timezone = "America/New_York"
    sample_task.every_seconds = None
    mock_task_scheduler.create.return_value = sample_task

    with patch("app.scheduler.scheduler.task_scheduler", mock_task_scheduler):
        result = await schedule_task.arun(
            action="create",
            name="test-task",
            schedule_type="cron",
            cron_expression="0 9 * * 1-5",
            timezone="America/New_York",
            prompt="Daily report",
            _injected=_NORMAL_INJECTED,
        )

    assert "Scheduled task created." in result
    assert "schedule    : cron" in result
    payload = mock_task_scheduler.create.call_args[0][0]
    assert payload.cron_expression == "0 9 * * 1-5"
    assert payload.timezone == "America/New_York"


@pytest.mark.asyncio
async def test_create_with_session_id_auto(mock_task_scheduler, sample_task, clean_db):
    """Creates task with session_id='auto'."""
    sample_task.session_id = "auto"
    mock_task_scheduler.create.return_value = sample_task

    with patch("app.scheduler.scheduler.task_scheduler", mock_task_scheduler):
        result = await schedule_task.arun(
            action="create",
            name="test-task",
            schedule_type="every",
            every_seconds=3600,
            prompt="Check email",
            session_id="auto",
            _injected=_NORMAL_INJECTED,
        )

    assert "Scheduled task created." in result
    payload = mock_task_scheduler.create.call_args[0][0]
    assert payload.session_id == "auto"


@pytest.mark.asyncio
async def test_create_with_session_id_uuid(mock_task_scheduler, sample_task, clean_db):
    """Creates task with a specific session UUID."""
    session_uuid = str(uuid7())
    sample_task.session_id = session_uuid
    mock_task_scheduler.create.return_value = sample_task

    with patch("app.scheduler.scheduler.task_scheduler", mock_task_scheduler):
        result = await schedule_task.arun(
            action="create",
            name="test-task",
            schedule_type="every",
            every_seconds=3600,
            prompt="Check email",
            session_id=session_uuid,
            _injected=_NORMAL_INJECTED,
        )

    assert "Scheduled task created." in result
    payload = mock_task_scheduler.create.call_args[0][0]
    assert payload.session_id == session_uuid


@pytest.mark.asyncio
async def test_create_with_session_id_current_uses_lead_session(
    mock_task_scheduler, sample_task, clean_db
):
    sample_task.session_id = "019ef6e1-1111-7111-8111-111111111111"
    mock_task_scheduler.create.return_value = sample_task
    state = MagicMock()
    state.metadata = {"lead_session_id": sample_task.session_id}

    with patch("app.scheduler.scheduler.task_scheduler", mock_task_scheduler):
        result = await schedule_task.arun(
            action="create",
            name="test-task",
            schedule_type="every",
            every_seconds=3600,
            prompt="Check email",
            session_id="current",
            _injected={**_NORMAL_INJECTED, "_state": state},
        )

    assert "Scheduled task created." in result
    payload = mock_task_scheduler.create.call_args[0][0]
    assert payload.session_id == sample_task.session_id


@pytest.mark.asyncio
async def test_create_with_session_id_current_requires_state(
    mock_task_scheduler, clean_db
):
    with patch("app.scheduler.scheduler.task_scheduler", mock_task_scheduler):
        result = await schedule_task.arun(
            action="create",
            name="test-task",
            schedule_type="every",
            every_seconds=3600,
            prompt="Check email",
            session_id="current",
            _injected=_NORMAL_INJECTED,
        )

    assert "Error:" in result
    assert "current" in result
    mock_task_scheduler.create.assert_not_called()


@pytest.mark.asyncio
async def test_create_with_max_runs(mock_task_scheduler, sample_task, clean_db):
    sample_task.max_runs = 3
    mock_task_scheduler.create.return_value = sample_task

    with patch("app.scheduler.scheduler.task_scheduler", mock_task_scheduler):
        result = await schedule_task.arun(
            action="create",
            name="test-task",
            schedule_type="every",
            every_seconds=3600,
            prompt="Check email",
            max_runs=3,
            _injected=_NORMAL_INJECTED,
        )

    assert "max runs    : 3" in result
    payload = mock_task_scheduler.create.call_args[0][0]
    assert payload.max_runs == 3


@pytest.mark.asyncio
async def test_create_rejects_non_positive_max_runs(mock_task_scheduler, clean_db):
    with (
        patch("app.scheduler.scheduler.task_scheduler", mock_task_scheduler),
        pytest.raises(ToolArgumentError, match="max_runs"),
    ):
        await schedule_task.arun(
            action="create",
            name="test-task",
            schedule_type="every",
            every_seconds=3600,
            prompt="Check email",
            max_runs=0,
            _injected=_NORMAL_INJECTED,
        )

    mock_task_scheduler.create.assert_not_called()


@pytest.mark.asyncio
async def test_create_with_enabled_false(mock_task_scheduler, sample_task, clean_db):
    """Creates a disabled task."""
    sample_task.enabled = False
    mock_task_scheduler.create.return_value = sample_task

    with patch("app.scheduler.scheduler.task_scheduler", mock_task_scheduler):
        result = await schedule_task.arun(
            action="create",
            name="test-task",
            schedule_type="every",
            every_seconds=3600,
            prompt="Check email",
            enabled=False,
            _injected=_NORMAL_INJECTED,
        )

    assert "Scheduled task created." in result
    payload = mock_task_scheduler.create.call_args[0][0]
    assert payload.enabled is False


@pytest.mark.asyncio
async def test_create_scheduler_create_raises(mock_task_scheduler):
    """Returns error string when ``scheduler.create`` raises."""
    mock_task_scheduler.create.side_effect = RuntimeError("Database error")

    with patch("app.scheduler.scheduler.task_scheduler", mock_task_scheduler):
        result = await schedule_task.arun(
            action="create",
            name="test-task",
            schedule_type="every",
            every_seconds=3600,
            prompt="Check email",
            _injected=_NORMAL_INJECTED,
        )

    assert "Error:" in result
    assert "failed to create task" in result
    assert "Database error" in result


# ---------------------------------------------------------------------------
# Action: pause
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_pause_missing_slug(mock_task_scheduler):
    """Returns error when slug is missing."""
    with patch("app.scheduler.scheduler.task_scheduler", mock_task_scheduler):
        result = await schedule_task.arun(action="pause")

    assert "Error:" in result
    assert "slug" in result
    assert "required" in result


@pytest.mark.asyncio
async def test_pause_nonexistent_slug(mock_task_scheduler):
    """Returns error when task slug is not found."""
    mock_task_scheduler.get_task.return_value = None
    with patch("app.scheduler.scheduler.task_scheduler", mock_task_scheduler):
        result = await schedule_task.arun(action="pause", slug="some-ghost-slug")

    assert "Error:" in result
    assert "no task with slug 'some-ghost-slug'" in result


@pytest.mark.asyncio
async def test_pause_success(mock_task_scheduler, sample_task, clean_db):
    """Successfully pauses a task that is in the caller's scope."""
    task_slug = sample_task.slug
    # ``pause`` now goes through ``get_task`` first to enforce scope —
    # tests must seed the lookup as well as the mutation.
    mock_task_scheduler.get_task.return_value = sample_task
    mock_task_scheduler.pause.return_value = sample_task

    with patch("app.scheduler.scheduler.task_scheduler", mock_task_scheduler):
        result = await schedule_task.arun(action="pause", slug=task_slug)

    assert "Task 'test-task' paused." in result
    mock_task_scheduler.pause.assert_called_once_with(sample_task.slug)


@pytest.mark.asyncio
async def test_pause_scheduler_raises(mock_task_scheduler, sample_task):
    """Raises ToolExecutionError when task_scheduler.pause() raises after a
    successful scope check."""
    from app.agent.errors import ToolExecutionError

    task_slug = sample_task.slug
    # In-scope lookup so we reach the mutation path; the mutation then
    # blows up and the registry wraps the error.
    mock_task_scheduler.get_task.return_value = sample_task
    mock_task_scheduler.pause.side_effect = RuntimeError("Task not found")

    with patch("app.scheduler.scheduler.task_scheduler", mock_task_scheduler):
        with pytest.raises(ToolExecutionError):
            await schedule_task.arun(action="pause", slug=task_slug)


# ---------------------------------------------------------------------------
# Action: resume
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_resume_missing_task_id(mock_task_scheduler):
    """Returns error when slug is missing."""
    with patch("app.scheduler.scheduler.task_scheduler", mock_task_scheduler):
        result = await schedule_task.arun(action="resume")

    assert "Error:" in result
    assert "slug" in result
    assert "required" in result


@pytest.mark.asyncio
async def test_resume_nonexistent_slug(mock_task_scheduler):
    """Returns error when task slug is not found."""
    mock_task_scheduler.get_task.return_value = None
    with patch("app.scheduler.scheduler.task_scheduler", mock_task_scheduler):
        result = await schedule_task.arun(action="resume", slug="some-ghost-slug")

    assert "Error:" in result
    assert "no task with slug 'some-ghost-slug'" in result


@pytest.mark.asyncio
async def test_resume_success(mock_task_scheduler, sample_task, clean_db):
    """Successfully resumes a task that is in the caller's scope."""
    task_slug = sample_task.slug
    next_fire = datetime.now(timezone.utc)
    sample_task.next_fire_at = next_fire
    mock_task_scheduler.get_task.return_value = sample_task
    mock_task_scheduler.resume.return_value = sample_task

    with patch("app.scheduler.scheduler.task_scheduler", mock_task_scheduler):
        result = await schedule_task.arun(action="resume", slug=task_slug)

    assert "Task 'test-task' resumed." in result
    assert f"Next fire: {next_fire}" in result
    mock_task_scheduler.resume.assert_called_once_with(sample_task.slug)


@pytest.mark.asyncio
async def test_resume_scheduler_raises(mock_task_scheduler, sample_task):
    """Raises ToolExecutionError when task_scheduler.resume() raises after a
    successful scope check."""
    from app.agent.errors import ToolExecutionError

    task_slug = sample_task.slug
    mock_task_scheduler.get_task.return_value = sample_task
    mock_task_scheduler.resume.side_effect = RuntimeError("Task not found")

    with patch("app.scheduler.scheduler.task_scheduler", mock_task_scheduler):
        with pytest.raises(ToolExecutionError):
            await schedule_task.arun(action="resume", slug=task_slug)


# ---------------------------------------------------------------------------
# Action: delete
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_delete_missing_slug(mock_task_scheduler):
    """Returns error when slug is missing."""
    with patch("app.scheduler.scheduler.task_scheduler", mock_task_scheduler):
        result = await schedule_task.arun(action="delete")

    assert "Error:" in result
    assert "slug" in result
    assert "required" in result


@pytest.mark.asyncio
async def test_delete_nonexistent_slug(mock_task_scheduler):
    """Returns error when task slug is not found."""
    mock_task_scheduler.get_task.return_value = None
    with patch("app.scheduler.scheduler.task_scheduler", mock_task_scheduler):
        result = await schedule_task.arun(action="delete", slug="some-ghost-slug")

    assert "Error:" in result
    assert "no task with slug 'some-ghost-slug'" in result


@pytest.mark.asyncio
async def test_delete_success(mock_task_scheduler, sample_task, clean_db):
    """Successfully deletes a task."""
    task_slug = sample_task.slug
    mock_task_scheduler.get_task.return_value = sample_task
    mock_task_scheduler.remove.return_value = None

    with patch("app.scheduler.scheduler.task_scheduler", mock_task_scheduler):
        result = await schedule_task.arun(action="delete", slug=task_slug)

    assert "Task 'test-task' deleted." in result
    mock_task_scheduler.get_task.assert_called_once_with(sample_task.slug)
    mock_task_scheduler.remove.assert_called_once_with(sample_task.slug)


@pytest.mark.asyncio
async def test_delete_task_not_found_reports_error_and_skips_remove(
    mock_task_scheduler,
):
    """When the task does not exist, delete returns an error and never calls
    ``scheduler.remove`` — the previous "use UUID as fallback name and
    delete anyway" behavior was wrong because (a) it leaked task existence
    to out-of-scope callers and (b) it issued a write for a non-existent
    row. The scope-check refactor unifies "missing" and "out of scope"
    into a single short-circuit before any mutation."""
    task_slug = "ghost"
    mock_task_scheduler.get_task.return_value = None

    with patch("app.scheduler.scheduler.task_scheduler", mock_task_scheduler):
        result = await schedule_task.arun(action="delete", slug=task_slug)

    assert "Error:" in result
    assert f"no task with slug '{task_slug}'" in result
    mock_task_scheduler.get_task.assert_called_once()
    mock_task_scheduler.remove.assert_not_called()


# ---------------------------------------------------------------------------
# Action: trigger
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_trigger_missing_slug(mock_task_scheduler):
    """Returns error when slug is missing."""
    with patch("app.scheduler.scheduler.task_scheduler", mock_task_scheduler):
        result = await schedule_task.arun(action="trigger")

    assert "Error:" in result
    assert "slug" in result
    assert "required" in result


@pytest.mark.asyncio
async def test_trigger_nonexistent_slug(mock_task_scheduler):
    """Returns error when task slug is not found."""
    mock_task_scheduler.get_task.return_value = None
    with patch("app.scheduler.scheduler.task_scheduler", mock_task_scheduler):
        result = await schedule_task.arun(action="trigger", slug="some-ghost-slug")

    assert "Error:" in result
    assert "no task with slug 'some-ghost-slug'" in result


@pytest.mark.asyncio
async def test_trigger_task_not_found(mock_task_scheduler):
    """Returns error when task not found."""
    task_slug = "ghost"
    mock_task_scheduler.get_task.return_value = None

    with patch("app.scheduler.scheduler.task_scheduler", mock_task_scheduler):
        result = await schedule_task.arun(action="trigger", slug=task_slug)

    assert "Error:" in result
    assert f"no task with slug '{task_slug}'" in result


@pytest.mark.asyncio
async def test_trigger_success(mock_task_scheduler, sample_task, clean_db):
    """Successfully triggers a task."""
    task_slug = sample_task.slug
    mock_task_scheduler.get_task.return_value = sample_task
    mock_task_scheduler.trigger.return_value = None

    with patch("app.scheduler.scheduler.task_scheduler", mock_task_scheduler):
        result = await schedule_task.arun(action="trigger", slug=task_slug)

    assert "Task 'test-task' triggered immediately." in result
    mock_task_scheduler.trigger.assert_called_once_with(sample_task.slug)


# ---------------------------------------------------------------------------
# Tool metadata
# ---------------------------------------------------------------------------


def test_schedule_task_tool_name(clean_db):
    """Verify tool name is correct."""
    assert schedule_task.name == "schedule_task"


def test_schedule_task_tool_has_description(clean_db):
    """Verify tool has a description."""
    assert schedule_task.description
    assert "schedule" in schedule_task.description.lower()


def test_schedule_task_tool_definition(clean_db):
    """Verify tool definition is properly formatted."""
    definition = schedule_task.definition
    assert definition["type"] == "function"
    assert definition["function"]["name"] == "schedule_task"
    params = definition["function"]["parameters"]["properties"]
    assert "action" in params
    assert "max_runs" in params
    # mode + workspace are derived from runtime context, not exposed to the LLM.
    assert "mode" not in params
    assert "workspace" not in params


# ---------------------------------------------------------------------------
# Loader auto-injection tests
# ---------------------------------------------------------------------------


def test_build_agent_injects_schedule_task_for_lead(clean_db):
    """_build_agent auto-injects schedule_task for role='lead' agents."""
    from unittest.mock import MagicMock
    from app.agent.loader import AgentConfig, _build_agent

    factory = MagicMock()
    factory.return_value = MagicMock()

    cfg = AgentConfig(name="lead-agent", role="lead", system_prompt="Lead prompt")
    agent = _build_agent(cfg, {}, factory)

    assert "schedule_task" in agent._tools
    tool = agent._tools["schedule_task"]
    assert tool.name == "schedule_task"


def test_build_agent_does_not_inject_schedule_task_for_member(clean_db):
    """_build_agent does NOT inject schedule_task for role='member' agents."""
    from unittest.mock import MagicMock
    from app.agent.loader import AgentConfig, _build_agent

    factory = MagicMock()
    factory.return_value = MagicMock()

    cfg = AgentConfig(name="member-agent", role="member", system_prompt="Member prompt")
    agent = _build_agent(cfg, {}, factory)

    assert "schedule_task" not in agent._tools


def test_build_agent_schedule_task_not_duplicated(clean_db):
    """If schedule_task is listed in cfg.tools, it is not duplicated."""
    from unittest.mock import MagicMock
    from app.agent.loader import AgentConfig, _build_agent

    factory = MagicMock()
    factory.return_value = MagicMock()

    cfg = AgentConfig(
        name="lead-agent",
        role="lead",
        system_prompt="Lead prompt",
        tools=["schedule_task"],
    )
    agent = _build_agent(cfg, {}, factory)

    assert list(agent._tools.keys()).count("schedule_task") == 1


# ---------------------------------------------------------------------------
# Scope filtering
#
# The scheduler tool is the calling agent's *personal* reminder queue —
# a coding-team lead bound to ``/repo/a`` must never see, mutate, or even
# learn about tasks owned by another workspace or by the default team.
# These tests pin the cross-scope isolation contract: out-of-scope ids
# present the same "not found" surface as truly missing ids, and
# out-of-scope mutations are never issued to the scheduler.
# ---------------------------------------------------------------------------


def _make_task(mode: str, workspace: str | None, name: str = "t") -> MagicMock:
    """Build a minimal mock task with controllable mode/workspace.

    The default ``sample_task`` fixture hard-codes ``mode='normal'``, so
    scope tests need a parameterized factory to mint coding tasks for
    arbitrary workspaces and assert the filter against multiple
    fixtures in the same scenario.
    """
    task = MagicMock()
    task.id = uuid7()
    task.slug = name
    task.name = name
    task.mode = mode
    task.workspace = workspace
    task.schedule_type = "every"
    task.every_seconds = 60
    task.at_datetime = None
    task.cron_expression = None
    task.timezone = "UTC"
    task.prompt = "do thing"
    task.session_id = None
    task.enabled = True
    task.status = "pending"
    task.run_count = 0
    task.max_runs = None
    task.next_fire_at = datetime.now(timezone.utc)
    return task


@pytest.mark.asyncio
async def test_list_default_team_only_sees_normal_tasks(mock_task_scheduler):
    """The default-team lead (``_mode='normal'``) must filter out every
    coding task, regardless of workspace. This prevents the
    user-facing 'normal' chat lead from leaking the existence of any
    workspace-scoped reminder."""
    normal_a = _make_task("normal", None, name="normal-a")
    coding_a = _make_task("coding", "/repo/a", name="coding-a")
    coding_b = _make_task("coding", "/repo/b", name="coding-b")
    mock_task_scheduler.list_tasks.return_value = [normal_a, coding_a, coding_b]

    with patch("app.scheduler.scheduler.task_scheduler", mock_task_scheduler):
        result = await schedule_task.arun(action="list", _injected=_NORMAL_INJECTED)

    assert "Scheduled tasks (1):" in result
    assert "name=normal-a" in result
    # Critical: no leak of the existence of coding tasks — neither the
    # name nor the workspace path may appear in the rendered output.
    assert "coding-a" not in result
    assert "coding-b" not in result
    assert "/repo/a" not in result
    assert "/repo/b" not in result


@pytest.mark.asyncio
async def test_list_coding_lead_only_sees_matching_workspace(mock_task_scheduler):
    """A coding-team lead bound to ``/repo/a`` must filter out:
       1. all normal tasks (different mode),
       2. coding tasks for any *other* workspace.
    Only ``mode='coding' AND workspace='/repo/a'`` survives the filter."""
    normal_a = _make_task("normal", None, name="normal-a")
    coding_a = _make_task("coding", "/repo/a", name="coding-a")
    coding_a2 = _make_task("coding", "/repo/a", name="coding-a2")
    coding_b = _make_task("coding", "/repo/b", name="coding-b")
    mock_task_scheduler.list_tasks.return_value = [
        normal_a,
        coding_a,
        coding_a2,
        coding_b,
    ]

    with patch("app.scheduler.scheduler.task_scheduler", mock_task_scheduler):
        result = await schedule_task.arun(
            action="list", _injected=_coding_injected("/repo/a")
        )

    assert "Scheduled tasks (2):" in result
    assert "name=coding-a" in result
    assert "name=coding-a2" in result
    # Confirm the cross-workspace and cross-mode rows are invisible.
    assert "normal-a" not in result
    assert "coding-b" not in result
    assert "/repo/b" not in result


@pytest.mark.asyncio
async def test_list_filters_to_empty_string_when_all_out_of_scope(
    mock_task_scheduler,
):
    """When the DB has tasks but none match scope, the tool returns the
    empty-state line — not a misleading "Scheduled tasks (0)" header."""
    coding_b = _make_task("coding", "/repo/b")
    mock_task_scheduler.list_tasks.return_value = [coding_b]

    with patch("app.scheduler.scheduler.task_scheduler", mock_task_scheduler):
        result = await schedule_task.arun(
            action="list", _injected=_coding_injected("/repo/a")
        )

    assert result == "No scheduled tasks."


@pytest.mark.asyncio
async def test_coding_lead_workspace_is_required_for_scope_match(
    mock_task_scheduler,
):
    """Defensive: a coding-team lead with ``_workspace=None`` (a
    misconfiguration the injection layer should never produce, but worth
    pinning) must not accidentally match every coding task — it must
    match nothing, because the workspace comparison is strict equality."""
    coding_a = _make_task("coding", "/repo/a")
    mock_task_scheduler.list_tasks.return_value = [coding_a]

    with patch("app.scheduler.scheduler.task_scheduler", mock_task_scheduler):
        result = await schedule_task.arun(
            action="list", _injected={"_mode": "coding", "_workspace": None}
        )

    assert result == "No scheduled tasks."


@pytest.mark.parametrize("action", ["pause", "resume", "delete", "trigger"])
@pytest.mark.asyncio
async def test_mutation_out_of_scope_returns_not_found_and_never_mutates(
    action, mock_task_scheduler
):
    """For every mutating action: if the row exists but belongs to a
    different mode or workspace, the tool returns the same "no task with
    slug" surface as for a genuinely missing row, AND must NOT call the
    underlying scheduler mutation. This is the core security property —
    callers can neither probe existence nor influence cross-scope tasks."""
    # Target row is owned by a *different* coding workspace than the caller.
    cross_scope = _make_task("coding", "/repo/other", name="cross")
    mock_task_scheduler.get_task.return_value = cross_scope

    with patch("app.scheduler.scheduler.task_scheduler", mock_task_scheduler):
        result = await schedule_task.arun(
            action=action,
            slug=cross_scope.slug,
            _injected=_coding_injected("/repo/mine"),
        )

    # Same wording as a missing row — no information leak.
    assert "Error:" in result
    assert f"no task with slug '{cross_scope.slug}'" in result
    # And no mutation reached the scheduler.
    getattr(mock_task_scheduler, action).assert_not_called()


@pytest.mark.parametrize("action", ["pause", "resume", "delete", "trigger"])
@pytest.mark.asyncio
async def test_mutation_normal_caller_cannot_touch_coding_task(
    action, mock_task_scheduler
):
    """The default-team lead must not be able to pause/delete a coding
    task by slug-guessing, even though it has no concept of workspaces."""
    coding_row = _make_task("coding", "/repo/a", name="coding-a")
    mock_task_scheduler.get_task.return_value = coding_row

    with patch("app.scheduler.scheduler.task_scheduler", mock_task_scheduler):
        result = await schedule_task.arun(
            action=action,
            slug=coding_row.slug,
            _injected=_NORMAL_INJECTED,
        )

    assert "Error:" in result
    assert "no task with slug" in result
    getattr(mock_task_scheduler, action).assert_not_called()


@pytest.mark.parametrize("action", ["pause", "resume", "delete", "trigger"])
@pytest.mark.asyncio
async def test_mutation_coding_caller_cannot_touch_normal_task(
    action, mock_task_scheduler
):
    """Symmetric to the previous test: a coding-team lead must not be
    able to mutate a default-team reminder by slug-guessing."""
    normal_row = _make_task("normal", None, name="normal-a")
    mock_task_scheduler.get_task.return_value = normal_row

    with patch("app.scheduler.scheduler.task_scheduler", mock_task_scheduler):
        result = await schedule_task.arun(
            action=action,
            slug=normal_row.slug,
            _injected=_coding_injected("/repo/a"),
        )

    assert "Error:" in result
    assert "no task with slug" in result
    getattr(mock_task_scheduler, action).assert_not_called()


@pytest.mark.asyncio
async def test_mutation_in_scope_passes_through_to_scheduler(
    mock_task_scheduler,
):
    """Positive control for the parameterized scope tests above: the
    same call shape that gets rejected cross-scope must succeed when
    the caller's context matches the row. This guards against
    over-restriction (e.g. accidentally rejecting all mutations)."""
    row = _make_task("coding", "/repo/a", name="my-reminder")
    mock_task_scheduler.get_task.return_value = row
    mock_task_scheduler.pause.return_value = row

    with patch("app.scheduler.scheduler.task_scheduler", mock_task_scheduler):
        result = await schedule_task.arun(
            action="pause",
            slug=row.slug,
            _injected=_coding_injected("/repo/a"),
        )

    assert "Task 'my-reminder' paused." in result
    mock_task_scheduler.pause.assert_called_once_with(row.slug)


# ---------------------------------------------------------------------------
# Loop-engineering surface
#
# These tests pin the vocabulary the LLM reads in the tool's description
# and parameter descriptions — the key loop-engineering concepts must be
# present so the model knows how to build self-scheduling loops.
# ---------------------------------------------------------------------------


def test_tool_description_contains_loop_vocabulary():
    """The LLM-visible description must explain the loop-engineering primitives
    so the model can construct bounded self-scheduling loops without external
    prompting."""
    desc = schedule_task.description
    assert desc is not None
    # Core loop primitive names
    assert "session_id='current'" in desc or "current" in desc
    assert "max_runs" in desc
    assert "loop" in desc.lower()


def test_tool_description_explains_early_loop_exit():
    """The description must tell the model it can end a condition-driven loop
    early by deleting/pausing its own task, rather than always running to
    max_runs. Without this the model wastes iterations after the goal is met."""
    desc = schedule_task.description
    assert desc is not None
    lower = desc.lower()
    # Mentions the active exit mechanism …
    assert "delete" in lower or "pause" in lower
    # … and ties it to stopping early / not relying solely on max_runs.
    assert "early" in lower or "own task" in lower


def test_prompt_param_description_mentions_loop():
    """The 'prompt' parameter description must mention its role in loops,
    so the model understands it is the per-iteration instruction."""
    params = schedule_task.definition["function"]["parameters"]["properties"]
    prompt_desc = params["prompt"]["description"]
    assert (
        "loop" in prompt_desc.lower()
        or "re-invoke" in prompt_desc.lower()
        or "scheduler" in prompt_desc.lower()
    )


def test_session_id_param_description_explains_current():
    """'session_id' description must explain what 'current' does — re-enters
    the current conversation — so the model picks the right value for loops."""
    params = schedule_task.definition["function"]["parameters"]["properties"]
    sid_desc = params["session_id"]["description"]
    assert "current" in sid_desc
    assert "conversation" in sid_desc.lower() or "inline" in sid_desc.lower()


def test_max_runs_param_description_explains_bounded_loop():
    """'max_runs' description must mention bounding a loop, not just 'cap'."""
    params = schedule_task.definition["function"]["parameters"]["properties"]
    mr_desc = params["max_runs"]["description"]
    assert "loop" in mr_desc.lower() or "poll" in mr_desc.lower()
