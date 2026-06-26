"""Tests for app/scheduler/schemas.py — request validators."""

from __future__ import annotations

from datetime import datetime, timezone

import pytest
from pydantic import ValidationError

from app.scheduler.schemas import ScheduledTaskCreate, ScheduledTaskUpdate


_UTC = timezone.utc


# ---------------------------------------------------------------------------
# ScheduledTaskCreate — name validation
# ---------------------------------------------------------------------------


class TestNameValidation:
    def test_valid_simple_name(self):
        body = ScheduledTaskCreate(
            name="hello",
            mode="normal",
            schedule_type="every",
            every_seconds=60,
            prompt="hi",
        )
        assert body.name == "hello"

    def test_valid_with_dots_dashes_underscores(self):
        body = ScheduledTaskCreate(
            name="my.task-1_v2",
            mode="normal",
            schedule_type="every",
            every_seconds=60,
            prompt="hi",
        )
        assert body.name == "my.task-1_v2"

    def test_valid_friendly_title(self):
        body = ScheduledTaskCreate(
            name="Daily Standup Meeting 2026! / Backup",
            mode="normal",
            schedule_type="every",
            every_seconds=60,
            prompt="hi",
        )
        assert body.name == "Daily Standup Meeting 2026! / Backup"

    @pytest.mark.parametrize(
        "bad,expected_err",
        [
            ("", "name cannot be empty"),
            ("   ", "name cannot be empty"),
            ("x" * 101, "name must be 100 characters or less"),
        ],
    )
    def test_invalid_names_rejected(self, bad, expected_err):
        with pytest.raises(ValidationError) as excinfo:
            ScheduledTaskCreate(
                name=bad,
                mode="normal",
                schedule_type="every",
                every_seconds=60,
                prompt="hi",
            )
        assert expected_err in str(excinfo.value)


# ---------------------------------------------------------------------------
# ScheduledTaskCreate — schedule_type "at"
# ---------------------------------------------------------------------------


class TestCreateAt:
    def test_valid_at(self):
        target = datetime(2030, 1, 1, 12, 0, tzinfo=_UTC)
        body = ScheduledTaskCreate(
            name="t1",
            mode="normal",
            schedule_type="at",
            at_datetime=target,
            prompt="hi",
        )
        assert body.at_datetime == target

    def test_at_requires_at_datetime(self):
        with pytest.raises(ValidationError, match="at_datetime is required"):
            ScheduledTaskCreate(
                name="t1",
                mode="normal",
                schedule_type="at",
                prompt="hi",
            )

    def test_at_rejects_every_seconds(self):
        with pytest.raises(ValidationError, match="Only at_datetime"):
            ScheduledTaskCreate(
                name="t1",
                mode="normal",
                schedule_type="at",
                at_datetime=datetime(2030, 1, 1, tzinfo=_UTC),
                every_seconds=60,
                prompt="hi",
            )

    def test_at_rejects_cron_expression(self):
        with pytest.raises(ValidationError, match="Only at_datetime"):
            ScheduledTaskCreate(
                name="t1",
                mode="normal",
                schedule_type="at",
                at_datetime=datetime(2030, 1, 1, tzinfo=_UTC),
                cron_expression="* * * * *",
                prompt="hi",
            )


# ---------------------------------------------------------------------------
# ScheduledTaskCreate — schedule_type "every"
# ---------------------------------------------------------------------------


class TestCreateEvery:
    def test_valid_every(self):
        body = ScheduledTaskCreate(
            name="t",
            mode="normal",
            schedule_type="every",
            every_seconds=300,
            prompt="hi",
        )
        assert body.every_seconds == 300

    def test_every_requires_every_seconds(self):
        with pytest.raises(ValidationError, match="every_seconds is required"):
            ScheduledTaskCreate(
                name="t",
                mode="normal",
                schedule_type="every",
                prompt="hi",
            )

    def test_every_rejects_at_datetime(self):
        with pytest.raises(ValidationError, match="Only every_seconds"):
            ScheduledTaskCreate(
                name="t",
                mode="normal",
                schedule_type="every",
                every_seconds=60,
                at_datetime=datetime(2030, 1, 1, tzinfo=_UTC),
                prompt="hi",
            )

    def test_every_rejects_cron(self):
        with pytest.raises(ValidationError, match="Only every_seconds"):
            ScheduledTaskCreate(
                name="t",
                mode="normal",
                schedule_type="every",
                every_seconds=60,
                cron_expression="* * * * *",
                prompt="hi",
            )

    def test_every_seconds_must_be_positive(self):
        with pytest.raises(ValidationError):
            ScheduledTaskCreate(
                name="t",
                mode="normal",
                schedule_type="every",
                every_seconds=0,
                prompt="hi",
            )

    def test_max_runs_must_be_positive_when_provided(self):
        with pytest.raises(ValidationError):
            ScheduledTaskCreate(
                name="t",
                mode="normal",
                schedule_type="every",
                every_seconds=60,
                prompt="hi",
                max_runs=0,
            )

    def test_max_runs_accepts_positive_cap(self):
        body = ScheduledTaskCreate(
            name="t",
            mode="normal",
            schedule_type="every",
            every_seconds=60,
            prompt="hi",
            max_runs=10,
        )
        assert body.max_runs == 10


# ---------------------------------------------------------------------------
# ScheduledTaskCreate — schedule_type "cron"
# ---------------------------------------------------------------------------


class TestCreateCron:
    def test_valid_cron(self):
        body = ScheduledTaskCreate(
            name="t",
            mode="normal",
            schedule_type="cron",
            cron_expression="0 0 * * *",
            prompt="hi",
        )
        assert body.cron_expression == "0 0 * * *"

    def test_cron_requires_cron_expression(self):
        with pytest.raises(ValidationError, match="cron_expression is required"):
            ScheduledTaskCreate(
                name="t",
                mode="normal",
                schedule_type="cron",
                prompt="hi",
            )

    def test_cron_rejects_at_datetime(self):
        with pytest.raises(ValidationError, match="Only cron_expression"):
            ScheduledTaskCreate(
                name="t",
                mode="normal",
                schedule_type="cron",
                cron_expression="* * * * *",
                at_datetime=datetime(2030, 1, 1, tzinfo=_UTC),
                prompt="hi",
            )

    def test_cron_rejects_every_seconds(self):
        with pytest.raises(ValidationError, match="Only cron_expression"):
            ScheduledTaskCreate(
                name="t",
                mode="normal",
                schedule_type="cron",
                cron_expression="* * * * *",
                every_seconds=60,
                prompt="hi",
            )

    def test_invalid_cron_expression_rejected(self):
        with pytest.raises(ValidationError, match="Invalid cron expression"):
            ScheduledTaskCreate(
                name="t",
                mode="normal",
                schedule_type="cron",
                cron_expression="not a cron",
                prompt="hi",
            )


# ---------------------------------------------------------------------------
# ScheduledTaskCreate — unknown schedule_type
# ---------------------------------------------------------------------------


class TestCreateUnknown:
    def test_unknown_schedule_type_rejected(self):
        with pytest.raises(ValidationError, match="schedule_type must be"):
            ScheduledTaskCreate(
                name="t",
                mode="normal",
                schedule_type="weekly",
                prompt="hi",
            )


# ---------------------------------------------------------------------------
# ScheduledTaskUpdate — partial validation
# ---------------------------------------------------------------------------


class TestUpdate:
    def test_no_schedule_type_skips_validation(self):
        # Only prompt change — schedule fields not validated.
        body = ScheduledTaskUpdate(prompt="new text")
        assert body.prompt == "new text"

    def test_at_in_update_rejects_other_fields(self):
        with pytest.raises(ValidationError, match="Only at_datetime"):
            ScheduledTaskUpdate(
                schedule_type="at",
                at_datetime=datetime(2030, 1, 1, tzinfo=_UTC),
                every_seconds=60,
            )

    def test_every_in_update_rejects_other_fields(self):
        with pytest.raises(ValidationError, match="Only every_seconds"):
            ScheduledTaskUpdate(
                schedule_type="every",
                every_seconds=60,
                cron_expression="* * * * *",
            )

    def test_cron_in_update_rejects_other_fields(self):
        with pytest.raises(ValidationError, match="Only cron_expression"):
            ScheduledTaskUpdate(
                schedule_type="cron",
                cron_expression="* * * * *",
                at_datetime=datetime(2030, 1, 1, tzinfo=_UTC),
            )

    def test_cron_validation_runs_when_expression_present(self):
        with pytest.raises(ValidationError, match="Invalid cron expression"):
            ScheduledTaskUpdate(
                schedule_type="cron",
                cron_expression="bogus",
            )

    def test_cron_without_expression_allowed_for_partial_update(self):
        # schedule_type=cron without cron_expression is permitted on partial
        # updates because the existing row already has a valid expression.
        body = ScheduledTaskUpdate(schedule_type="cron")
        assert body.schedule_type == "cron"

    def test_unknown_schedule_type_rejected(self):
        with pytest.raises(ValidationError, match="schedule_type must be"):
            ScheduledTaskUpdate(schedule_type="yearly")

    def test_max_runs_can_be_cleared_on_update(self):
        body = ScheduledTaskUpdate(max_runs=None)
        assert body.max_runs is None
        assert "max_runs" in body.model_fields_set

    def test_max_runs_update_must_be_positive_when_provided(self):
        with pytest.raises(ValidationError):
            ScheduledTaskUpdate(max_runs=0)


# ---------------------------------------------------------------------------
# Cross-field: mode + workspace
# ---------------------------------------------------------------------------


class TestModeWorkspace:
    def test_normal_mode_default_no_workspace(self):
        body = ScheduledTaskCreate(
            name="n", schedule_type="every", every_seconds=60, prompt="hi"
        )
        assert body.mode == "normal"
        assert body.workspace is None

    def test_coding_mode_requires_workspace(self):
        with pytest.raises(ValidationError, match="workspace is required"):
            ScheduledTaskCreate(
                name="c",
                mode="coding",
                schedule_type="every",
                every_seconds=60,
                prompt="hi",
            )

    def test_normal_mode_rejects_workspace(self):
        with pytest.raises(ValidationError, match="workspace must be empty"):
            ScheduledTaskCreate(
                name="c",
                mode="normal",
                workspace="/tmp/foo",
                schedule_type="every",
                every_seconds=60,
                prompt="hi",
            )

    def test_coding_mode_with_workspace_accepted(self):
        body = ScheduledTaskCreate(
            name="c",
            mode="coding",
            workspace="/tmp/foo",
            schedule_type="every",
            every_seconds=60,
            prompt="hi",
        )
        assert body.mode == "coding"
        assert body.workspace == "/tmp/foo"

    def test_update_normal_mode_rejects_workspace(self):
        with pytest.raises(ValidationError, match="workspace must be empty"):
            ScheduledTaskUpdate(mode="normal", workspace="/tmp/foo")

    def test_update_mode_alone_accepted(self):
        # Workspace not in payload — service layer merges with row state.
        body = ScheduledTaskUpdate(mode="coding")
        assert body.mode == "coding"
        assert body.workspace is None
