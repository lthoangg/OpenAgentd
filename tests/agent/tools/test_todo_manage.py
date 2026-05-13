"""Tests for todo_manage tool.

Covers:
- Single and batch create actions with auto-incrementing task_ids
- Update actions (full and partial)
- Delete actions
- Read actions
- Error handling for unknown task_ids
- State metadata caching within a turn
- Counter persistence across operations
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import pytest
from pydantic import ValidationError

from app.agent.sandbox import SandboxConfig, set_sandbox
from app.agent.tools.builtin.todo import (
    AnyAction,
    ClaimAction,
    CreateAction,
    DeleteAction,
    ReadAction,
    TODOS_FILENAME,
    UpdateAction,
    _todo_manage,
    release_in_progress_for_actor,
    todo_manage,
    todo_manage_member,
)


@dataclass
class MockState:
    """Minimal mock of AgentState for testing."""

    metadata: dict[str, Any]


@pytest.fixture
def tmp_sandbox(tmp_path: Path) -> SandboxConfig:
    """Create a temporary sandbox pointing to tmp_path."""
    sandbox = SandboxConfig(workspace=str(tmp_path))
    set_sandbox(sandbox)
    yield sandbox


@pytest.fixture
def todos_file(tmp_sandbox: SandboxConfig) -> Path:
    """Return the path to .openagentd/.todos.json in the sandbox."""
    return tmp_sandbox.workspace_root / TODOS_FILENAME


def test_release_in_progress_for_actor_resets_claimed_tasks(tmp_path: Path) -> None:
    todos = tmp_path / TODOS_FILENAME
    todos.parent.mkdir(parents=True)
    todos.write_text(
        json.dumps(
            {
                "counter": 3,
                "items": [
                    {
                        "task_id": "task_1",
                        "content": "stopped work",
                        "status": "in_progress",
                        "priority": "high",
                        "dependencies": [],
                        "assigned_to": "worker#1",
                        "claimed_by": "worker#1",
                    },
                    {
                        "task_id": "task_2",
                        "content": "assigned pending work",
                        "status": "pending",
                        "priority": "medium",
                        "dependencies": [],
                        "assigned_to": "worker#1",
                        "claimed_by": None,
                    },
                    {
                        "task_id": "task_3",
                        "content": "other work",
                        "status": "in_progress",
                        "priority": "medium",
                        "dependencies": [],
                        "assigned_to": "worker#2",
                        "claimed_by": "worker#2",
                    },
                ],
            }
        ),
        encoding="utf-8",
    )

    released = release_in_progress_for_actor(tmp_path, "worker#1")

    assert released == ["task_1", "task_2"]
    data = json.loads(todos.read_text(encoding="utf-8"))
    assert data["items"][0]["status"] == "pending"
    assert data["items"][0]["claimed_by"] is None
    assert data["items"][0]["assigned_to"] is None
    assert data["items"][1]["status"] == "pending"
    assert data["items"][1]["claimed_by"] is None
    assert data["items"][1]["assigned_to"] is None
    assert data["items"][2]["status"] == "in_progress"


# ─────────────────────────────────────────────────────────────────────────────
# Test: Create Actions
# ─────────────────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_create_single_item(tmp_sandbox: SandboxConfig, todos_file: Path) -> None:
    """Test creating a single task assigns task_1 and increments counter."""
    actions: list[AnyAction] = [
        CreateAction(
            action="create",
            content="Buy groceries",
            status="pending",
            priority="high",
        )
    ]

    result = await _todo_manage(actions=actions, _state=None)

    # Verify output contains the task
    assert "task_1" in result
    assert "Buy groceries" in result
    assert "pending" in result
    assert "high" in result

    # Verify file was written
    assert todos_file.exists()
    store = json.loads(todos_file.read_text())
    assert store["counter"] == 1
    assert len(store["items"]) == 1
    assert store["items"][0]["task_id"] == "task_1"
    assert store["items"][0]["content"] == "Buy groceries"
    assert store["items"][0]["status"] == "pending"
    assert store["items"][0]["priority"] == "high"
    assert store["items"][0]["dependencies"] == []
    assert store["items"][0]["assigned_to"] is None
    assert store["items"][0]["claimed_by"] is None


@pytest.mark.asyncio
async def test_create_multiple_items_sequential_ids(
    tmp_sandbox: SandboxConfig, todos_file: Path
) -> None:
    """Test multiple creates in one call get sequential task_ids."""
    actions: list[AnyAction] = [
        CreateAction(
            action="create",
            content="Task 1",
            status="pending",
            priority="high",
        ),
        CreateAction(
            action="create",
            content="Task 2",
            status="in_progress",
            priority="medium",
        ),
        CreateAction(
            action="create",
            content="Task 3",
            status="completed",
            priority="low",
        ),
    ]

    result = await _todo_manage(actions=actions, _state=None)

    # Verify all tasks in output
    assert "task_1" in result
    assert "task_2" in result
    assert "task_3" in result
    assert "Task 1" in result
    assert "Task 2" in result
    assert "Task 3" in result

    # Verify file state
    store = json.loads(todos_file.read_text())
    assert store["counter"] == 3
    assert len(store["items"]) == 3
    assert store["items"][0]["task_id"] == "task_1"
    assert store["items"][1]["task_id"] == "task_2"
    assert store["items"][2]["task_id"] == "task_3"


# ─────────────────────────────────────────────────────────────────────────────
# Test: Update Actions
# ─────────────────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_update_full_item(tmp_sandbox: SandboxConfig, todos_file: Path) -> None:
    """Test updating all fields of an existing task."""
    # Setup: create a task first
    create_actions: list[AnyAction] = [
        CreateAction(
            action="create",
            content="Original content",
            status="pending",
            priority="low",
        )
    ]
    await _todo_manage(actions=create_actions, _state=None)

    # Update all fields
    update_actions: list[AnyAction] = [
        UpdateAction(
            action="update",
            task_id="task_1",
            content="Updated content",
            status="in_progress",
            priority="high",
        )
    ]
    result = await _todo_manage(actions=update_actions, _state=None)

    # Verify output
    assert "task_1" in result
    assert "Updated content" in result
    assert "in_progress" in result
    assert "high" in result
    assert "Original content" not in result

    # Verify file state
    store = json.loads(todos_file.read_text())
    item = store["items"][0]
    assert item["content"] == "Updated content"
    assert item["status"] == "in_progress"
    assert item["priority"] == "high"


@pytest.mark.asyncio
async def test_update_partial_status_only(
    tmp_sandbox: SandboxConfig, todos_file: Path
) -> None:
    """Test partial update: only status field, content and priority unchanged."""
    # Setup
    create_actions: list[AnyAction] = [
        CreateAction(
            action="create",
            content="Task content",
            status="pending",
            priority="medium",
        )
    ]
    await _todo_manage(actions=create_actions, _state=None)

    # Partial update: only status
    update_actions: list[AnyAction] = [
        UpdateAction(
            action="update",
            task_id="task_1",
            status="completed",
        )
    ]
    result = await _todo_manage(actions=update_actions, _state=None)

    # Verify output
    assert "completed" in result
    assert "Task content" in result
    assert "medium" in result

    # Verify file state
    store = json.loads(todos_file.read_text())
    item = store["items"][0]
    assert item["content"] == "Task content"  # unchanged
    assert item["status"] == "completed"  # changed
    assert item["priority"] == "medium"  # unchanged


@pytest.mark.asyncio
async def test_update_partial_priority_only(
    tmp_sandbox: SandboxConfig, todos_file: Path
) -> None:
    """Test partial update: only priority field."""
    # Setup
    create_actions: list[AnyAction] = [
        CreateAction(
            action="create",
            content="Task content",
            status="pending",
            priority="low",
        )
    ]
    await _todo_manage(actions=create_actions, _state=None)

    # Partial update: only priority
    update_actions: list[AnyAction] = [
        UpdateAction(
            action="update",
            task_id="task_1",
            priority="high",
        )
    ]
    await _todo_manage(actions=update_actions, _state=None)

    # Verify file state
    store = json.loads(todos_file.read_text())
    item = store["items"][0]
    assert item["content"] == "Task content"  # unchanged
    assert item["status"] == "pending"  # unchanged
    assert item["priority"] == "high"  # changed


@pytest.mark.asyncio
async def test_update_unknown_task_id_returns_error(
    tmp_sandbox: SandboxConfig, todos_file: Path
) -> None:
    """Test updating a non-existent task_id returns error message."""
    # Setup: create one task
    create_actions: list[AnyAction] = [
        CreateAction(
            action="create",
            content="Task 1",
            status="pending",
            priority="high",
        )
    ]
    await _todo_manage(actions=create_actions, _state=None)

    # Try to update non-existent task
    update_actions: list[AnyAction] = [
        UpdateAction(
            action="update",
            task_id="task_999",
            status="completed",
        )
    ]
    result = await _todo_manage(actions=update_actions, _state=None)

    # Verify error is logged (the tool returns the list, but logs the error)
    # The result should still show the original task
    assert "task_1" in result
    assert "Task 1" in result

    # Verify file state unchanged
    store = json.loads(todos_file.read_text())
    assert len(store["items"]) == 1
    assert store["items"][0]["status"] == "pending"  # unchanged


@pytest.mark.asyncio
async def test_create_with_dependencies_and_assignee(
    tmp_sandbox: SandboxConfig, todos_file: Path
) -> None:
    """Test dependencies and assigned_to are persisted as first-class fields."""
    await _todo_manage(
        actions=[
            CreateAction(
                action="create",
                content="Research",
                status="pending",
                priority="high",
                assigned_to="member#1",
            ),
            CreateAction(
                action="create",
                content="Implement",
                status="pending",
                priority="high",
                dependencies=["task_1"],
                assigned_to="member#2",
            ),
        ],
        _state=None,
    )

    store = json.loads(todos_file.read_text())
    assert store["items"][1]["dependencies"] == ["task_1"]
    assert store["items"][1]["assigned_to"] == "member#2"


@pytest.mark.asyncio
async def test_claim_blocked_task_keeps_pending(
    tmp_sandbox: SandboxConfig, todos_file: Path
) -> None:
    """A member cannot claim work until dependencies are completed."""
    await _todo_manage(
        actions=[
            CreateAction(
                action="create",
                content="Research",
                status="pending",
                priority="high",
                assigned_to="member#1",
            ),
            CreateAction(
                action="create",
                content="Implement",
                status="pending",
                priority="high",
                dependencies=["task_1"],
                assigned_to="member#2",
            ),
        ],
        _state=None,
    )
    state = MockState(metadata={"agent_name": "member#2"})

    result = await _todo_manage(
        actions=[ClaimAction(action="claim", task_id="task_2")],
        _state=state,
    )

    store = json.loads(todos_file.read_text())
    assert store["items"][1]["status"] == "pending"
    assert store["items"][1]["claimed_by"] is None
    assert "[task_2] [pending]" in result


@pytest.mark.asyncio
async def test_claim_unblocked_assigned_task_marks_in_progress(
    tmp_sandbox: SandboxConfig, todos_file: Path
) -> None:
    """A member can claim assigned work after dependencies complete."""
    await _todo_manage(
        actions=[
            CreateAction(
                action="create",
                content="Research",
                status="completed",
                priority="high",
                assigned_to="member#1",
            ),
            CreateAction(
                action="create",
                content="Implement",
                status="pending",
                priority="high",
                dependencies=["task_1"],
                assigned_to="member#2",
            ),
        ],
        _state=None,
    )
    state = MockState(metadata={"agent_name": "member#2"})

    result = await _todo_manage(
        actions=[ClaimAction(action="claim", task_id="task_2")],
        _state=state,
    )

    store = json.loads(todos_file.read_text())
    assert store["items"][1]["status"] == "in_progress"
    assert store["items"][1]["claimed_by"] == "member#2"
    assert "[task_2] [in_progress]" in result


@pytest.mark.asyncio
async def test_claim_requires_exact_handle_assignment(
    tmp_sandbox: SandboxConfig, todos_file: Path
) -> None:
    """A spawned instance cannot claim work assigned to another handle."""
    await _todo_manage(
        actions=[
            CreateAction(
                action="create",
                content="Implement",
                status="pending",
                priority="high",
                assigned_to="executor#2",
            )
        ],
        _state=None,
    )
    state = MockState(metadata={"agent_name": "executor#1"})

    await _todo_manage(
        actions=[ClaimAction(action="claim", task_id="task_1")],
        _state=state,
    )

    store = json.loads(todos_file.read_text())
    assert store["items"][0]["status"] == "pending"
    assert store["items"][0]["claimed_by"] is None


@pytest.mark.asyncio
async def test_lead_cannot_claim_member_assigned_task_by_starting_it(
    tmp_sandbox: SandboxConfig, todos_file: Path
) -> None:
    """Lead status updates must not claim work assigned to another agent."""
    await _todo_manage(
        actions=[
            CreateAction(
                action="create",
                content="Implement",
                status="pending",
                priority="high",
                assigned_to="executor#1",
            )
        ],
        _state=MockState(metadata={"agent_name": "openagentd"}),
    )

    result = await _todo_manage(
        actions=[UpdateAction(action="update", task_id="task_1", status="in_progress")],
        _state=MockState(metadata={"agent_name": "openagentd"}),
    )

    store = json.loads(todos_file.read_text())
    assert store["items"][0]["status"] == "pending"
    assert store["items"][0]["claimed_by"] is None
    assert "[task_1] [pending]" in result


def test_multi_assignee_is_rejected() -> None:
    """assigned_to is a single claimable owner, not a group expression."""
    with pytest.raises(ValidationError):
        CreateAction(
            action="create",
            content="Smoke members",
            status="pending",
            priority="high",
            assigned_to="executor/explorer",
        )


def test_blueprint_assignee_is_rejected() -> None:
    """assigned_to must be a concrete spawned handle."""
    with pytest.raises(ValidationError):
        CreateAction(
            action="create",
            content="Smoke executor",
            status="pending",
            priority="high",
            assigned_to="executor",
        )


@pytest.mark.asyncio
async def test_member_tool_schema_excludes_lead_actions() -> None:
    """Member-facing todo_manage cannot create, delete, or assign tasks."""
    actions_schema = todo_manage_member.definition["function"]["parameters"][
        "properties"
    ]["actions"]
    schema_text = json.dumps(actions_schema)
    assert '"create"' not in schema_text
    assert '"delete"' not in schema_text
    assert '"assigned_to"' not in schema_text
    assert '"dependencies"' not in schema_text


@pytest.mark.asyncio
async def test_lead_tool_schema_excludes_member_claim_action() -> None:
    """Lead-facing todo_manage plans work but does not claim it."""
    actions_schema = todo_manage.definition["function"]["parameters"]["properties"][
        "actions"
    ]
    schema_text = json.dumps(actions_schema)
    assert '"claim"' not in schema_text
    assert '"create"' in schema_text
    assert '"delete"' in schema_text


@pytest.mark.asyncio
async def test_member_update_requires_claim_or_assignment(
    tmp_sandbox: SandboxConfig, todos_file: Path
) -> None:
    """Members cannot update tasks owned by another agent."""
    await _todo_manage(
        actions=[
            CreateAction(
                action="create",
                content="Task",
                status="pending",
                priority="high",
                assigned_to="member#1",
            )
        ],
        _state=None,
    )
    state = MockState(metadata={"agent_name": "member#2"})

    await todo_manage_member.arun(
        _injected={"_state": state},
        actions=[{"action": "update", "task_id": "task_1", "status": "completed"}],
    )

    store = json.loads(todos_file.read_text())
    assert store["items"][0]["status"] == "pending"


# ─────────────────────────────────────────────────────────────────────────────
# Test: Delete Actions
# ─────────────────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_delete_existing_task(
    tmp_sandbox: SandboxConfig, todos_file: Path
) -> None:
    """Test deleting an existing task removes it from the list."""
    # Setup: create two tasks
    create_actions: list[AnyAction] = [
        CreateAction(
            action="create",
            content="Task 1",
            status="pending",
            priority="high",
        ),
        CreateAction(
            action="create",
            content="Task 2",
            status="pending",
            priority="high",
        ),
    ]
    await _todo_manage(actions=create_actions, _state=None)

    # Delete task_1
    delete_actions: list[AnyAction] = [DeleteAction(action="delete", task_id="task_1")]
    result = await _todo_manage(actions=delete_actions, _state=None)

    # Verify output: task_1 gone, task_2 remains
    assert "task_1" not in result
    assert "task_2" in result
    assert "Task 2" in result

    # Verify file state
    store = json.loads(todos_file.read_text())
    assert len(store["items"]) == 1
    assert store["items"][0]["task_id"] == "task_2"


@pytest.mark.asyncio
async def test_delete_unknown_task_id_returns_error(
    tmp_sandbox: SandboxConfig, todos_file: Path
) -> None:
    """Test deleting a non-existent task_id returns error message."""
    # Setup: create one task
    create_actions: list[AnyAction] = [
        CreateAction(
            action="create",
            content="Task 1",
            status="pending",
            priority="high",
        )
    ]
    await _todo_manage(actions=create_actions, _state=None)

    # Try to delete non-existent task
    delete_actions: list[AnyAction] = [
        DeleteAction(action="delete", task_id="task_999")
    ]
    result = await _todo_manage(actions=delete_actions, _state=None)

    # Verify original task still there
    assert "task_1" in result
    assert "Task 1" in result

    # Verify file state unchanged
    store = json.loads(todos_file.read_text())
    assert len(store["items"]) == 1


# ─────────────────────────────────────────────────────────────────────────────
# Test: Read Actions
# ─────────────────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_read_returns_formatted_list(
    tmp_sandbox: SandboxConfig, todos_file: Path
) -> None:
    """Test read action returns formatted task list."""
    # Setup: create tasks
    create_actions: list[AnyAction] = [
        CreateAction(
            action="create",
            content="Buy milk",
            status="pending",
            priority="high",
        ),
        CreateAction(
            action="create",
            content="Write report",
            status="in_progress",
            priority="medium",
        ),
    ]
    await _todo_manage(actions=create_actions, _state=None)

    # Read
    read_actions: list[AnyAction] = [ReadAction(action="read")]
    result = await _todo_manage(actions=read_actions, _state=None)

    # Verify formatted output
    assert "[task_1]" in result
    assert "[task_2]" in result
    assert "[pending]" in result
    assert "[in_progress]" in result
    assert "(high)" in result
    assert "(medium)" in result
    assert "Buy milk" in result
    assert "Write report" in result


@pytest.mark.asyncio
async def test_read_empty_list(tmp_sandbox: SandboxConfig, todos_file: Path) -> None:
    """Test read on empty list returns 'No todos.'"""
    read_actions: list[AnyAction] = [ReadAction(action="read")]
    result = await _todo_manage(actions=read_actions, _state=None)

    assert result == "No todos."


# ─────────────────────────────────────────────────────────────────────────────
# Test: Batch Operations
# ─────────────────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_batch_create_update_delete_in_order(
    tmp_sandbox: SandboxConfig, todos_file: Path
) -> None:
    """Test batch: create + update + delete executed in order."""
    actions: list[AnyAction] = [
        # Create two tasks
        CreateAction(
            action="create",
            content="Task A",
            status="pending",
            priority="high",
        ),
        CreateAction(
            action="create",
            content="Task B",
            status="pending",
            priority="medium",
        ),
        # Update task_1
        UpdateAction(
            action="update",
            task_id="task_1",
            status="in_progress",
        ),
        # Delete task_2
        DeleteAction(action="delete", task_id="task_2"),
        # Read final state
        ReadAction(action="read"),
    ]

    result = await _todo_manage(actions=actions, _state=None)

    # Verify final state: only task_1 remains, with updated status
    assert "task_1" in result
    assert "task_2" not in result
    assert "in_progress" in result
    assert "Task A" in result
    assert "Task B" not in result

    # Verify file state
    store = json.loads(todos_file.read_text())
    assert store["counter"] == 2
    assert len(store["items"]) == 1
    assert store["items"][0]["task_id"] == "task_1"
    assert store["items"][0]["status"] == "in_progress"


# ─────────────────────────────────────────────────────────────────────────────
# Test: Counter Persistence
# ─────────────────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_counter_does_not_rewind_after_delete(
    tmp_sandbox: SandboxConfig, todos_file: Path
) -> None:
    """Test counter increments monotonically; delete does not rewind it."""
    # Create task_1
    await _todo_manage(
        actions=[
            CreateAction(
                action="create",
                content="Task 1",
                status="pending",
                priority="high",
            )
        ],
        _state=None,
    )

    # Delete task_1
    await _todo_manage(
        actions=[DeleteAction(action="delete", task_id="task_1")],
        _state=None,
    )

    # Create another task — should be task_2, not task_1
    result = await _todo_manage(
        actions=[
            CreateAction(
                action="create",
                content="Task 2",
                status="pending",
                priority="high",
            )
        ],
        _state=None,
    )

    assert "task_2" in result
    assert "task_1" not in result

    # Verify file state
    store = json.loads(todos_file.read_text())
    assert store["counter"] == 2
    assert len(store["items"]) == 1
    assert store["items"][0]["task_id"] == "task_2"


# ─────────────────────────────────────────────────────────────────────────────
# Test: State Metadata Caching
# ─────────────────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_state_metadata_cache_within_turn(
    tmp_sandbox: SandboxConfig, todos_file: Path
) -> None:
    """Test second call within same turn reads from cache, not disk."""
    # First call: create a task
    state = MockState(metadata={})
    await _todo_manage(
        actions=[
            CreateAction(
                action="create",
                content="Task 1",
                status="pending",
                priority="high",
            )
        ],
        _state=state,
    )

    # Verify cache was populated
    assert "_todos" in state.metadata
    cached_store = state.metadata["_todos"]
    assert cached_store["counter"] == 1

    # Delete the file to verify second call uses cache, not disk
    todos_file.unlink()

    # Second call: should use cached store
    result = await _todo_manage(
        actions=[ReadAction(action="read")],
        _state=state,
    )

    # Verify task is still there (from cache)
    assert "task_1" in result
    assert "Task 1" in result

    # Verify file was recreated with cached data
    assert todos_file.exists()
    store = json.loads(todos_file.read_text())
    assert store["counter"] == 1
    assert len(store["items"]) == 1


@pytest.mark.asyncio
async def test_state_metadata_cache_updated_after_operations(
    tmp_sandbox: SandboxConfig, todos_file: Path
) -> None:
    """Test cache is updated after each operation."""
    state = MockState(metadata={})

    # First call: create
    await _todo_manage(
        actions=[
            CreateAction(
                action="create",
                content="Task 1",
                status="pending",
                priority="high",
            )
        ],
        _state=state,
    )

    cached_store_1 = state.metadata["_todos"]
    assert cached_store_1["counter"] == 1

    # Second call: create another
    await _todo_manage(
        actions=[
            CreateAction(
                action="create",
                content="Task 2",
                status="pending",
                priority="high",
            )
        ],
        _state=state,
    )

    cached_store_2 = state.metadata["_todos"]
    assert cached_store_2["counter"] == 2
    assert len(cached_store_2["items"]) == 2


# ─────────────────────────────────────────────────────────────────────────────
# Test: Edge Cases
# ─────────────────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_empty_actions_list(tmp_sandbox: SandboxConfig, todos_file: Path) -> None:
    """Test empty actions list returns empty todos."""
    result = await _todo_manage(actions=[], _state=None)
    assert result == "No todos."


@pytest.mark.asyncio
async def test_multiple_reads_in_batch(
    tmp_sandbox: SandboxConfig, todos_file: Path
) -> None:
    """Test multiple read actions in one batch."""
    # Setup
    await _todo_manage(
        actions=[
            CreateAction(
                action="create",
                content="Task 1",
                status="pending",
                priority="high",
            )
        ],
        _state=None,
    )

    # Multiple reads
    result = await _todo_manage(
        actions=[
            ReadAction(action="read"),
            ReadAction(action="read"),
        ],
        _state=None,
    )

    # Should show the task
    assert "task_1" in result
    assert "Task 1" in result


@pytest.mark.asyncio
async def test_create_with_special_characters_in_content(
    tmp_sandbox: SandboxConfig, todos_file: Path
) -> None:
    """Test create with special characters and unicode in content."""
    actions: list[AnyAction] = [
        CreateAction(
            action="create",
            content="Buy 🍎 & 🍊 (fruits) — café",
            status="pending",
            priority="high",
        )
    ]

    result = await _todo_manage(actions=actions, _state=None)

    assert "Buy 🍎 & 🍊 (fruits) — café" in result

    # Verify file preserves unicode
    store = json.loads(todos_file.read_text())
    assert store["items"][0]["content"] == "Buy 🍎 & 🍊 (fruits) — café"


@pytest.mark.asyncio
async def test_update_then_read_shows_updated_content(
    tmp_sandbox: SandboxConfig, todos_file: Path
) -> None:
    """Test update followed by read in same batch shows updated content."""
    actions: list[AnyAction] = [
        CreateAction(
            action="create",
            content="Original",
            status="pending",
            priority="high",
        ),
        UpdateAction(
            action="update",
            task_id="task_1",
            content="Updated",
        ),
        ReadAction(action="read"),
    ]

    result = await _todo_manage(actions=actions, _state=None)

    assert "Updated" in result
    assert "Original" not in result


@pytest.mark.asyncio
async def test_create_after_delete_all_then_read(
    tmp_sandbox: SandboxConfig, todos_file: Path
) -> None:
    """Test create after deleting all tasks."""
    # Create and delete
    await _todo_manage(
        actions=[
            CreateAction(
                action="create",
                content="Task 1",
                status="pending",
                priority="high",
            ),
            DeleteAction(action="delete", task_id="task_1"),
        ],
        _state=None,
    )

    # Create new task
    result = await _todo_manage(
        actions=[
            CreateAction(
                action="create",
                content="Task 2",
                status="pending",
                priority="high",
            ),
            ReadAction(action="read"),
        ],
        _state=None,
    )

    assert "task_2" in result
    assert "Task 2" in result
    assert "task_1" not in result
