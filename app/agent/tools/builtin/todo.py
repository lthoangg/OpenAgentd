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

The store is shared across concurrently running agents (lead + members), so
every call re-reads the file; there is deliberately no per-run cache.
"""

from __future__ import annotations

import json
from collections.abc import Sequence
from typing import Annotated, Any, Literal

from loguru import logger
from pydantic import BaseModel, Field, field_validator

from app.agent.artifacts import TODOS_FILENAME as TODOS_FILENAME  # re-exported
from app.agent.artifacts import todos_path
from app.agent.tools.registry import InjectedArg, Tool

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# Action models (discriminated union on "action")
# ---------------------------------------------------------------------------


from pydantic import model_validator


class TodoAction(BaseModel):
    """A single task action for the lead task board."""

    action: Literal["create", "update", "delete", "read", "clear"] = Field(
        description="Action to perform: create, update, delete, read, or clear."
    )
    task_id: str | None = Field(
        default=None,
        description="ID of the task to update or delete (e.g. 'task_1').",
    )
    content: str | None = Field(
        default=None,
        description="Task description (required for create; omit on update to leave unchanged).",
    )
    status: (
        Literal["pending", "in_progress", "completed", "cancelled", "finished"] | None
    ) = Field(
        default=None,
        description="Status for create/update ('pending', 'in_progress', 'completed', 'cancelled') or filter for clear ('finished', 'completed', 'cancelled').",
    )
    priority: Literal["high", "medium", "low"] | None = Field(
        default=None,
        description="Priority level ('high', 'medium', 'low'; defaults to 'medium' on create).",
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
    instructions: str | None = Field(
        default=None,
        description=(
            "Delegation brief for the assignee: goal, constraints, and how to "
            "verify. The assignee reads this when picking up the task."
        ),
    )
    result: str | None = Field(
        default=None,
        description="Outcome/deliverable summary, set when completing the task.",
    )

    @field_validator("action", mode="before")
    @classmethod
    def _normalize_action(cls, v: Any) -> Any:
        if isinstance(v, str):
            v_lower = v.strip().lower()
            if v_lower in ("add", "insert", "new"):
                return "create"
            if v_lower in ("remove", "rm", "del"):
                return "delete"
            if v_lower in ("list", "get", "view", "show"):
                return "read"
            return v_lower
        return v

    @field_validator("content")
    @classmethod
    def _not_blank(cls, v: str | None) -> str | None:
        if v is not None and not v.strip():
            raise ValueError("content must not be blank")
        return v

    @field_validator("dependencies", mode="before")
    @classmethod
    def _coerce_dependencies(cls, v: Any) -> list[str]:
        if v is None:
            return []
        if isinstance(v, str):
            v = [item.strip() for item in v.split(",") if item.strip()]
        if isinstance(v, (list, tuple, set)):
            return list(dict.fromkeys(str(x) for x in v))
        return [str(v)]

    @model_validator(mode="after")
    def _validate_action(self) -> TodoAction:
        if self.action == "create":
            if not self.content:
                raise ValueError("content is required for create action")
            if self.status is None:
                self.status = "pending"
            elif self.status == "finished":
                raise ValueError("status 'finished' is only valid for clear action")
            if self.priority is None:
                self.priority = "medium"
        elif self.action in ("update", "delete"):
            if not self.task_id:
                raise ValueError(f"task_id is required for {self.action} action")
            if self.action == "update" and self.status == "finished":
                raise ValueError("status 'finished' is only valid for clear action")
        elif self.action == "clear":
            if self.status is None:
                self.status = "finished"
            elif self.status not in ("completed", "cancelled", "finished"):
                raise ValueError(
                    "status for clear must be 'completed', 'cancelled', or 'finished'"
                )
        return self


class MemberTodoAction(BaseModel):
    """A single task action for member agents."""

    action: Literal["claim", "update", "read"] = Field(
        description="Action to perform: claim, update, or read."
    )
    task_id: str | None = Field(
        default=None,
        description="ID of the claimed task to update or claim (e.g. 'task_1').",
    )
    content: str | None = Field(
        default=None,
        description="Task description (omit to leave unchanged).",
    )
    status: Literal["pending", "in_progress", "completed", "cancelled"] | None = Field(
        default=None,
        description="New status.",
    )
    result: str | None = Field(
        default=None,
        description=(
            "Outcome/deliverable summary, set when completing the task: what "
            "was done, where, and how it was verified."
        ),
    )

    @field_validator("action", mode="before")
    @classmethod
    def _normalize_action(cls, v: Any) -> Any:
        if isinstance(v, str):
            v_lower = v.strip().lower()
            if v_lower in ("list", "get", "view", "show"):
                return "read"
            return v_lower
        return v

    @field_validator("content")
    @classmethod
    def _not_blank(cls, v: str | None) -> str | None:
        if v is not None and not v.strip():
            raise ValueError("content must not be blank")
        return v

    @model_validator(mode="after")
    def _validate_action(self) -> MemberTodoAction:
        if self.action in ("claim", "update") and not self.task_id:
            raise ValueError(f"task_id is required for {self.action} action")
        return self


class CreateAction(TodoAction):
    action: Literal["create"] = "create"
    content: str = Field(description="Brief description of the task.")
    status: Literal["pending", "in_progress", "completed", "cancelled"] = Field(
        default="pending",
        description="Initial status.",
    )
    priority: Literal["high", "medium", "low"] = Field(
        default="medium",
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
    instructions: str | None = Field(
        default=None,
        description=(
            "Delegation brief for the assignee: goal, constraints, and how to "
            "verify. The assignee reads this when picking up the task."
        ),
    )


class UpdateAction(TodoAction):
    action: Literal["update"] = "update"
    task_id: str = Field(description="ID of the task to update (e.g. task_1).")


class MemberUpdateAction(MemberTodoAction):
    action: Literal["update"] = "update"
    task_id: str = Field(description="ID of the claimed task to update.")


class ClaimAction(MemberTodoAction):
    action: Literal["claim"] = "claim"
    task_id: str = Field(description="ID of the task to claim (e.g. task_1).")


class DeleteAction(TodoAction):
    action: Literal["delete"] = "delete"
    task_id: str = Field(description="ID of the task to remove (e.g. task_1).")


class ReadAction(TodoAction):
    action: Literal["read"] = "read"


class ClearAction(TodoAction):
    action: Literal["clear"] = "clear"
    status: Literal["completed", "cancelled", "finished"] = Field(
        default="finished",
        description=(
            "Which tasks to remove: 'completed', 'cancelled', or 'finished' "
            "(both completed and cancelled — the default). Active tasks "
            "(pending / in_progress) are always kept."
        ),
    )


AnyAction = TodoAction
MemberAnyAction = MemberTodoAction

ActionModel = (
    TodoAction
    | MemberTodoAction
    | CreateAction
    | UpdateAction
    | MemberUpdateAction
    | ClaimAction
    | DeleteAction
    | ReadAction
    | ClearAction
)

_LEAD_ACTION_CLS_MAP = {
    "create": CreateAction,
    "update": UpdateAction,
    "delete": DeleteAction,
    "read": ReadAction,
    "clear": ClearAction,
}

_MEMBER_ACTION_CLS_MAP = {
    "claim": ClaimAction,
    "update": MemberUpdateAction,
    "read": MemberTodoAction,
}


def _coerce_actions(value: Any, role: Literal["lead", "member"] = "lead") -> Any:
    """Accept ``actions`` the way real models actually emit it.

    Some providers stringify nested-array arguments, sending ``actions`` as a
    JSON string (``'[{"action": "read"}]'``) instead of a real list, which
    Pydantic's ``list[...]`` then rejects with a confusing ``list_type`` error.
    Others send a single action object instead of a one-element list. Normalise
    both here (``mode="before"``) so the tool is forgiving of these common
    shapes rather than failing the whole call — this is the agent's own task
    list, robustness matters more than strictness.
    """
    if isinstance(value, str):
        text = value.strip()
        if not text:
            return value
        try:
            value = json.loads(text)
        except (json.JSONDecodeError, ValueError):
            return value
    # A single action object → wrap as a one-element list.
    if isinstance(value, dict):
        value = [value]
    if isinstance(value, list):
        cls_map = _LEAD_ACTION_CLS_MAP if role == "lead" else _MEMBER_ACTION_CLS_MAP
        coerced: list[Any] = []
        for item in value:
            if isinstance(item, dict) and "action" in item:
                act_name = item.get("action")
                cls = cls_map.get(act_name)
                if cls is not None:
                    try:
                        coerced.append(cls.model_validate(item))
                        continue
                    except Exception:
                        pass
            coerced.append(item)
        return coerced
    return value


class TodoArgs(BaseModel):
    """Arguments for the lead todo_manage tool."""

    actions: list[TodoAction] = Field(description="Ordered list of actions to execute.")

    @model_validator(mode="before")
    @classmethod
    def _normalize_args(cls, values: Any) -> Any:
        if isinstance(values, dict) and "actions" not in values and "action" in values:
            return {"actions": [values]}
        return values

    @field_validator("actions", mode="before")
    @classmethod
    def _coerce(cls, value: Any) -> Any:
        return _coerce_actions(value, role="lead")


class TodoMemberArgs(BaseModel):
    """Arguments for the member todo_manage tool."""

    actions: list[MemberTodoAction] = Field(
        description="Ordered list of claim/read/update actions to execute."
    )

    @model_validator(mode="before")
    @classmethod
    def _normalize_args(cls, values: Any) -> Any:
        if isinstance(values, dict) and "actions" not in values and "action" in values:
            return {"actions": [values]}
        return values

    @field_validator("actions", mode="before")
    @classmethod
    def _coerce(cls, value: Any) -> Any:
        return _coerce_actions(value, role="member")


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
    except (OSError, ValueError) as exc:
        # Corrupt/unreadable store → start fresh rather than crash the tool.
        logger.warning("todo_store_unreadable path={} error={!r}", path, exc)
    return {"counter": 0, "items": []}


def _save_store(store: dict, *, path: Any | None = None) -> None:
    path = path if path is not None else _todos_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    # Atomic replace — a crash mid-write must never corrupt the store.
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(store, indent=2, ensure_ascii=False), encoding="utf-8")
    tmp.replace(path)


def release_in_progress_for_actor(
    actor: str, session_id: str | None = None
) -> list[str]:
    """Release an actor's unfinished todos for reassignment.

    Resolves the store through :func:`todos_path`, the same helper
    ``_load_store``/``_save_store`` use, so a release is always visible to the
    ``todo_manage`` tool. An earlier signature took a ``workspace_root`` and
    fell back to ``workspace_root/.openagentd/`` when *session_id* was absent —
    a location nothing ever reads, since session artifacts live under the XDG
    data dir. Both call sites always had a session id, so the branch was dead.
    """
    path = todos_path(session_id)
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
        # Reuse the atomic tmp-file + replace writer rather than a bare
        # write_text, so an interrupted release cannot truncate the store.
        _save_store(store, path=path)
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
        instructions = item.get("instructions")
        if instructions:
            lines.append(f"    instructions: {instructions}")
        result = item.get("result")
        if result:
            lines.append(f"    result: {result}")
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
            item.setdefault("instructions", None)
            item.setdefault("result", None)
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


def _consolidate_outcomes(log_parts: Sequence[str]) -> list[str]:
    """Group same-verb outcomes onto one line to keep the ack compact.

    ``["created task_1", "created task_2", "updated task_3"]`` becomes
    ``["created task_1, task_2", "updated task_3"]``. Entries carrying a
    reason (``"blocked task_2: waiting for task_1"``) stay verbatim so the
    explanation is not lost.
    """
    grouped: dict[str, list[str]] = {}
    # Each slot is either a verbatim line or the verb whose group renders here.
    slots: list[tuple[bool, str]] = []
    for part in log_parts:
        verb, _, subject = part.partition(" ")
        if not subject or ":" in part:
            slots.append((True, part))
            continue
        bucket = grouped.get(verb)
        if bucket is None:
            bucket = []
            grouped[verb] = bucket
            slots.append((False, verb))
        if subject not in bucket:
            bucket.append(subject)
    return [
        value if verbatim else f"{value} {', '.join(grouped[value])}"
        for verbatim, value in slots
    ]


def _find_item(store: dict, task_id: str) -> dict | None:
    for item in store.get("items", []):
        if isinstance(item, dict) and item.get("task_id") == task_id:
            return item
    return None


# ---------------------------------------------------------------------------
# Tool
# ---------------------------------------------------------------------------

_DESCRIPTION = """\
Manage the task board; actions execute in order. Batch related changes and add
read when you need the resulting board. Clear finished tasks before unrelated
work; active tasks are kept. Skip this tool for a single trivial task.

Delegate with assigned_to plus instructions; an assigned, unblocked task wakes
its assignee automatically without a kickoff message. Assigned tasks stay
pending until claimed. Keep one in_progress task per agent, complete tasks
immediately, use dependencies for prerequisites, and cancel work that is no
longer needed instead of deleting it.\
"""

_MEMBER_DESCRIPTION = """\
Claim before starting an assigned task; blocked claims wake automatically when
ready. Update only your assigned or claimed tasks. On completion, record the
outcome in `result`—what changed, where, and verification—so the lead and
unblocked teammates are notified automatically. Add read when you need the full
board.\
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
    # Always re-read from disk: the store is shared across concurrently
    # running agents (lead + members), so a per-run cached snapshot would
    # clobber other agents' writes on save (e.g. silently reverting a claim).
    # Load-mutate-save below is atomic within the event loop (no awaits).
    store = _normalize_store(_load_store())
    actor = _actor_name(_state)

    log_parts: list[str] = []
    # Successful claims echo the claimed task line + its delegation brief —
    # the claimer did not author the task, so this is new information.
    claimed_ids: list[str] = []

    cls_map = _LEAD_ACTION_CLS_MAP if role == "lead" else _MEMBER_ACTION_CLS_MAP
    normalized_actions: list[Any] = []
    for item in actions:
        if isinstance(item, dict):
            act_name = item.get("action")
            cls = cls_map.get(
                act_name, TodoAction if role == "lead" else MemberTodoAction
            )
            try:
                normalized_actions.append(cls.model_validate(item))
                continue
            except Exception:
                pass
        normalized_actions.append(item)

    for act in normalized_actions:
        act_type = getattr(act, "action", None)
        if act_type == "read" or isinstance(act, ReadAction):
            # read is a no-op on the store — result is returned at the end
            pass

        elif (act_type == "create" or isinstance(act, CreateAction)) and isinstance(
            act, TodoAction
        ):
            if not act.content:
                continue
            new_id = f"task_{store['counter'] + 1}"
            dependencies = list(dict.fromkeys(act.dependencies or []))
            valid, error = _valid_dependencies(store, new_id, dependencies)
            if not valid:
                log_parts.append(f"invalid_dependencies {new_id}: {error}")
                continue
            status = act.status or "pending"
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
                    "priority": act.priority or "medium",
                    "dependencies": dependencies,
                    "assigned_to": act.assigned_to,
                    "claimed_by": actor if status == "in_progress" else None,
                    "instructions": act.instructions,
                    "result": None,
                }
            )
            log_parts.append(f"created {new_id}")

        elif act_type == "update" or isinstance(act, UpdateAction | MemberUpdateAction):
            task_id = act.task_id
            if not task_id:
                continue
            for item in store["items"]:
                if item["task_id"] == task_id:
                    if role == "member" and not _can_member_update(item, actor):
                        log_parts.append(f"not_claimed {task_id}")
                        break
                    dependencies = item.get("dependencies", [])
                    act_deps = getattr(act, "dependencies", None)
                    if act_deps is not None and act_deps != dependencies:
                        dependencies = list(dict.fromkeys(act_deps))
                        valid, error = _valid_dependencies(store, task_id, dependencies)
                        if not valid:
                            log_parts.append(f"invalid_dependencies {task_id}: {error}")
                            break
                        item["dependencies"] = dependencies
                    act_assigned_to = getattr(act, "assigned_to", None)
                    if act_assigned_to is not None:
                        item["assigned_to"] = act_assigned_to
                    act_instructions = getattr(act, "instructions", None)
                    if act_instructions is not None:
                        item["instructions"] = act_instructions
                    if act.result is not None:
                        item["result"] = act.result
                    if act.content is not None:
                        item["content"] = act.content
                    if act.status is not None:
                        if act.status == "in_progress":
                            blocked = _blocked_dependencies(store, dependencies)
                            if blocked:
                                log_parts.append(
                                    f"blocked {task_id}: waiting for {', '.join(blocked)}"
                                )
                            elif item.get(
                                "assigned_to"
                            ) is not None and not _assignee_matches_actor(
                                item.get("assigned_to"), actor
                            ):
                                log_parts.append(
                                    f"not_assigned {task_id}: assigned to {item.get('assigned_to')}"
                                )
                            else:
                                item["status"] = act.status
                                item["claimed_by"] = item.get("claimed_by") or actor
                        else:
                            item["status"] = act.status
                    act_priority = getattr(act, "priority", None)
                    if act_priority is not None:
                        item["priority"] = act_priority
                    log_parts.append(f"updated {task_id}")
                    break
            else:
                log_parts.append(f"not_found {task_id}")

        elif act_type == "claim" or isinstance(act, ClaimAction):
            task_id = act.task_id
            if not task_id:
                continue
            item = _find_item(store, task_id)
            if item is None:
                log_parts.append(f"not_found {task_id}")
                continue
            if actor is None:
                log_parts.append(f"claim_missing_actor {task_id}")
                continue
            assigned_to = item.get("assigned_to")
            if assigned_to is not None and not _assignee_matches_actor(
                assigned_to, actor
            ):
                log_parts.append(f"not_assigned {task_id}: assigned to {assigned_to}")
                continue
            claimed_by = item.get("claimed_by")
            if claimed_by is not None and claimed_by != actor:
                log_parts.append(f"already_claimed {task_id}: claimed by {claimed_by}")
                continue
            in_progress = [
                other["task_id"]
                for other in store.get("items", [])
                if isinstance(other, dict)
                and other.get("task_id") != task_id
                and other.get("claimed_by") == actor
                and other.get("status") == "in_progress"
            ]
            if in_progress:
                log_parts.append(
                    f"claim_busy {task_id}: finish {', '.join(in_progress)} first"
                )
                continue
            blocked = _blocked_dependencies(store, item.get("dependencies", []))
            if blocked:
                log_parts.append(f"blocked {task_id}: waiting for {', '.join(blocked)}")
                continue
            item["claimed_by"] = actor
            item["status"] = "in_progress"
            log_parts.append(f"claimed {task_id}")
            claimed_ids.append(task_id)

        elif act_type == "delete" or isinstance(act, DeleteAction):
            task_id = act.task_id
            if not task_id:
                continue
            before = len(store["items"])
            store["items"] = [i for i in store["items"] if i["task_id"] != task_id]
            if len(store["items"]) < before:
                log_parts.append(f"deleted {task_id}")
            else:
                log_parts.append(f"not_found {task_id}")

        elif act_type == "clear" or isinstance(act, ClearAction):
            clear_status = getattr(act, "status", None) or "finished"
            if clear_status == "finished":
                drop = {"completed", "cancelled"}
            else:
                drop = {clear_status}
            before = len(store["items"])
            store["items"] = [i for i in store["items"] if i.get("status") not in drop]
            removed = before - len(store["items"])
            log_parts.append(f"cleared {removed} {'/'.join(sorted(drop))}")

    _save_store(store)

    outcomes = _consolidate_outcomes(log_parts)

    logger.info("todo_manage actions=[{}]", "; ".join(outcomes) if outcomes else "read")

    # Mutation-only batches return a compact per-action ack: the agent
    # authored the change, so re-echoing the whole board (every other task's
    # full instructions/results) is token waste — and this surfaces
    # validation outcomes (blocked/not_found/…) that previously only reached
    # the log. An explicit `read` in the batch keeps the full listing.
    has_read = any(
        getattr(act, "action", None) == "read" or isinstance(act, ReadAction)
        for act in actions
    )
    if has_read or not actions:
        return _format_items(store["items"])

    lines = list(outcomes)
    if claimed_ids:
        claimed_items = [
            item for item in store["items"] if item.get("task_id") in claimed_ids
        ]
        if claimed_items:
            lines.append(_format_items(claimed_items))
    return "\n".join(lines) if lines else _format_items(store["items"])


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
