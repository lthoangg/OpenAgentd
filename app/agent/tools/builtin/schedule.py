"""schedule_task tool — the agent's personal reminder / self-scheduling loop engine.

Scheduling is **first-person**: every task the lead schedules fires back to
*itself* (same mode, same workspace) at the target time. There is no
cross-channel or cross-workspace surface — the tool only ever sees and acts on
tasks bound to the calling lead's routing context.

Beyond one-shot reminders, the tool doubles as a **loop engine**: combining
``session_id='current'`` with ``every_seconds`` + ``max_runs`` lets the lead
schedule a prompt that re-invokes itself into a bounded self-scheduling loop.
The LLM-facing tool and parameter descriptions below define the loop patterns,
exit paths, and scheduling primitives.

All operations proxy through the in-process
:data:`~app.scheduler.scheduler.task_scheduler` singleton so no HTTP
round-trip is needed.
"""

from __future__ import annotations

from datetime import datetime
from typing import Annotated, Any, Literal

from loguru import logger
from pydantic import AliasChoices, BaseModel, Field, model_validator

from app.agent.tools.registry import InjectedArg, Tool


_DESCRIPTION = (
    "Schedule your own future or recurring prompt. For a bounded loop use "
    "schedule_type='every', every_seconds=30, session_id='current', and max_runs. "
    "Use trigger for an immediate first run, then pause or delete early when done."
)


class ScheduleArgs(BaseModel):
    """Arguments for the schedule_task tool."""

    action: Literal["create", "list", "pause", "resume", "delete", "trigger"] = Field(
        description="Reminder action; trigger runs it immediately."
    )
    # ── create-only fields ──────────────────────────────────────────────
    name: str | None = Field(
        default=None,
        description="[create] Unique human-readable task name.",
    )
    schedule_type: Literal["at", "every", "cron"] | None = Field(
        default=None,
        description=(
            "[create] Schedule type: at is one-shot, every is an interval, "
            "and cron is a 5-field expression."
        ),
    )
    at_datetime: str | None = Field(
        default=None,
        description=("[create, schedule_type='at'] ISO-8601 datetime."),
    )
    every_seconds: int | None = Field(
        default=None,
        gt=0,
        description=("[create, schedule_type='every'] Interval in seconds."),
    )
    cron_expression: str | None = Field(
        default=None,
        description=("[create, schedule_type='cron'] 5-field cron expression."),
    )
    timezone: str = Field(
        default="UTC",
        description=("[create] IANA timezone for cron and naive at datetimes."),
    )
    prompt: str | None = Field(
        default=None,
        description=(
            "[create] Prompt delivered when the task fires; for loops, describe "
            "one iteration."
        ),
    )
    session_id: str | None = Field(
        default=None,
        description=(
            "[create] Where prompts land: 'current' re-enters this conversation; "
            "'auto' uses a persistent task session; omit for a fresh session; "
            "a UUID continues that session."
        ),
    )
    max_runs: int | None = Field(
        default=None,
        gt=0,
        description=(
            "[create] Maximum successful firings; the task then disables. "
            "Use to bound loops."
        ),
    )
    enabled: bool = Field(
        default=True,
        description="[create] Start enabled.",
    )
    # ── pause / resume / delete / trigger fields ────────────────────────
    slug: str | None = Field(
        default=None,
        validation_alias=AliasChoices("slug", "task_slug"),
        description="Task slug for pause, resume, delete, or trigger.",
    )

    @model_validator(mode="after")
    def _validate_args(self) -> ScheduleArgs:
        if self.action in ("pause", "resume", "delete", "trigger"):
            if not self.slug:
                raise ValueError(f"slug is required for action='{self.action}'")
            return self

        if self.action == "create":
            if not self.name:
                raise ValueError("name is required for action='create'")
            if not self.schedule_type:
                raise ValueError("schedule_type is required for action='create'")
            if not self.prompt:
                raise ValueError("prompt is required for action='create'")

            st = self.schedule_type
            if st == "at":
                if not self.at_datetime:
                    raise ValueError("at_datetime is required for schedule_type='at'")
                if self.every_seconds is not None or self.cron_expression is not None:
                    raise ValueError(
                        "Only at_datetime may be set for schedule_type='at'"
                    )
            elif st == "every":
                if self.every_seconds is None:
                    raise ValueError(
                        "every_seconds is required for schedule_type='every'"
                    )
                if self.at_datetime is not None or self.cron_expression is not None:
                    raise ValueError(
                        "Only every_seconds may be set for schedule_type='every'"
                    )
            elif st == "cron":
                if not self.cron_expression:
                    raise ValueError(
                        "cron_expression is required for schedule_type='cron'"
                    )
                if self.at_datetime is not None or self.every_seconds is not None:
                    raise ValueError(
                        "Only cron_expression may be set for schedule_type='cron'"
                    )
        return self


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _fmt_task(task: Any) -> str:
    """Format a ScheduledTask (or ScheduledTaskResponse) into a readable line."""
    schedule = ""
    st = getattr(task, "schedule_type", "?")
    if st == "at":
        dt = getattr(task, "at_datetime", None)
        schedule = f"at {dt}" if dt else "at ?"
    elif st == "every":
        secs = getattr(task, "every_seconds", None)
        schedule = f"every {secs}s" if secs else "every ?"
    elif st == "cron":
        expr = getattr(task, "cron_expression", None)
        tz = getattr(task, "timezone", "UTC")
        schedule = f"cron '{expr}' ({tz})" if expr else "cron ?"

    status = getattr(task, "status", "unknown")
    enabled = getattr(task, "enabled", True)
    run_count = getattr(task, "run_count", 0)
    max_runs = getattr(task, "max_runs", None)
    next_fire = getattr(task, "next_fire_at", None)
    name = getattr(task, "name", "?")
    workspace = getattr(task, "workspace", None)
    slug = getattr(task, "slug", "?")

    target = f"workspace={workspace}" if workspace else "coding workspace"

    parts = [
        f"slug={slug}",
        f"name={name}",
        target,
        f"schedule={schedule}",
        f"status={'enabled' if enabled else 'paused'}/{status}",
        f"runs={run_count}" + (f"/{max_runs}" if max_runs is not None else ""),
    ]
    if next_fire:
        parts.append(f"next={next_fire}")
    return "  " + " | ".join(parts)


# ---------------------------------------------------------------------------
# Tool implementation
# ---------------------------------------------------------------------------


async def _schedule_task(
    action: Literal["create", "list", "pause", "resume", "delete", "trigger"],
    name: str | None = None,
    schedule_type: Literal["at", "every", "cron"] | None = None,
    at_datetime: str | None = None,
    every_seconds: int | None = None,
    cron_expression: str | None = None,
    timezone: str = "UTC",
    prompt: str | None = None,
    session_id: str | None = None,
    max_runs: int | None = None,
    enabled: bool = True,
    slug: str | None = None,
    # ── injected ─────────────────────────────────────────────────────────────
    # ``_workspace`` and current-session metadata are derived from
    # the calling agent's runtime context by the tool executor — never accepted from LLM-supplied args.
    # See ``app.agent.agent_loop.tool_executor.make_tool_executor``.
    _state: Annotated[Any, InjectedArg()] = None,
    _workspace: Annotated[str, InjectedArg()] = "",
) -> str:
    """Create, list, or control the lead's scheduled reminders / loops."""
    from app.scheduler.scheduler import task_scheduler

    # ── scope helpers ────────────────────────────────────────────────────────
    # Every action other than ``create`` operates on tasks that already
    # exist in the DB. The agent calling this tool is bound to a specific
    # coding workspace context, and must only see /
    # touch tasks that belong to that same context:
    #
    # Cross-scope IDs are reported as "no task with id …" (not "forbidden")
    # so the agent has no way to enumerate or probe tasks outside its
    # scope — the surface is identical to a missing row.
    def _in_scope(task: Any) -> bool:
        return getattr(task, "workspace", None) == _workspace

    # ── list ─────────────────────────────────────────────────────────────────
    if action == "list":
        tasks = await task_scheduler.list_tasks()
        tasks = [t for t in tasks if _in_scope(t)]
        if not tasks:
            return "No scheduled tasks."
        lines = [f"Scheduled tasks ({len(tasks)}):"]
        for t in tasks:
            lines.append(_fmt_task(t))
        return "\n".join(lines)

    # ── pause / resume / delete / trigger ────────────────────────────────────
    if action in ("pause", "resume", "delete", "trigger"):
        assert slug is not None

        # Scope check happens before any mutation. ``pause``/``resume``
        # would otherwise mutate via the scheduler before we could inspect
        # the row's mode/workspace.
        existing = await task_scheduler.get_task(slug)
        if existing is None or not _in_scope(existing):
            return f"Error: no task with slug '{slug}'."

        if action == "pause":
            task = await task_scheduler.pause(slug)
            logger.info("schedule_tool_pause task_slug={} name={}", slug, task.name)
            return f"Task '{task.name}' paused."

        if action == "resume":
            task = await task_scheduler.resume(slug)
            logger.info("schedule_tool_resume task_slug={} name={}", slug, task.name)
            return f"Task '{task.name}' resumed. Next fire: {task.next_fire_at}"

        if action == "delete":
            await task_scheduler.remove(slug)
            logger.info(
                "schedule_tool_delete task_slug={} name={}", slug, existing.name
            )
            return f"Task '{existing.name}' deleted."

        if action == "trigger":
            await task_scheduler.trigger(slug)
            logger.info(
                "schedule_tool_trigger task_slug={} name={}", slug, existing.name
            )
            return f"Task '{existing.name}' triggered immediately."

    # ── create ───────────────────────────────────────────────────────────────
    if action == "create":
        assert name is not None
        assert schedule_type is not None
        assert prompt is not None

        from app.scheduler.models import ScheduledTask
        from app.scheduler.scheduler import task_scheduler as _scheduler
        from app.scheduler.schemas import ScheduledTaskCreate

        if session_id == "current":
            current_session_id = getattr(_state, "metadata", {}).get("session_id")
            if not isinstance(current_session_id, str) or not current_session_id:
                return "Error: session_id='current' is unavailable outside an active chat session."
            session_id = current_session_id

        # Parse at_datetime string → datetime. If the string is naive (no
        # offset / "Z"), interpret it in the user-supplied `timezone` rather
        # than letting downstream code assume UTC.
        at_dt: datetime | None = None
        if at_datetime:
            try:
                at_dt = datetime.fromisoformat(at_datetime)
            except ValueError as exc:
                return f"Error: invalid at_datetime '{at_datetime}': {exc}"
            if at_dt.tzinfo is None:
                from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

                try:
                    at_dt = at_dt.replace(tzinfo=ZoneInfo(timezone))
                except ZoneInfoNotFoundError:
                    return f"Error: unknown timezone '{timezone}'."

        try:
            payload = ScheduledTaskCreate(
                name=name,
                slug=slug,
                workspace=_workspace or "",
                schedule_type=schedule_type,
                at_datetime=at_dt,
                every_seconds=every_seconds,
                cron_expression=cron_expression,
                timezone=timezone,
                prompt=prompt,
                session_id=session_id,
                max_runs=max_runs,
                enabled=enabled,
            )
        except Exception as exc:
            return f"Error: invalid task configuration — {exc}"

        # Go through ``scheduler.create`` (not ``add``) so the workspace/
        # session compatibility validators run.
        try:
            created = await _scheduler.create(payload)
        except Exception as exc:
            return f"Error: failed to create task — {exc}"

        # ScheduledTask is only used implicitly via _scheduler.create; keep
        # the import for type narrowing in callers that consume `created`.
        _ = ScheduledTask

        logger.info(
            "schedule_tool_create name={} workspace={} schedule_type={} next_fire={}",
            created.name,
            created.workspace,
            created.schedule_type,
            created.next_fire_at,
        )
        target_line = f"  workspace   : {created.workspace}\n"
        return (
            f"Scheduled task created.\n"
            f"  id          : {created.id}\n"
            f"  slug        : {created.slug}\n"
            f"  name        : {created.name}\n"
            + target_line
            + f"  schedule    : {created.schedule_type}\n"
            f"  next fire   : {created.next_fire_at}\n"
            + (f"  max runs    : {created.max_runs}\n" if created.max_runs else "")
            + f"  prompt      : {created.prompt!r}"
        )

    return f"Error: unknown action '{action}'."


schedule_task = Tool(
    _schedule_task,
    name="schedule_task",
    description=_DESCRIPTION,
    args_schema=ScheduleArgs,
)
