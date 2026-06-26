"""todo_manage — structured task list for the agent.

Accepts a list of actions executed in order in a single call:

* ``create`` — add a new item; returns an auto-generated ``task_id`` (``task_1``, ``task_2``, …).
* ``update`` — mutate an existing item by ``task_id``.
* ``delete`` — remove an item by ``task_id``.
* ``read``   — return the full list with ``task_id``s (useful as the sole action).

Storage
-------
Items are written to the current sandbox metadata directory:

.. code-block:: json

    {
        "counter": 3,
        "items": [
            {"task_id": "task_1", "content": "…", "status": "completed", "priority": "high", "dependencies": [], "assigned_to": "member#1", "claimed_by": "member#1"},
            {"task_id": "task_2", "content": "…", "status": "pending", "priority": "medium", "dependencies": ["task_1"], "assigned_to": "member#2", "claimed_by": null}
        ]
    }

``counter`` is monotonically increasing; new items get ``task_{counter + 1}``
and the counter is incremented atomically with the write.

Within a turn the store is also cached in ``state.metadata["_todos"]`` to
avoid redundant disk reads.
"""

from __future__ import annotations

import json
from collections.abc import Sequence
from pathlib import Path
from typing import Annotated, Any, Literal

from loguru import logger
from pydantic import BaseModel, Field, field_validator

from app.agent.artifacts import TODOS_FILENAME, todos_path
from app.agent.tools.registry import InjectedArg, Tool

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# Action models (discriminated union on "action")
# ---------------------------------------------------------------------------


class CreateAction(BaseModel):
    action: Literal["create"]
    content: str = Field(description="Brief description of the task.")
    status: Literal["pending", "in_progress", "completed", "cancelled"] = Field(
        description="Initial status.",
    )
    priority: Literal["high", "medium", "low"] = Field(
        description="Priority level.",
    )
    dependencies: list[str] = Field(
        default_factory=list,
        description="Task IDs that must be completed before this task can start.",
    )
    assigned_to: str | None = Field(
        default=None,
        pattern=r"^[^#,/\s]+#\d+$",
        description="Agent handle assigned to this task, if any.",
    )

    @field_validator("content")
    @classmethod
    def _not_blank(cls, v: str) -> str:
        if not v.strip():
            raise ValueError("content must not be blank")
        return v

    @field_validator("dependencies")
    @classmethod
    def _no_duplicates(cls, v: list[str]) -> list[str]:
        return list(dict.fromkeys(v))


class UpdateAction(BaseModel):
    action: Literal["update"]
    task_id: str = Field(description="ID of the task to update (e.g. task_1).")
    content: str | None = Field(
        default=None, description="New description (omit to keep unchanged)."
    )
    status: Literal["pending", "in_progress", "completed", "cancelled"] | None = Field(
        default=None, description="New status (omit to keep unchanged)."
    )
    priority: Literal["high", "medium", "low"] | None = Field(
        default=None, description="New priority (omit to keep unchanged)."
    )
    dependencies: list[str] | None = Field(
        default=None,
        description="Replacement list of task IDs that must be completed first.",
    )
    assigned_to: str | None = Field(
        default=None,
        pattern=r"^[^#,/\s]+#\d+$",
        description="Replacement agent handle assigned to this task.",
    )

    @field_validator("content")
    @classmethod
    def _not_blank(cls, v: str | None) -> str | None:
        if v is not None and not v.strip():
            raise ValueError("content must not be blank")
        return v

    @field_validator("dependencies")
    @classmethod
    def _no_duplicates(cls, v: list[str] | None) -> list[str] | None:
        if v is None:
            return None
        return list(dict.fromkeys(v))


class MemberUpdateAction(BaseModel):
    action: Literal["update"]
    task_id: str = Field(description="ID of the claimed task to update.")
    content: str | None = Field(
        default=None, description="New description (omit to keep unchanged)."
    )
    status: Literal["pending", "in_progress", "completed", "cancelled"] | None = Field(
        default=None, description="New status (omit to keep unchanged)."
    )

    @field_validator("content")
    @classmethod
    def _not_blank(cls, v: str | None) -> str | None:
        if v is not None and not v.strip():
            raise ValueError("content must not be blank")
        return v


class ClaimAction(BaseModel):
    action: Literal["claim"]
    task_id: str = Field(description="ID of the task to claim (e.g. task_1).")


class DeleteAction(BaseModel):
    action: Literal["delete"]
    task_id: str = Field(description="ID of the task to remove (e.g. task_1).")


class ReadAction(BaseModel):
    action: Literal["read"]


AnyAction = Annotated[
    CreateAction | UpdateAction | DeleteAction | ReadAction,
    Field(discriminator="action"),
]

MemberAnyAction = Annotated[
    MemberUpdateAction | ClaimAction | ReadAction,
    Field(discriminator="action"),
]

ActionModel = (
    CreateAction
    | UpdateAction
    | MemberUpdateAction
    | ClaimAction
    | DeleteAction
    | ReadAction
)


class TodoArgs(BaseModel):
    """Arguments for the lead todo_manage tool."""

    actions: list[AnyAction] = Field(description="Ordered list of actions to execute.")


class TodoMemberArgs(BaseModel):
    """Arguments for the member todo_manage tool."""

    actions: list[MemberAnyAction] = Field(
        description="Ordered list of claim/read/update actions to execute."
    )


# ---------------------------------------------------------------------------
# Storage helpers
# ---------------------------------------------------------------------------


def _todos_path() -> Any:
    return todos_path()


def _load_store() -> dict:
    """Return ``{"counter": int, "items": list[dict]}``."""
    path = _todos_path()
    if not path.exists():
        return {"counter": 0, "items": []}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        if isinstance(data, dict) and "items" in data:
            return data
    except Exception:
        pass
    return {"counter": 0, "items": []}


def _save_store(store: dict) -> None:
    path = _todos_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(store, indent=2, ensure_ascii=False), encoding="utf-8")


def release_in_progress_for_actor(
    workspace_root: Path, actor: str, session_id: str | None = None
) -> list[str]:
    """Release an actor's unfinished todos for reassignment."""
    path = (
        todos_path(session_id)
        if session_id
        else workspace_root / ".openagentd" / TODOS_FILENAME
    )
    if not path.exists():
        return []
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return []
    store = _normalize_store(data if isinstance(data, dict) else {})
    released: list[str] = []
    for item in store.get("items", []):
        if not isinstance(item, dict):
            continue
        if item.get("status") in {"completed", "cancelled"}:
            continue
        if item.get("claimed_by") != actor and item.get("assigned_to") != actor:
            continue
        if item.get("status") == "in_progress":
            item["status"] = "pending"
        item["claimed_by"] = None
        if item.get("assigned_to") == actor:
            item["assigned_to"] = None
        if isinstance(item.get("task_id"), str):
            released.append(item["task_id"])
    if released:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(
            json.dumps(store, indent=2, ensure_ascii=False), encoding="utf-8"
        )
    return released


def open_assigned_todos_for_actor(session_id: str, actor: str) -> list[dict]:
    """Return unfinished todos assigned to or claimed by *actor* for *session_id*."""
    path = todos_path(session_id)
    if not path.exists():
        return []
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return []
    store = _normalize_store(data if isinstance(data, dict) else {})
    todos: list[dict] = []
    for item in store.get("items", []):
        if not isinstance(item, dict):
            continue
        if item.get("status") in {"completed", "cancelled"}:
            continue
        if item.get("assigned_to") == actor or item.get("claimed_by") == actor:
            todos.append(dict(item))
    return todos


def _format_items(items: list[dict]) -> str:
    if not items:
        return "No todos."
    lines: list[str] = []
    for item in items:
        dependencies = item.get("dependencies") or []
        dependency_text = f" deps=[{', '.join(dependencies)}]" if dependencies else ""
        assigned_to = item.get("assigned_to")
        assignee_text = f" assigned={assigned_to}" if assigned_to else ""
        claimed_by = item.get("claimed_by")
        claim_text = f" claimed={claimed_by}" if claimed_by else ""
        lines.append(
            f"[{item['task_id']}] [{item['status']}] ({item['priority']}){dependency_text}{assignee_text}{claim_text} {item['content']}"
        )
    return "\n".join(lines)


def _normalize_store(store: dict) -> dict:
    """Ensure persisted todo items have the current shape."""
    for item in store.get("items", []):
        if isinstance(item, dict):
            dependencies = item.get("dependencies", [])
            item["dependencies"] = (
                dependencies if isinstance(dependencies, list) else []
            )
            item.setdefault("assigned_to", None)
            item.setdefault("claimed_by", None)
    return store


def _actor_name(state: Any) -> str | None:
    if state is None:
        return None
    agent_name = state.metadata.get("agent_name")
    return agent_name if isinstance(agent_name, str) else None


def _task_ids(store: dict) -> set[str]:
    return {
        item["task_id"]
        for item in store.get("items", [])
        if isinstance(item, dict) and isinstance(item.get("task_id"), str)
    }


def _completed_task_ids(store: dict) -> set[str]:
    return {
        item["task_id"]
        for item in store.get("items", [])
        if isinstance(item, dict)
        and isinstance(item.get("task_id"), str)
        and item.get("status") == "completed"
    }


def _valid_dependencies(
    store: dict,
    task_id: str,
    dependencies: list[str],
) -> tuple[bool, str | None]:
    known = _task_ids(store)
    unknown = [dep for dep in dependencies if dep not in known]
    if unknown:
        return False, f"unknown dependencies for {task_id}: {', '.join(unknown)}"
    if task_id in dependencies:
        return False, f"self dependency for {task_id}"
    return True, None


def _blocked_dependencies(store: dict, dependencies: list[str]) -> list[str]:
    completed = _completed_task_ids(store)
    return [dep for dep in dependencies if dep not in completed]


def _find_item(store: dict, task_id: str) -> dict | None:
    for item in store.get("items", []):
        if isinstance(item, dict) and item.get("task_id") == task_id:
            return item
    return None


# ---------------------------------------------------------------------------
# Tool
# ---------------------------------------------------------------------------

_DESCRIPTION = """\
Manage the structured task list as the lead. Pass one or more actions in a single call;
they are executed in order.

Actions
-------
create  — Add a new task (returns the assigned task_id).
update  — Update an existing task by task_id (change any combination of
          content, status, priority, dependencies, assigned_to).
delete  — Remove a task permanently by task_id.
read    — Return the full task list with task_ids.

Rules
-----
- Batch related changes into a single call (e.g. complete the current task
  and start the next one together).
- Assign member work with assigned_to and model ordering with dependencies.
- Only ONE task per agent should be in_progress at a time.
- Mark tasks completed immediately when done; do not batch updates across turns.
- Use dependencies=["task_1"] for dependent work. A task with incomplete
  dependencies cannot be moved to in_progress; keep it pending until
  prerequisites are complete.
- Use status=cancelled for tasks that are no longer needed instead of deleting.
- Skip this tool for single, trivial tasks.\
"""

_MEMBER_DESCRIPTION = """\
Claim and update your assigned tasks. Pass one or more actions in a single call;
they are executed in order.

Actions
-------
claim   — Claim an assigned, unblocked task and move it to in_progress.
update  — Update a task you claimed (content and/or status only).
read    — Return the full task list with task_ids.

Rules
-----
- Claim a task before starting work.
- If claim reports blocked dependencies, do not start; respond `<sleep>` and wait.
- Only update tasks assigned to or claimed by you.
- Mark your task completed immediately when done.\
"""


def _can_member_update(item: dict, actor: str | None) -> bool:
    if actor is None:
        return False
    return item.get("claimed_by") == actor or item.get("assigned_to") == actor


def _assignee_matches_actor(assigned_to: Any, actor: str | None) -> bool:
    if not isinstance(assigned_to, str) or actor is None:
        return False
    return assigned_to == actor


async def _todo_manage(
    actions: list[AnyAction],
    _state: Annotated[Any, InjectedArg()] = None,
) -> str:
    return await _apply_actions(actions, _state=_state, role="lead")


async def _todo_manage_member(
    actions: list[MemberAnyAction],
    _state: Annotated[Any, InjectedArg()] = None,
) -> str:
    return await _apply_actions(actions, _state=_state, role="member")


async def _apply_actions(
    actions: Sequence[ActionModel],
    *,
    _state: Any,
    role: Literal["lead", "member"],
) -> str:
    store = _normalize_store(_load_store())
    if _state is not None and "_todos" in _state.metadata:
        store = _normalize_store(_state.metadata["_todos"])
    actor = _actor_name(_state)

    log_parts: list[str] = []

    for act in actions:
        if isinstance(act, ReadAction):
            # read is a no-op on the store — result is returned at the end
            pass

        elif isinstance(act, CreateAction):
            new_id = f"task_{store['counter'] + 1}"
            dependencies = list(dict.fromkeys(act.dependencies))
            valid, error = _valid_dependencies(store, new_id, dependencies)
            if not valid:
                log_parts.append(f"invalid_dependencies {new_id}: {error}")
                continue
            status = act.status
            if status == "in_progress":
                blocked = _blocked_dependencies(store, dependencies)
                if blocked:
                    status = "pending"
                    log_parts.append(
                        f"blocked {new_id}: waiting for {', '.join(blocked)}"
                    )
                elif act.assigned_to is not None and not _assignee_matches_actor(
                    act.assigned_to, actor
                ):
                    status = "pending"
                    log_parts.append(
                        f"not_assigned {new_id}: assigned to {act.assigned_to}"
                    )
            store["counter"] += 1
            store["items"].append(
                {
                    "task_id": new_id,
                    "content": act.content,
                    "status": status,
                    "priority": act.priority,
                    "dependencies": dependencies,
                    "assigned_to": act.assigned_to,
                    "claimed_by": actor if status == "in_progress" else None,
                }
            )
            log_parts.append(f"created {new_id}")

        elif isinstance(act, UpdateAction | MemberUpdateAction):
            for item in store["items"]:
                if item["task_id"] == act.task_id:
                    if role == "member" and not _can_member_update(item, actor):
                        log_parts.append(f"not_claimed {act.task_id}")
                        break
                    dependencies = item.get("dependencies", [])
                    if isinstance(act, UpdateAction) and act.dependencies is not None:
                        dependencies = list(dict.fromkeys(act.dependencies))
                        valid, error = _valid_dependencies(
                            store, act.task_id, dependencies
                        )
                        if not valid:
                            log_parts.append(
                                f"invalid_dependencies {act.task_id}: {error}"
                            )
                            break
                        item["dependencies"] = dependencies
                    if isinstance(act, UpdateAction) and act.assigned_to is not None:
                        item["assigned_to"] = act.assigned_to
                    if act.content is not None:
                        item["content"] = act.content
                    if act.status is not None:
                        if act.status == "in_progress":
                            blocked = _blocked_dependencies(store, dependencies)
                            if blocked:
                                log_parts.append(
                                    f"blocked {act.task_id}: waiting for {', '.join(blocked)}"
                                )
                            elif item.get(
                                "assigned_to"
                            ) is not None and not _assignee_matches_actor(
                                item.get("assigned_to"), actor
                            ):
                                log_parts.append(
                                    f"not_assigned {act.task_id}: assigned to {item.get('assigned_to')}"
                                )
                            else:
                                item["status"] = act.status
                                item["claimed_by"] = item.get("claimed_by") or actor
                        else:
                            item["status"] = act.status
                    if isinstance(act, UpdateAction) and act.priority is not None:
                        item["priority"] = act.priority
                    log_parts.append(f"updated {act.task_id}")
                    break
            else:
                log_parts.append(f"not_found {act.task_id}")

        elif isinstance(act, ClaimAction):
            item = _find_item(store, act.task_id)
            if item is None:
                log_parts.append(f"not_found {act.task_id}")
                continue
            if actor is None:
                log_parts.append(f"claim_missing_actor {act.task_id}")
                continue
            assigned_to = item.get("assigned_to")
            if assigned_to is not None and not _assignee_matches_actor(
                assigned_to, actor
            ):
                log_parts.append(
                    f"not_assigned {act.task_id}: assigned to {assigned_to}"
                )
                continue
            claimed_by = item.get("claimed_by")
            if claimed_by is not None and claimed_by != actor:
                log_parts.append(
                    f"already_claimed {act.task_id}: claimed by {claimed_by}"
                )
                continue
            in_progress = [
                other["task_id"]
                for other in store.get("items", [])
                if isinstance(other, dict)
                and other.get("task_id") != act.task_id
                and other.get("claimed_by") == actor
                and other.get("status") == "in_progress"
            ]
            if in_progress:
                log_parts.append(
                    f"claim_busy {act.task_id}: finish {', '.join(in_progress)} first"
                )
                continue
            blocked = _blocked_dependencies(store, item.get("dependencies", []))
            if blocked:
                log_parts.append(
                    f"blocked {act.task_id}: waiting for {', '.join(blocked)}"
                )
                continue
            item["claimed_by"] = actor
            item["status"] = "in_progress"
            log_parts.append(f"claimed {act.task_id}")

        elif isinstance(act, DeleteAction):
            before = len(store["items"])
            store["items"] = [i for i in store["items"] if i["task_id"] != act.task_id]
            if len(store["items"]) < before:
                log_parts.append(f"deleted {act.task_id}")
            else:
                log_parts.append(f"not_found {act.task_id}")

    _save_store(store)
    if _state is not None:
        _state.metadata["_todos"] = store

    logger.info(
        "todo_manage actions=[{}]", ", ".join(log_parts) if log_parts else "read"
    )
    return _format_items(store["items"])


todo_manage = Tool(
    _todo_manage,
    name="todo_manage",
    description=_DESCRIPTION,
    args_schema=TodoArgs,
)


todo_manage_member = Tool(
    _todo_manage_member,
    name="todo_manage",
    description=_MEMBER_DESCRIPTION,
    args_schema=TodoMemberArgs,
)


def make_todo_manage_tool(role: Literal["lead", "member"]) -> Tool:
    return todo_manage if role == "lead" else todo_manage_member
