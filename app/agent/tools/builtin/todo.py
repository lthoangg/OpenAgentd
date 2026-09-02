"""todo_manage — structured task list for the single agent."""

from __future__ import annotations

import json
from collections.abc import Sequence
from typing import Annotated, Any, Literal

from loguru import logger
from pydantic import BaseModel, Field, field_validator, model_validator

from app.agent.artifacts import TODOS_FILENAME as TODOS_FILENAME  # re-exported
from app.agent.artifacts import todos_path
from app.agent.tools.registry import InjectedArg, Tool


class TodoAction(BaseModel):
    """A single task action for the task list."""

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

    @model_validator(mode="after")
    def _validate_action(self) -> TodoAction:
        if self.action == "create":
            if not self.content:
                raise ValueError("content is required for create action")
            if self.status is None:
                self.status = "pending"
            elif self.status == "finished":
                raise ValueError("status 'finished' is only valid for clear action")
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


class CreateAction(TodoAction):
    action: Literal["create"] = "create"
    content: str = Field(description="Brief description of the task.")
    status: Literal["pending", "in_progress", "completed", "cancelled"] = Field(
        default="pending",
        description="Initial status.",
    )


class UpdateAction(TodoAction):
    action: Literal["update"] = "update"
    task_id: str = Field(description="ID of the task to update (e.g. task_1).")


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

ActionModel = (
    TodoAction | CreateAction | UpdateAction | DeleteAction | ReadAction | ClearAction
)

_ACTION_CLS_MAP = {
    "create": CreateAction,
    "update": UpdateAction,
    "delete": DeleteAction,
    "read": ReadAction,
    "clear": ClearAction,
}


def _coerce_actions(value: Any) -> Any:
    """Accept ``actions`` the way models emit it."""
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
        coerced: list[Any] = []
        for item in value:
            if isinstance(item, dict) and "action" in item:
                act_name = item.get("action")
                cls = _ACTION_CLS_MAP.get(act_name)
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
    """Arguments for the todo_manage tool."""

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
        return _coerce_actions(value)


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
        logger.warning("todo_store_unreadable path={} error={!r}", path, exc)
    return {"counter": 0, "items": []}


def _save_store(store: dict, *, path: Any | None = None) -> None:
    path = path if path is not None else _todos_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(store, indent=2, ensure_ascii=False), encoding="utf-8")
    tmp.replace(path)


def _format_items(items: list[dict]) -> str:
    if not items:
        return "No todos."
    lines: list[str] = []
    for item in items:
        lines.append(f"[{item['task_id']}] [{item['status']}] {item['content']}")
    return "\n".join(lines)


def _normalize_store(store: dict) -> dict:
    """Ensure persisted todo items have the current shape."""
    items = store.get("items", [])
    if not isinstance(items, list):
        store["items"] = []
    return store


def _consolidate_outcomes(log_parts: Sequence[str]) -> list[str]:
    """Group same-verb outcomes onto one line to keep the ack compact."""
    grouped: dict[str, list[str]] = {}
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


# ---------------------------------------------------------------------------
# Tool
# ---------------------------------------------------------------------------

_DESCRIPTION = """\
Manage the todo task list. Actions execute in order. Use create, update, delete,
read, or clear to track tasks and keep progress visible to the user.\
"""


async def _todo_manage(
    actions: list[AnyAction],
    _state: Annotated[Any, InjectedArg()] = None,
) -> str:
    return await _apply_actions(actions, _state=_state)


async def _apply_actions(
    actions: Sequence[ActionModel],
    *,
    _state: Any = None,
) -> str:
    store = _normalize_store(_load_store())

    log_parts: list[str] = []

    normalized_actions: list[Any] = []
    for item in actions:
        if isinstance(item, dict):
            act_name = item.get("action")
            cls = _ACTION_CLS_MAP.get(act_name, TodoAction)
            try:
                normalized_actions.append(cls.model_validate(item))
                continue
            except Exception:
                pass
        normalized_actions.append(item)

    for act in normalized_actions:
        act_type = getattr(act, "action", None)
        if act_type == "read" or isinstance(act, ReadAction):
            pass

        elif (act_type == "create" or isinstance(act, CreateAction)) and isinstance(
            act, TodoAction
        ):
            if not act.content:
                continue
            new_id = f"task_{store['counter'] + 1}"
            status = act.status or "pending"
            store["counter"] += 1
            store["items"].append(
                {
                    "task_id": new_id,
                    "content": act.content,
                    "status": status,
                }
            )
            log_parts.append(f"created {new_id}")

        elif act_type == "update" or isinstance(act, UpdateAction):
            task_id = act.task_id
            if not task_id:
                continue
            found = False
            for item in store["items"]:
                if item["task_id"] == task_id:
                    found = True
                    if act.content is not None:
                        item["content"] = act.content
                    if act.status is not None:
                        item["status"] = act.status
                    log_parts.append(f"updated {task_id}")
                    break
            if not found:
                log_parts.append(f"unknown {task_id}")

        elif act_type == "delete" or isinstance(act, DeleteAction):
            task_id = act.task_id
            if not task_id:
                continue
            before = len(store["items"])
            store["items"] = [i for i in store["items"] if i.get("task_id") != task_id]
            if len(store["items"]) < before:
                log_parts.append(f"deleted {task_id}")
            else:
                log_parts.append(f"unknown {task_id}")

        elif act_type == "clear" or isinstance(act, ClearAction):
            clear_status = (
                act.status
                if isinstance(act, ClearAction)
                else getattr(act, "status", None)
            ) or "finished"
            before = len(store["items"])
            if clear_status == "finished":
                store["items"] = [
                    i
                    for i in store["items"]
                    if i.get("status") not in ("completed", "cancelled")
                ]
            else:
                store["items"] = [
                    i for i in store["items"] if i.get("status") != clear_status
                ]
            cleared = before - len(store["items"])
            log_parts.append(f"cleared {cleared} tasks")

    _save_store(store)

    outcomes: list[str] = _consolidate_outcomes(log_parts)
    has_read = any(
        getattr(a, "action", None) == "read" or isinstance(a, ReadAction)
        for a in actions
    )
    if has_read or not outcomes:
        return _format_items(store["items"])

    out_text = "; ".join(outcomes)
    if has_read:
        out_text += "\n\n" + _format_items(store["items"])
    return out_text


def make_todo_manage_tool() -> Tool:
    """Return the todo_manage tool."""
    return Tool(
        _todo_manage,
        name="todo_manage",
        description=_DESCRIPTION,
        args_schema=TodoArgs,
    )


todo_manage: Tool = make_todo_manage_tool()
