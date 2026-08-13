"""Board-driven activation — the todo board as the team's coordination backbone.

Board mutations produce transition-edge events that wake the right agents:

* A task that becomes **ready** (assigned, pending, unclaimed, all
  dependencies completed) wakes its assignee with the task brief — assignment
  *is* delegation, no separate ``team_message`` needed.
* A task that becomes **completed** wakes the lead with the recorded result,
  and any tasks it just unblocked fire their own ready events (carrying the
  completed dependencies' results as the handoff payload).

Events are derived as a pure before/after diff of the todo store around each
team-bound ``todo_manage`` call (:func:`derive_board_events`), so a batch of
actions nets out to its final transitions.  Delivery reuses the existing
mailbox activation path (:func:`dispatch_board_events`) with system-authored
messages; the actor of the mutation is never notified of their own change.
"""

from __future__ import annotations

from dataclasses import dataclass
from types import SimpleNamespace
from typing import TYPE_CHECKING, Annotated, Any, Literal

from loguru import logger
from pydantic import Field

from app.agent.tools.registry import InjectedArg, Tool

if TYPE_CHECKING:
    from app.agent.mode.team.team import AgentTeam


# ---------------------------------------------------------------------------
# Events
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class TaskReady:
    """A task became actionable for its assignee."""

    task_id: str
    assignee: str
    content: str
    instructions: str | None
    # (task_id, content, result) for each completed dependency — the handoff
    # payload from upstream work.
    dependency_results: tuple[tuple[str, str, str | None], ...]


@dataclass(frozen=True)
class TaskCompleted:
    """A task transitioned to completed."""

    task_id: str
    content: str
    result: str | None
    completed_by: str | None


BoardEvent = TaskReady | TaskCompleted


# ---------------------------------------------------------------------------
# Derivation — pure before/after diff
# ---------------------------------------------------------------------------


def _items_by_id(store: dict) -> dict[str, dict]:
    return {
        item["task_id"]: item
        for item in store.get("items", [])
        if isinstance(item, dict) and isinstance(item.get("task_id"), str)
    }


def _completed_ids(items: dict[str, dict]) -> set[str]:
    return {tid for tid, item in items.items() if item.get("status") == "completed"}


def _is_ready(item: dict, completed: set[str]) -> bool:
    """Actionable now: assigned, pending, unclaimed, no open dependencies."""
    return (
        item.get("status") == "pending"
        and item.get("assigned_to") is not None
        and item.get("claimed_by") is None
        and all(dep in completed for dep in item.get("dependencies") or [])
    )


def derive_board_events(before: dict, after: dict) -> list[BoardEvent]:
    """Diff two store snapshots into transition-edge events.

    Edges only: a task already ready in *before* (for the same assignee) or
    already completed does not re-fire.  Tasks deleted in *after* produce no
    events.
    """
    before_items = _items_by_id(before)
    after_items = _items_by_id(after)
    before_completed = _completed_ids(before_items)
    after_completed = _completed_ids(after_items)

    events: list[BoardEvent] = []

    for task_id, item in after_items.items():
        prev = before_items.get(task_id)

        # Completed edge.
        if item.get("status") == "completed" and (
            prev is None or prev.get("status") != "completed"
        ):
            events.append(
                TaskCompleted(
                    task_id=task_id,
                    content=str(item.get("content") or ""),
                    result=item.get("result"),
                    completed_by=item.get("claimed_by") or item.get("assigned_to"),
                )
            )
            continue

        # Ready edge: ready now, and was not ready for this assignee before.
        if _is_ready(item, after_completed):
            was_ready = (
                prev is not None
                and _is_ready(prev, before_completed)
                and prev.get("assigned_to") == item.get("assigned_to")
            )
            if not was_ready:
                dependency_results = tuple(
                    (
                        dep,
                        str(after_items[dep].get("content") or ""),
                        after_items[dep].get("result"),
                    )
                    for dep in item.get("dependencies") or []
                    if dep in after_items
                )
                events.append(
                    TaskReady(
                        task_id=task_id,
                        assignee=str(item["assigned_to"]),
                        content=str(item.get("content") or ""),
                        instructions=item.get("instructions"),
                        dependency_results=dependency_results,
                    )
                )

    return events


def resumable_tasks(store: dict, actor: str) -> list[dict]:
    """Open tasks *actor* should be woken for after a restart/session restore.

    Claimed in-progress work (crashed mid-task) and assigned, unclaimed,
    unblocked tasks (the assignment wake died with the in-memory mailbox).
    Order follows the store.
    """
    items = _items_by_id(store)
    completed = _completed_ids(items)
    out: list[dict] = []
    for item in items.values():
        status = item.get("status")
        if status == "in_progress" and item.get("claimed_by") == actor:
            out.append(item)
        elif (
            status == "pending"
            and item.get("assigned_to") == actor
            and item.get("claimed_by") is None
            and all(dep in completed for dep in item.get("dependencies") or [])
        ):
            out.append(item)
    return out


# ---------------------------------------------------------------------------
# Message formatting
# ---------------------------------------------------------------------------


def _format_ready_message(event: TaskReady) -> str:
    lines = [
        f"[system]: {event.task_id} is ready for you: {event.content}",
    ]
    if event.instructions:
        lines.append(f"Instructions: {event.instructions}")
    for dep_id, dep_content, dep_result in event.dependency_results:
        if dep_result:
            lines.append(f"Completed dependency {dep_id} ({dep_content}): {dep_result}")
    lines.append(
        "Claim it with todo_manage before starting; record the outcome in "
        "`result` when you complete it."
    )
    return "\n".join(lines)


def format_resume_message(tasks: list[dict]) -> str:
    """Build the wake-up prompt for a member with resumable tasks."""
    lines = [
        "[system]: The session was restored. You have open task(s) on the board:",
    ]
    for item in tasks:
        task_id = item.get("task_id", "unknown")
        status = item.get("status", "unknown")
        lines.append(f"- {task_id} ({status}): {item.get('content', '')}")
        if item.get("instructions"):
            lines.append(f"  Instructions: {item['instructions']}")
    lines.append(
        "Claim or resume them with todo_manage; record the outcome in `result` "
        "when you complete each one."
    )
    return "\n".join(lines)


def _format_completed_message(event: TaskCompleted) -> str:
    who = event.completed_by or "unknown"
    lines = [f"[system]: {who} completed {event.task_id}: {event.content}"]
    if event.result:
        lines.append(f"Result: {event.result}")
    else:
        lines.append("No result was recorded on the task.")
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Dispatch — events → mailbox
# ---------------------------------------------------------------------------


async def dispatch_board_events(
    team: "AgentTeam",
    events: list[BoardEvent],
    *,
    actor: str,
) -> None:
    """Deliver *events* as system-authored mailbox messages.

    The actor of the mutation is never notified of their own change, and
    events targeting non-live handles are skipped (the mutation's tool
    result already shows the board state to the actor).
    """
    from app.agent.mode.team.mailbox import Message

    for event in events:
        if isinstance(event, TaskReady):
            target = event.assignee
            content = _format_ready_message(event)
        else:
            target = team.lead.name
            content = _format_completed_message(event)

        if target == actor:
            continue
        if target not in team.mailbox.registered_agents:
            logger.info(
                "board_event_skipped_not_live event={} target={}",
                type(event).__name__,
                target,
            )
            continue

        logger.info(
            "board_event_dispatched event={} task_id={} target={} actor={}",
            type(event).__name__,
            event.task_id,
            target,
            actor,
        )
        await team.mailbox.send(
            to=target,
            message=Message(from_agent="system", to_agent=target, content=content),
        )


# ---------------------------------------------------------------------------
# Team-bound tool
# ---------------------------------------------------------------------------


def make_team_todo_tool(
    team: "AgentTeam",
    *,
    agent_name: str,
    role: Literal["lead", "member"],
) -> Tool:
    """Return a ``todo_manage`` tool that dispatches board events after applying.

    Same schema and result as the plain builtin; the only addition is the
    before/after diff + mailbox dispatch.  The actor is bound at creation
    (the tool is built per-agent by ``AgentTeam.get_injected_tools``), so the
    LLM cannot spoof it.
    """
    from app.agent.tools.builtin.todo import (
        _DESCRIPTION,
        _MEMBER_DESCRIPTION,
        _apply_actions,
        _load_store,
        _normalize_store,
        TodoArgs,
        TodoMemberArgs,
    )

    class TeamTodoMemberArgs(TodoMemberArgs):
        """Member variant — adds the structured turn-end signal."""

        end_turn: bool = Field(
            default=False,
            description=(
                "Set true when this board update is your last action for the "
                "turn (e.g. final task completed with its result recorded): "
                "the turn ends after this call with no further model call. "
                "Leave false when you will keep working (e.g. claiming the "
                "next task in the same batch)."
            ),
        )

    actor_state = SimpleNamespace(metadata={"agent_name": agent_name})

    async def todo_manage(
        actions: list,
        end_turn: bool = False,
        _state: Annotated[Any, InjectedArg()] = None,
    ) -> str:
        before = _normalize_store(_load_store())
        result = await _apply_actions(actions, _state=actor_state, role=role)
        after = _normalize_store(_load_store())
        try:
            events = derive_board_events(before, after)
            if events:
                await dispatch_board_events(team, events, actor=agent_name)
        except Exception as exc:
            # The mutation itself succeeded — never fail the tool call over
            # a wake-up delivery problem.
            logger.warning(
                "board_event_dispatch_failed actor={} error={}", agent_name, exc
            )
        if end_turn and role == "member" and _state is not None:
            _state.metadata["end_turn"] = True
        return result

    return Tool(
        todo_manage,
        name="todo_manage",
        description=_DESCRIPTION if role == "lead" else _MEMBER_DESCRIPTION,
        args_schema=TodoArgs if role == "lead" else TeamTodoMemberArgs,
    )
