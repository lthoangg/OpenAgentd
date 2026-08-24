"""Regression coverage for the coding-workspace-only team runtime."""

from types import SimpleNamespace

from app.agent.builtin_prompts import (
    BUILTIN_AGENT_BLUEPRINTS,
    BUILTIN_MEMBER_PROFILES,
    builtin_member_profile,
)
from app.agent.tools.builtin.schedule import _fmt_task


def test_builtin_runtime_contains_only_coding_profiles() -> None:
    assert set(BUILTIN_MEMBER_PROFILES) == {"coding"}
    assert set(BUILTIN_AGENT_BLUEPRINTS) == {"coding"}


def test_builtin_members_have_no_deleted_normal_mode_profiles() -> None:
    assert builtin_member_profile("normal", "executor") is None
    assert builtin_member_profile("normal", "explorer") is None


def test_schedule_format_does_not_expose_a_deleted_mode() -> None:
    rendered = _fmt_task(
        SimpleNamespace(
            slug="build",
            name="Build",
            mode="normal",
            workspace=None,
            schedule_type="at",
            at_datetime="2026-01-01T00:00:00+00:00",
            status="pending",
            enabled=True,
            run_count=0,
            max_runs=None,
            next_fire_at=None,
        )
    )
    assert "mode=normal" not in rendered
    assert "workspace=" not in rendered
