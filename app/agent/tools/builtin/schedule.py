"""schedule_task tool — the team lead's personal reminder / self-scheduling loop engine.

Scheduling is **first-person**: every task the lead schedules fires back to
*itself* (same mode, same workspace) at the target time. There is no
cross-team or cross-workspace surface — the tool only ever sees and acts on
tasks bound to the calling lead's routing context.

Beyond one-shot reminders, the tool doubles as a **loop engine**: combining
``session_id='current'`` with ``every_seconds`` + ``max_runs`` lets the lead
schedule a prompt that re-invokes itself into a bounded self-scheduling loop.
The LLM-facing guidance for that lives in the tool/parameter descriptions
below; the conceptual reference (loop patterns, exit paths, primitives) is in
``documents/docs/agent/tools.md`` → "Loop engineering — self-scheduling
agentic loops".

All operations proxy through the in-process
:data:`~app.scheduler.scheduler.task_scheduler` singleton so no HTTP
round-trip is needed.
"""

from __future__ import annotations

from datetime import datetime
from typing import Annotated, Any, Literal

from loguru import logger
from pydantic import Field

from app.agent.tools.registry import InjectedArg, Tool


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
    mode = getattr(task, "mode", "normal")
    workspace = getattr(task, "workspace", None)
    task_id = getattr(task, "id", "?")

    target = f"mode={mode}"
    if mode == "coding" and workspace:
        target += f" workspace={workspace}"

    parts = [
        f"id={task_id}",
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
    action: Annotated[
        Literal["create", "list", "pause", "resume", "delete", "trigger"],
        Field(
            description=(
                "Action to perform on your own reminders: "
                "'create' a new reminder, "
                "'list' your pending reminders, "
                "'pause' a running reminder, "
                "'resume' a paused reminder, "
                "'delete' a reminder, "
                "'trigger' a reminder immediately (deliver its prompt now)."
            )
        ),
    ],
    # ── create-only fields ──────────────────────────────────────────────────
    name: Annotated[
        str | None,
        Field(
            default=None,
            description=(
                "[create] Unique task name. "
                "Pattern: ^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$. "
                "Required for create."
            ),
        ),
    ] = None,
    schedule_type: Annotated[
        Literal["at", "every", "cron"] | None,
        Field(
            default=None,
            description=(
                "[create] Schedule type. Required for create. "
                "'at' = one-shot at a specific datetime, "
                "'every' = repeat every N seconds, "
                "'cron' = 5-field cron expression."
            ),
        ),
    ] = None,
    at_datetime: Annotated[
        str | None,
        Field(
            default=None,
            description=(
                "[create, schedule_type='at'] ISO-8601 datetime string "
                "e.g. '2026-05-01T09:00:00+00:00'. Required when schedule_type='at'."
            ),
        ),
    ] = None,
    every_seconds: Annotated[
        int | None,
        Field(
            default=None,
            gt=0,
            description=(
                "[create, schedule_type='every'] Interval in seconds (> 0). "
                "Required when schedule_type='every'."
            ),
        ),
    ] = None,
    cron_expression: Annotated[
        str | None,
        Field(
            default=None,
            description=(
                "[create, schedule_type='cron'] Standard 5-field cron expression "
                "e.g. '0 9 * * 1-5'. Required when schedule_type='cron'."
            ),
        ),
    ] = None,
    timezone: Annotated[
        str,
        Field(
            default="UTC",
            description=(
                "[create] IANA timezone name for cron/at interpretation, "
                "e.g. 'Asia/Ho_Chi_Minh', 'America/New_York'. Defaults to 'UTC'."
            ),
        ),
    ] = "UTC",
    prompt: Annotated[
        str | None,
        Field(
            default=None,
            description=(
                "[create] The prompt delivered back to you when the task fires. "
                "Write it in the second person, addressed to your future self. "
                "For self-scheduling loops this is the per-iteration instruction — "
                "e.g. 'Check whether the deployment finished and report the result. "
                "If still running, note it and stop (the scheduler re-invokes you).'. "
                "Required for create."
            ),
        ),
    ] = None,
    session_id: Annotated[
        str | None,
        Field(
            default=None,
            description=(
                "[create] Session continuity — controls where the fired prompt lands. "
                "'current' = re-enter the current conversation (reply appears inline; "
                "use this for self-continuation loops so you can read your prior work). "
                "'auto' = persistent session keyed to the task name (survives restarts; "
                "good for long-running background monitors). "
                "None = fresh session each firing. "
                "UUID string = continue a specific existing session."
            ),
        ),
    ] = None,
    max_runs: Annotated[
        int | None,
        Field(
            default=None,
            gt=0,
            description=(
                "[create] Hard cap on successful firings — the task auto-disables "
                "after N runs. None = unlimited. "
                "Use this to bound any polling or retry loop, "
                "e.g. max_runs=20 with every_seconds=30 = poll for 10 minutes then stop."
            ),
        ),
    ] = None,
    enabled: Annotated[
        bool,
        Field(
            default=True,
            description="[create] Whether the task starts enabled. Defaults to True.",
        ),
    ] = True,
    # ── pause / resume / delete / trigger fields ─────────────────────────────
    task_id: Annotated[
        str | None,
        Field(
            default=None,
            description="[pause|resume|delete|trigger] UUID of the task to act on.",
        ),
    ] = None,
    # ── injected ─────────────────────────────────────────────────────────────
    # ``_mode`` / ``_workspace`` and current-session metadata are derived from
    # the calling agent's runtime context by the tool executor — never accepted from LLM-supplied args.
    # See ``app.agent.agent_loop.tool_executor.make_tool_executor``.
    _state: Annotated[Any, InjectedArg()] = None,
    _mode: Annotated[Literal["normal", "coding"], InjectedArg()] = "normal",
    _workspace: Annotated[str | None, InjectedArg()] = None,
) -> str:
    """Schedule a prompt to be delivered back to you at a future time or on a
    recurring schedule — and build self-scheduling agentic loops.

    Every task fires back to *you* (same team, same workspace). This is both
    a reminder tool and a **loop engine**: by combining ``session_id='current'``
    with ``every_seconds`` + ``max_runs`` you create a bounded polling loop
    that re-invokes you automatically until a condition is met or the cap is hit.

    Loop recipe (bounded polling)::

        action='create', schedule_type='every', every_seconds=30, max_runs=20,
        session_id='current',
        prompt='Check build status and report. If still running, just note it
                — the scheduler will call you again automatically.'

    Then optionally call ``trigger`` on the returned id to fire the first
    iteration immediately without waiting for the first 30-second window.
    When the loop's goal is met, call ``delete`` (or ``pause``) on its own
    task id to exit early — ``max_runs`` is only the safety backstop, not
    the intended stopping point for a condition-driven loop.

    Other uses:
      * One-shot follow-up: ``schedule_type='at'``, specific ``at_datetime``
      * Recurring background job: ``schedule_type='cron'``, ``session_id='auto'``
      * "Remind me in 30 minutes": ``schedule_type='every'``, ``every_seconds=1800``,
        ``max_runs=1``

    Use ``list`` to inspect active loops, ``pause``/``resume`` to toggle them,
    ``delete`` to tear one down, ``trigger`` to fire immediately.
    Tasks from other teams or workspaces are invisible to you.
    """
    from app.scheduler.scheduler import task_scheduler

    # ── scope helpers ────────────────────────────────────────────────────────
    # Every action other than ``create`` operates on tasks that already
    # exist in the DB. The agent calling this tool is bound to a specific
    # routing context (``_mode`` + ``_workspace``), and must only see /
    # touch tasks that belong to that same context:
    #
    #   * Default-team lead (``_mode='normal'``)  → only ``mode='normal'``
    #     tasks.
    #   * Coding-team lead   (``_mode='coding'``) → only ``mode='coding'``
    #     tasks with a matching ``workspace``.
    #
    # Cross-scope IDs are reported as "no task with id …" (not "forbidden")
    # so the agent has no way to enumerate or probe tasks outside its
    # scope — the surface is identical to a missing row.
    def _in_scope(task: Any) -> bool:
        t_mode = getattr(task, "mode", "normal")
        if t_mode != _mode:
            return False
        if _mode == "coding":
            return getattr(task, "workspace", None) == _workspace
        return True

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
        if not task_id:
            return f"Error: 'task_id' is required for action='{action}'."

        from uuid import UUID

        try:
            uid = UUID(task_id)
        except ValueError:
            return f"Error: '{task_id}' is not a valid UUID."

        # Scope check happens before any mutation. ``pause``/``resume``
        # would otherwise mutate via the scheduler before we could inspect
        # the row's mode/workspace.
        existing = await task_scheduler.get_task(uid)
        if existing is None or not _in_scope(existing):
            return f"Error: no task with id '{task_id}'."

        if action == "pause":
            task = await task_scheduler.pause(uid)
            logger.info("schedule_tool_pause task_id={} name={}", uid, task.name)
            return f"Task '{task.name}' paused."

        if action == "resume":
            task = await task_scheduler.resume(uid)
            logger.info("schedule_tool_resume task_id={} name={}", uid, task.name)
            return f"Task '{task.name}' resumed. Next fire: {task.next_fire_at}"

        if action == "delete":
            await task_scheduler.remove(uid)
            logger.info("schedule_tool_delete task_id={} name={}", uid, existing.name)
            return f"Task '{existing.name}' deleted."

        if action == "trigger":
            await task_scheduler.trigger(uid)
            logger.info("schedule_tool_trigger task_id={} name={}", uid, existing.name)
            return f"Task '{existing.name}' triggered immediately."

    # ── create ───────────────────────────────────────────────────────────────
    if action == "create":
        missing = [
            f
            for f, v in [
                ("name", name),
                ("schedule_type", schedule_type),
                ("prompt", prompt),
            ]
            if not v
        ]
        if missing:
            return f"Error: the following fields are required for create: {', '.join(missing)}."
        # Narrow Optional → required for the type checker (the loop above
        # already guaranteed all three are truthy).
        assert name is not None
        assert schedule_type is not None
        assert prompt is not None

        from app.scheduler.models import ScheduledTask
        from app.scheduler.scheduler import task_scheduler as _scheduler
        from app.scheduler.schemas import ScheduledTaskCreate

        if session_id == "current":
            current_session_id = getattr(_state, "metadata", {}).get(
                "lead_session_id"
            ) or getattr(_state, "metadata", {}).get("session_id")
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
                mode=_mode,
                workspace=_workspace,
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
            "schedule_tool_create name={} mode={} workspace={} schedule_type={} next_fire={}",
            created.name,
            created.mode,
            created.workspace,
            created.schedule_type,
            created.next_fire_at,
        )
        target_line = f"  mode        : {created.mode}\n" + (
            f"  workspace   : {created.workspace}\n" if created.workspace else ""
        )
        return (
            f"Scheduled task created.\n"
            f"  id          : {created.id}\n"
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
)
