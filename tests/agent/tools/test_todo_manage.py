"""Tests for single-agent todo_manage tool."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from pydantic import ValidationError

from app.agent.denied_paths import (
    DeniedPathsConfig as SandboxConfig,
    set_denied_paths as set_sandbox,
)
from app.agent.tools.builtin.todo import (
    AnyAction,
    ClearAction,
    CreateAction,
    DeleteAction,
    ReadAction,
    TODOS_FILENAME,
    TodoAction,
    TodoArgs,
    UpdateAction,
    _todo_manage,
)


@pytest.fixture
def tmp_sandbox(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> SandboxConfig:
    monkeypatch.setattr(
        "app.core.config.settings.OPENAGENTD_DATA_DIR", str(tmp_path / "data")
    )
    sandbox = SandboxConfig(workspace=str(tmp_path), session_id="session-1")
    set_sandbox(sandbox)
    yield sandbox


@pytest.fixture
def todos_file(tmp_sandbox: SandboxConfig) -> Path:
    return tmp_sandbox.metadata_path(TODOS_FILENAME)


@pytest.mark.asyncio
async def test_create_single_item(tmp_sandbox: SandboxConfig, todos_file: Path) -> None:
    actions: list[AnyAction] = [
        CreateAction(
            action="create",
            content="Buy groceries",
            status="pending",
        )
    ]

    result = await _todo_manage(actions=actions, _state=None)
    assert "created task_1" in result

    assert todos_file.exists()
    store = json.loads(todos_file.read_text())
    assert store["counter"] == 1
    assert len(store["items"]) == 1
    assert store["items"][0]["task_id"] == "task_1"
    assert store["items"][0]["content"] == "Buy groceries"
    assert store["items"][0]["status"] == "pending"


@pytest.mark.asyncio
async def test_create_batch_items(tmp_sandbox: SandboxConfig, todos_file: Path) -> None:
    actions: list[AnyAction] = [
        CreateAction(action="create", content="Task 1"),
        CreateAction(action="create", content="Task 2"),
    ]

    result = await _todo_manage(actions=actions, _state=None)
    assert "created task_1, task_2" in result

    store = json.loads(todos_file.read_text())
    assert store["counter"] == 2
    assert len(store["items"]) == 2
    assert store["items"][0]["task_id"] == "task_1"
    assert store["items"][1]["task_id"] == "task_2"


@pytest.mark.asyncio
async def test_update_item(tmp_sandbox: SandboxConfig, todos_file: Path) -> None:
    await _todo_manage(
        actions=[CreateAction(action="create", content="Initial task")],
        _state=None,
    )

    result = await _todo_manage(
        actions=[
            UpdateAction(
                action="update",
                task_id="task_1",
                content="Updated task",
                status="in_progress",
            )
        ],
        _state=None,
    )
    assert "updated task_1" in result

    store = json.loads(todos_file.read_text())
    assert store["items"][0]["content"] == "Updated task"
    assert store["items"][0]["status"] == "in_progress"


@pytest.mark.asyncio
async def test_update_unknown_item(tmp_sandbox: SandboxConfig) -> None:
    result = await _todo_manage(
        actions=[
            UpdateAction(
                action="update",
                task_id="task_999",
                status="completed",
            )
        ],
        _state=None,
    )
    assert "unknown task_999" in result


@pytest.mark.asyncio
async def test_delete_item(tmp_sandbox: SandboxConfig, todos_file: Path) -> None:
    await _todo_manage(
        actions=[
            CreateAction(action="create", content="Task to delete"),
            CreateAction(action="create", content="Task to keep"),
        ],
        _state=None,
    )

    result = await _todo_manage(
        actions=[DeleteAction(action="delete", task_id="task_1")],
        _state=None,
    )
    assert "deleted task_1" in result

    store = json.loads(todos_file.read_text())
    assert len(store["items"]) == 1
    assert store["items"][0]["task_id"] == "task_2"


@pytest.mark.asyncio
async def test_read_items(tmp_sandbox: SandboxConfig) -> None:
    await _todo_manage(
        actions=[
            CreateAction(action="create", content="Task 1", status="pending"),
            CreateAction(action="create", content="Task 2", status="in_progress"),
        ],
        _state=None,
    )

    result = await _todo_manage(actions=[ReadAction(action="read")], _state=None)
    assert "[task_1] [pending] Task 1" in result
    assert "[task_2] [in_progress] Task 2" in result


@pytest.mark.asyncio
async def test_read_empty(tmp_sandbox: SandboxConfig) -> None:
    result = await _todo_manage(actions=[ReadAction(action="read")], _state=None)
    assert result == "No todos."


@pytest.mark.asyncio
async def test_clear_finished(tmp_sandbox: SandboxConfig, todos_file: Path) -> None:
    await _todo_manage(
        actions=[
            CreateAction(action="create", content="Done task", status="completed"),
            CreateAction(action="create", content="Cancelled task", status="cancelled"),
            CreateAction(action="create", content="Active task", status="in_progress"),
        ],
        _state=None,
    )

    result = await _todo_manage(
        actions=[ClearAction(action="clear", status="finished")],
        _state=None,
    )
    assert "cleared 2 tasks" in result

    store = json.loads(todos_file.read_text())
    assert len(store["items"]) == 1
    assert store["items"][0]["content"] == "Active task"


def test_todo_args_coercion() -> None:
    args = TodoArgs.model_validate({"actions": [{"action": "read"}]})
    assert len(args.actions) == 1
    assert args.actions[0].action == "read"

    # Single dict normalized to list
    args2 = TodoArgs.model_validate({"action": "create", "content": "Hello"})
    assert len(args2.actions) == 1
    assert args2.actions[0].content == "Hello"


def test_validation_errors() -> None:
    with pytest.raises(ValidationError):
        TodoAction.model_validate({"action": "create"})

    with pytest.raises(ValidationError):
        TodoAction.model_validate({"action": "update"})

    with pytest.raises(ValidationError):
        TodoAction.model_validate({"action": "delete"})
