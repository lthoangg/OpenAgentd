"""Tests for todo_manage tool.

Covers:
- Single and batch create actions with auto-incrementing task_ids
- Update actions (full and partial)
- Delete actions
- Read actions
- Error handling for unknown task_ids
- Cross-run consistency (no per-run cache; concurrent writes are not clobbered)
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
    ClearAction,
    CreateAction,
    DeleteAction,
    MemberUpdateAction,
    ReadAction,
    TODOS_FILENAME,
    _apply_actions,
    TodoArgs,
    TodoMemberArgs,
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
def tmp_sandbox(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> SandboxConfig:
    """Create a temporary sandbox pointing to tmp_path.

    Session artifacts (the todo store) live under ``OPENAGENTD_DATA_DIR`` —
    pinned here to ``tmp_path`` so each test gets an isolated, empty store
    instead of sharing the process-wide ``.tests/data`` default and leaking
    todos between tests.
    """
    monkeypatch.setattr(
        "app.core.config.settings.OPENAGENTD_DATA_DIR", str(tmp_path / "data")
    )
    sandbox = SandboxConfig(workspace=str(tmp_path), session_id="session-1")
    set_sandbox(sandbox)
    yield sandbox


@pytest.fixture
def todos_file(tmp_sandbox: SandboxConfig) -> Path:
    """Return the path to the session-scoped todo file in the sandbox."""
    return tmp_sandbox.metadata_path(TODOS_FILENAME)


def test_release_in_progress_for_actor_resets_claimed_tasks(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # Session todos live under OPENAGENTD_DATA_DIR/sessions/<sid> — isolate it
    # per-test and write the seed store where the function will actually read.
    monkeypatch.setattr(
        "app.core.config.settings.OPENAGENTD_DATA_DIR", str(tmp_path / "data")
    )
    todos = tmp_path / "data" / "sessions" / "session-1" / TODOS_FILENAME
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

    released = release_in_progress_for_actor("worker#1", "session-1")

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

    # Mutations return a compact ack, not the board
    assert "created task_1" in result

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

    # Verify consolidated ack (one line per verb)
    assert "created task_1, task_2, task_3" in result

    # Verify file state
    store = json.loads(todos_file.read_text())
    assert store["counter"] == 3
    assert len(store["items"]) == 3
    assert store["items"][0]["task_id"] == "task_1"
    assert store["items"][1]["task_id"] == "task_2"
    assert store["items"][2]["task_id"] == "task_3"


@pytest.mark.asyncio
async def test_todos_are_isolated_by_sandbox_session(tmp_path: Path) -> None:
    sandbox_one = SandboxConfig(workspace=str(tmp_path), session_id="session-1")
    token_one = set_sandbox(sandbox_one)
    try:
        await _todo_manage(
            actions=[
                CreateAction(
                    action="create",
                    content="Session one task",
                    status="pending",
                    priority="high",
                )
            ],
            _state=None,
        )
    finally:
        from app.agent.sandbox import _sandbox_ctx

        _sandbox_ctx.reset(token_one)

    sandbox_two = SandboxConfig(workspace=str(tmp_path), session_id="session-2")
    token_two = set_sandbox(sandbox_two)
    try:
        result = await _todo_manage(actions=[ReadAction(action="read")], _state=None)
    finally:
        from app.agent.sandbox import _sandbox_ctx

        _sandbox_ctx.reset(token_two)

    assert result == "No todos."
    assert sandbox_one.metadata_path(TODOS_FILENAME).exists()
    store_two = json.loads(sandbox_two.metadata_path(TODOS_FILENAME).read_text())
    assert store_two == {"counter": 0, "items": []}


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

    # Verify ack (mutations do not echo the board)
    assert "updated task_1" in result
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

    # Verify ack
    assert "updated task_1" in result

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

    # The failure is reported in the response
    assert "not_found task_999" in result

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
    assert "blocked task_2" in result
    assert "task_1" in result  # names the unmet dependency


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
    assert "not_assigned task_1" in result


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

    # Verify ack
    assert "deleted task_1" in result

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

    # The failure is reported in the response
    assert "not_found task_999" in result

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
async def test_mutations_return_compact_ack_not_full_board(
    tmp_sandbox: SandboxConfig, todos_file: Path
) -> None:
    """The agent wrote the mutation — echoing the whole board back (other
    tasks' full instructions/results included) is token waste. Mutations
    return per-action outcomes instead."""
    await _todo_manage(
        actions=[
            CreateAction(
                action="create",
                content="Existing task",
                status="pending",
                priority="high",
                instructions="A very long delegation brief that must not be re-echoed.",
            )
        ],
        _state=None,
    )

    result = await _todo_manage(
        actions=[
            CreateAction(
                action="create",
                content="New task",
                status="pending",
                priority="low",
            )
        ],
        _state=None,
    )

    assert "created task_2" in result
    # The unrelated task's brief is not echoed back on a mutation.
    assert "A very long delegation brief" not in result
    assert "Existing task" not in result


@pytest.mark.asyncio
async def test_mutation_failures_are_reported_in_the_response(
    tmp_sandbox: SandboxConfig, todos_file: Path
) -> None:
    """Validation outcomes must reach the agent, not just the server log."""
    result = await _todo_manage(
        actions=[
            UpdateAction(action="update", task_id="task_99", priority="low"),
        ],
        _state=None,
    )
    assert "not_found task_99" in result


@pytest.mark.asyncio
async def test_claim_echoes_the_task_line_with_instructions(
    tmp_sandbox: SandboxConfig, todos_file: Path
) -> None:
    """The member did not write the task — a successful claim returns the
    task line and its delegation brief."""
    await _todo_manage(
        actions=[
            CreateAction(
                action="create",
                content="Do the thing",
                status="pending",
                priority="high",
                assigned_to="executor#1",
                instructions="Follow the house style.",
            )
        ],
        _state=None,
    )

    result = await _todo_manage(
        actions=[ClaimAction(action="claim", task_id="task_1")],
        _state=MockState(metadata={"agent_name": "executor#1"}),
    )

    assert "claimed task_1" in result
    assert "[task_1] [in_progress]" in result
    assert "Follow the house style." in result


@pytest.mark.asyncio
async def test_batch_with_read_returns_full_board(
    tmp_sandbox: SandboxConfig, todos_file: Path
) -> None:
    """An explicit read in the batch keeps the full listing."""
    await _todo_manage(
        actions=[
            CreateAction(
                action="create",
                content="First task",
                status="pending",
                priority="high",
            )
        ],
        _state=None,
    )

    result = await _todo_manage(
        actions=[
            CreateAction(
                action="create",
                content="Second task",
                status="pending",
                priority="low",
            ),
            ReadAction(action="read"),
        ],
        _state=None,
    )

    assert "First task" in result
    assert "Second task" in result


@pytest.mark.asyncio
async def test_create_with_instructions_persists(
    tmp_sandbox: SandboxConfig, todos_file: Path
) -> None:
    """The delegation brief rides on the task itself."""
    await _todo_manage(
        actions=[
            CreateAction(
                action="create",
                content="Build the parser",
                status="pending",
                priority="high",
                assigned_to="executor#1",
                instructions="Use the existing tokenizer in src/lex.py; no new deps.",
            )
        ],
        _state=None,
    )

    store = json.loads(todos_file.read_text())
    task_1 = store["items"][0]
    assert task_1["instructions"] == (
        "Use the existing tokenizer in src/lex.py; no new deps."
    )
    assert task_1["result"] is None


@pytest.mark.asyncio
async def test_member_completion_records_result(
    tmp_sandbox: SandboxConfig, todos_file: Path
) -> None:
    """A member completing a claimed task stores the deliverable on the task."""
    await _todo_manage(
        actions=[
            CreateAction(
                action="create",
                content="Investigate flaky test",
                status="pending",
                priority="high",
                assigned_to="executor#1",
            )
        ],
        _state=None,
    )
    state = MockState(metadata={"agent_name": "executor#1"})
    await _todo_manage(
        actions=[ClaimAction(action="claim", task_id="task_1")],
        _state=state,
    )

    result = await _apply_actions(
        [
            MemberUpdateAction(
                action="update",
                task_id="task_1",
                status="completed",
                result="Root cause: unawaited fixture teardown. Fixed in commit abc123.",
            )
        ],
        _state=state,
        role="member",
    )

    store = json.loads(todos_file.read_text())
    task_1 = store["items"][0]
    assert task_1["status"] == "completed"
    assert task_1["result"].startswith("Root cause:")
    assert "task_1" in result


@pytest.mark.asyncio
async def test_read_shows_instructions_and_result(
    tmp_sandbox: SandboxConfig, todos_file: Path
) -> None:
    await _todo_manage(
        actions=[
            CreateAction(
                action="create",
                content="Write docs",
                status="pending",
                priority="low",
                instructions="Cover the new API only.",
            ),
            UpdateAction(
                action="update",
                task_id="task_1",
                status="completed",
                result="Docs written in docs/api.md.",
            ),
            ReadAction(action="read"),
        ],
        _state=None,
    )

    result = await _todo_manage(actions=[ReadAction(action="read")], _state=None)
    assert "Cover the new API only." in result
    assert "Docs written in docs/api.md." in result


@pytest.mark.asyncio
async def test_concurrent_agent_writes_are_not_clobbered(
    tmp_sandbox: SandboxConfig, todos_file: Path
) -> None:
    """A member's claim must survive a later write from the lead's run.

    Regression test for the per-run ``state.metadata["_todos"]`` cache: the
    lead's second call used its stale cached snapshot (taken before the
    member's claim) and wrote the whole store back, silently reverting the
    claim. The store must always be re-read from disk.
    """
    lead_state = MockState(metadata={"agent_name": "openagentd"})
    member_state = MockState(metadata={"agent_name": "executor#1"})

    # Lead creates two tasks (populates the lead run's view of the store).
    await _todo_manage(
        actions=[
            CreateAction(
                action="create",
                content="Member task",
                status="pending",
                priority="high",
                assigned_to="executor#1",
            ),
            CreateAction(
                action="create",
                content="Other task",
                status="pending",
                priority="medium",
            ),
        ],
        _state=lead_state,
    )

    # Member claims task_1 in its own concurrent run (separate state).
    await _todo_manage(
        actions=[ClaimAction(action="claim", task_id="task_1")],
        _state=member_state,
    )

    # Lead touches an unrelated task from its own run.
    await _todo_manage(
        actions=[
            UpdateAction(action="update", task_id="task_2", priority="low"),
        ],
        _state=lead_state,
    )

    # The member's claim survives the lead's write.
    store = json.loads(todos_file.read_text())
    task_1 = next(i for i in store["items"] if i["task_id"] == "task_1")
    assert task_1["claimed_by"] == "executor#1"
    assert task_1["status"] == "in_progress"


@pytest.mark.asyncio
async def test_claim_mutual_exclusion_across_runs(
    tmp_sandbox: SandboxConfig, todos_file: Path
) -> None:
    """Two members claiming the same task in separate runs: second is rejected."""
    lead_state = MockState(metadata={"agent_name": "openagentd"})
    await _todo_manage(
        actions=[
            CreateAction(
                action="create",
                content="Contested task",
                status="pending",
                priority="high",
            )
        ],
        _state=lead_state,
    )

    first = MockState(metadata={"agent_name": "executor#1"})
    second = MockState(metadata={"agent_name": "executor#2"})

    await _todo_manage(
        actions=[ClaimAction(action="claim", task_id="task_1")],
        _state=first,
    )
    result = await _todo_manage(
        actions=[ClaimAction(action="claim", task_id="task_1")],
        _state=second,
    )

    store = json.loads(todos_file.read_text())
    task_1 = next(i for i in store["items"] if i["task_id"] == "task_1")
    assert task_1["claimed_by"] == "executor#1"
    assert "executor#2" not in (result or "")


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

    assert "created task_1" in result

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


# ─────────────────────────────────────────────────────────────────────────────
# Test: lenient `actions` coercion (the recurring list_type failure)
# ─────────────────────────────────────────────────────────────────────────────


def test_actions_accepts_json_string() -> None:
    """A stringified actions array (some providers emit this) is parsed."""
    model = TodoArgs(actions='[{"action": "read"}]')
    assert len(model.actions) == 1
    assert isinstance(model.actions[0], ReadAction)


def test_actions_accepts_single_object() -> None:
    """A single action object is wrapped into a one-element list."""
    model = TodoArgs(
        actions={
            "action": "create",
            "content": "x",
            "status": "pending",
            "priority": "low",
        }
    )
    assert len(model.actions) == 1
    assert isinstance(model.actions[0], CreateAction)


def test_actions_string_still_validates_contents() -> None:
    """Coercion only reshapes the container — invalid actions still raise."""
    with pytest.raises(ValidationError):
        TodoArgs(actions='[{"action": "bogus"}]')


def test_member_actions_accepts_json_string() -> None:
    """Member schema gets the same lenient coercion."""
    model = TodoMemberArgs(actions='[{"action": "read"}]')
    assert len(model.actions) == 1
    assert isinstance(model.actions[0], ReadAction)


@pytest.mark.asyncio
async def test_todo_manage_arun_with_stringified_actions(
    tmp_sandbox: SandboxConfig, todos_file: Path
) -> None:
    """End-to-end: the live Tool validates a stringified actions arg via arun."""
    result = await todo_manage.arun(
        _injected={"_state": None},
        actions=(
            '[{"action": "create", "content": "From string", '
            '"status": "pending", "priority": "high"}]'
        ),
    )
    assert "created task_1" in result


# ─────────────────────────────────────────────────────────────────────────────
# Test: clear action (bulk-remove finished tasks)
# ─────────────────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_clear_finished_removes_completed_and_cancelled(
    tmp_sandbox: SandboxConfig, todos_file: Path
) -> None:
    await _todo_manage(
        actions=[
            CreateAction(
                action="create", content="done", status="completed", priority="low"
            ),
            CreateAction(
                action="create", content="dropped", status="cancelled", priority="low"
            ),
            CreateAction(
                action="create", content="active", status="pending", priority="high"
            ),
        ],
        _state=None,
    )

    result = await _todo_manage(
        actions=[ClearAction(action="clear"), ReadAction(action="read")], _state=None
    )

    assert "active" in result
    assert "done" not in result
    assert "dropped" not in result
    store = json.loads(todos_file.read_text())
    assert [i["content"] for i in store["items"]] == ["active"]


@pytest.mark.asyncio
async def test_clear_specific_status_keeps_the_other(
    tmp_sandbox: SandboxConfig, todos_file: Path
) -> None:
    await _todo_manage(
        actions=[
            CreateAction(
                action="create", content="done", status="completed", priority="low"
            ),
            CreateAction(
                action="create", content="dropped", status="cancelled", priority="low"
            ),
        ],
        _state=None,
    )

    result = await _todo_manage(
        actions=[
            ClearAction(action="clear", status="completed"),
            ReadAction(action="read"),
        ],
        _state=None,
    )

    assert "done" not in result
    assert "dropped" in result


@pytest.mark.asyncio
async def test_clear_preserves_in_progress(
    tmp_sandbox: SandboxConfig, todos_file: Path
) -> None:
    await _todo_manage(
        actions=[
            CreateAction(
                action="create",
                content="working",
                status="in_progress",
                priority="high",
            ),
            CreateAction(
                action="create", content="done", status="completed", priority="low"
            ),
        ],
        _state=None,
    )

    result = await _todo_manage(
        actions=[ClearAction(action="clear"), ReadAction(action="read")], _state=None
    )

    assert "working" in result
    assert "done" not in result


@pytest.mark.asyncio
async def test_batch_outcomes_are_consolidated_per_verb(
    tmp_sandbox: SandboxConfig, todos_file: Path
) -> None:
    """Same-verb outcomes collapse onto one line instead of repeating the verb."""
    await _todo_manage(
        actions=[
            CreateAction(
                action="create", content="a", status="pending", priority="low"
            ),
            CreateAction(
                action="create", content="b", status="pending", priority="low"
            ),
            CreateAction(
                action="create", content="c", status="pending", priority="low"
            ),
        ],
        _state=None,
    )

    result = await _todo_manage(
        actions=[
            UpdateAction(action="update", task_id="task_1", status="completed"),
            UpdateAction(action="update", task_id="task_2", status="completed"),
            DeleteAction(action="delete", task_id="task_3"),
            UpdateAction(action="update", task_id="task_99", status="completed"),
        ],
        _state=None,
    )

    lines = result.splitlines()
    assert "updated task_1, task_2" in lines
    assert "deleted task_3" in lines
    # Reasoned/failed outcomes stay on their own line
    assert "not_found task_99" in lines
    assert result.count("updated") == 1
