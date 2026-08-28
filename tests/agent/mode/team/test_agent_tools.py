from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch
from uuid import UUID

import pytest_asyncio
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlmodel import SQLModel
from sqlmodel.ext.asyncio.session import AsyncSession

from app.models.chat import ChatSession, CodingWorkspace
from app.agent.schemas.chat import AssistantMessage
from app.services.chat_service import get_messages, save_message
from app.agent.mode.team.agent_tools import (
    make_agent_list_tool,
    make_agent_merge_tool,
    make_agent_send_tool,
    make_agent_spawn_tool,
    make_agent_stop_tool,
)
from app.services.agent_spawn_service import SpawnResult
from app.services.worktree_service import MergeResult


@pytest_asyncio.fixture
async def db_factory():
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        await conn.run_sync(SQLModel.metadata.create_all)
    factory = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    yield factory
    async with engine.begin() as conn:
        await conn.run_sync(SQLModel.metadata.drop_all)
    await engine.dispose()


def _make_fake_runtime(workspace: str = "/tmp/repo", session_id: str = "sess-123"):
    """The slice of ``SessionRuntime`` the delegation tools read.

    ``db_factory`` is set explicitly because the tools pass it straight through
    to the spawn service — a bare ``MagicMock`` would silently hand them an
    auto-created attribute instead of ``None``.
    """
    runtime = MagicMock()
    runtime.workspace = workspace
    runtime.name = "openagentd"
    runtime.session_id = session_id
    runtime.db_factory = None
    return runtime


async def test_agent_spawn_tool():
    runtime = _make_fake_runtime()
    tool = make_agent_spawn_tool(runtime)

    fake_result = SpawnResult(
        session_id="child-456",
        worktree="/tmp/worktree/task",
        branch="agent/task",
        name="agent-task",
    )

    with patch(
        "app.agent.mode.team.agent_tools.spawn_agent_session",
        AsyncMock(return_value=fake_result),
    ) as mock_spawn:
        res = await tool.arun(
            task="explore auth", name="auth-explorer", _workspace="/tmp/repo"
        )
        data = json.loads(res)
        assert data["status"] == "spawned"
        assert data["session_id"] == "child-456"
        assert data["branch"] == "agent/task"
        mock_spawn.assert_awaited_once_with(
            parent_session_id="sess-123",
            parent_workspace="/tmp/repo",
            task="explore auth",
            name="auth-explorer",
            db_factory=None,
        )


async def test_agent_send_tool():
    runtime = _make_fake_runtime()
    tool = make_agent_send_tool(runtime)

    with patch(
        "app.agent.mode.team.agent_tools.send_agent_message", AsyncMock()
    ) as mock_send:
        res = await tool.arun(session_id="child-456", content="hello child")
        assert "successfully sent" in res
        mock_send.assert_awaited_once_with(
            sender_session_id="sess-123",
            target_session_id="child-456",
            sender_name="openagentd",
            content="hello child",
            db_factory=None,
        )


async def test_agent_list_tool_excludes_legacy_member_sessions(db_factory):
    runtime = _make_fake_runtime()
    tool = make_agent_list_tool(runtime, db_factory=db_factory)

    async with db_factory() as db:
        async with db.begin():
            parent = ChatSession(mode="coding", workspace="/tmp/repo", title="Parent")
            db.add(parent)
            await db.flush()
            runtime.session_id = str(parent.id)

            db.add(
                ChatSession(
                    mode="coding",
                    workspace="/tmp/repo",
                    title="Legacy member",
                    parent_session_id=parent.id,
                )
            )
            child = ChatSession(
                mode="coding",
                workspace="/tmp/repo/wt",
                title="Agent: explorer",
                parent_session_id=parent.id,
            )
            db.add(child)
            db.add(
                CodingWorkspace(
                    path="/tmp/repo/wt",
                    kind="worktree",
                    source_path="/tmp/repo",
                    managed=True,
                )
            )
            await db.flush()
            child_id = str(child.id)

    with patch(
        "app.agent.mode.team.agent_tools.current_managed_worktree_branch",
        AsyncMock(return_value="agent/explorer"),
    ):
        res = await tool.arun()
    data = json.loads(res)
    assert len(data) == 1
    assert data[0]["session_id"] == child_id
    assert data[0]["name"] == "Agent: explorer"
    assert data[0]["branch"] == "agent/explorer"


async def test_agent_stop_tool(db_factory):
    runtime = _make_fake_runtime()
    tool = make_agent_stop_tool(runtime, db_factory=db_factory)

    async with db_factory() as db:
        async with db.begin():
            parent = ChatSession(mode="coding", workspace="/tmp/repo", title="Parent")
            db.add(parent)
            await db.flush()
            runtime.session_id = str(parent.id)

            child = ChatSession(
                mode="coding",
                workspace="/tmp/repo/wt",
                title="Agent: explorer",
                parent_session_id=parent.id,
            )
            db.add(child)
            await db.flush()
            child_id = str(child.id)

    fake_child_runtime = MagicMock()
    with (
        patch(
            "app.services.team_manager.find_live_team_serving_session",
            return_value=fake_child_runtime,
        ),
        patch(
            "app.services.agent_service.interrupt_team", AsyncMock()
        ) as mock_interrupt,
    ):
        res = await tool.arun(session_id=child_id)
        assert "was stopped" in res
        mock_interrupt.assert_awaited_once_with(fake_child_runtime, child_id)


async def test_agent_merge_tool():
    runtime = _make_fake_runtime(workspace="/tmp/worktree/task")
    tool = make_agent_merge_tool(runtime)

    merge_result = MergeResult(
        status="merged",
        detail="Successfully merged branch",
        source_branch="main",
    )

    with patch(
        "app.agent.mode.team.agent_tools.merge_worktree_to_source",
        AsyncMock(return_value=merge_result),
    ) as mock_merge:
        res = await tool.arun(delete_on_success=True, _workspace="/tmp/worktree/task")
        data = json.loads(res)
        assert data["status"] == "merged"
        assert data["source_branch"] == "main"
        mock_merge.assert_awaited_once_with(
            worktree="/tmp/worktree/task",
            delete_on_success=True,
            db_factory=None,
        )


async def test_end_to_end_spawn_and_report_delivery(
    tmp_path: Path, db_factory, monkeypatch
):
    import subprocess

    repo = tmp_path / "repo"
    repo.mkdir()
    subprocess.run(["git", "-C", str(repo), "init"], check=True)
    subprocess.run(
        ["git", "-C", str(repo), "config", "user.email", "t@e.com"], check=True
    )
    subprocess.run(["git", "-C", str(repo), "config", "user.name", "T"], check=True)
    (repo / "README.md").write_text("initial\n", encoding="utf-8")
    subprocess.run(["git", "-C", str(repo), "add", "README.md"], check=True)
    subprocess.run(["git", "-C", str(repo), "commit", "-m", "init"], check=True)

    data_dir = tmp_path / "data"
    monkeypatch.setattr(
        "app.services.worktree_service.settings.OPENAGENTD_DATA_DIR", str(data_dir)
    )

    # Create parent session
    async with db_factory() as db:
        async with db.begin():
            parent = ChatSession(
                mode="coding", workspace=str(repo), title="Parent Task"
            )
            db.add(parent)
            await db.flush()
            parent_id = str(parent.id)

    parent_runtime = _make_fake_runtime(workspace=str(repo), session_id=parent_id)
    parent_runtime.state = "idle"
    parent_runtime.db_factory = db_factory
    parent_runtime._has_open_question = AsyncMock(return_value=False)
    parent_runtime.deliver = AsyncMock()

    from app.services import team_manager

    team_manager._coding_teams[(str(repo), parent_id)] = parent_runtime

    # 1. Parent spawns child
    spawn_tool = make_agent_spawn_tool(parent_runtime)

    fake_child_runtime = _make_fake_runtime()
    with (
        patch(
            "app.services.team_manager.get_or_start_coding_team",
            AsyncMock(return_value=fake_child_runtime),
        ),
        patch("app.services.agent_service.dispatch_user_message", AsyncMock()),
    ):
        spawn_raw = await spawn_tool.arun(
            task="explore tests", name="test-explorer", _workspace=str(repo)
        )
        spawn_data = json.loads(spawn_raw)
        child_id = spawn_data["session_id"]

    # 2. Child runs and produces a final assistant message
    async with db_factory() as db:
        async with db.begin():
            await save_message(
                db,
                UUID(child_id),
                AssistantMessage(content="Exploration complete: found 12 test files."),
            )

    # 3. Child turn completes -> deliver report
    await team_manager.deliver_agent_report(
        parent_session_id=parent_id,
        child_session_id=child_id,
        child_name="test-explorer",
        content="Exploration complete: found 12 test files.",
        db_factory=db_factory,
    )

    # 4. Assert report was delivered into parent session
    parent_runtime.deliver.assert_awaited_once()
    (delivered,), _ = parent_runtime.deliver.call_args
    assert delivered.content == "Exploration complete: found 12 test files."
    assert delivered.from_agent == "test-explorer"

    async with db_factory() as db:
        parent_msgs = await get_messages(db, UUID(parent_id))
        assert any("found 12 test files" in m.content for m in parent_msgs)
