from __future__ import annotations

import subprocess
from pathlib import Path
from unittest.mock import AsyncMock, patch
from uuid import UUID

import pytest
import pytest_asyncio
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlmodel import SQLModel, select
from sqlmodel.ext.asyncio.session import AsyncSession

from app.models.chat import ChatSession
from app.services.agent_spawn_service import (
    MAX_CONCURRENT_CHILDREN,
    MaxConcurrentChildrenError,
    MaxSpawnDepthError,
    compute_spawn_depth,
    send_agent_message,
    spawn_agent_session,
)
from app.services.worktree_service import NonGitWorkspaceError


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


def _git(cwd: Path, *args: str) -> None:
    subprocess.run(
        ["git", "-C", str(cwd), *args], check=True, capture_output=True, text=True
    )


def _repo(tmp_path: Path) -> Path:
    repo = tmp_path / "repo"
    repo.mkdir(exist_ok=True)
    _git(repo, "init")
    _git(repo, "config", "user.email", "test@example.com")
    _git(repo, "config", "user.name", "Test User")
    (repo / "README.md").write_text("hello\n", encoding="utf-8")
    _git(repo, "add", "README.md")
    _git(repo, "commit", "-m", "init")
    return repo


async def test_spawn_agent_session_creates_worktree_and_dispatches(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, db_factory
) -> None:
    repo = _repo(tmp_path)
    data_dir = tmp_path / "data"
    monkeypatch.setattr(
        "app.services.worktree_service.settings.OPENAGENTD_DATA_DIR",
        str(data_dir),
    )

    async with db_factory() as db:
        async with db.begin():
            parent = ChatSession(mode="coding", workspace=str(repo), title="Parent")
            db.add(parent)
            await db.flush()
            parent_id = str(parent.id)

    fake_runtime = AsyncMock()
    fake_runtime.name = "openagentd"
    fake_runtime.session_id = parent_id

    with (
        patch(
            "app.services.team_manager.get_or_start_coding_team",
            AsyncMock(return_value=fake_runtime),
        ) as mock_get_team,
        patch(
            "app.services.agent_service.dispatch_user_message",
            AsyncMock(),
        ) as mock_dispatch,
    ):
        result = await spawn_agent_session(
            parent_session_id=parent_id,
            parent_workspace=str(repo),
            task="explore auth subsystem",
            name="auth-explorer",
            db_factory=db_factory,
        )

        assert result.session_id is not None
        assert "agent-auth-explorer" in result.worktree
        assert result.branch == "agent/auth-explorer"
        assert result.name == "agent-auth-explorer"

        mock_get_team.assert_awaited_once()
        mock_dispatch.assert_awaited_once()
        _, kwargs = mock_dispatch.call_args
        assert kwargs["origin"] == "agent"
        assert "explore auth subsystem" in kwargs["content"]
        assert "[Spawn Context]" in kwargs["content"]

        async with db_factory() as db:
            child = await db.get(ChatSession, UUID(result.session_id))
            assert child is not None
            assert child.parent_session_id == UUID(parent_id)
            assert child.workspace == result.worktree


async def test_spawn_agent_session_refuses_non_git(tmp_path: Path, db_factory) -> None:
    non_git = tmp_path / "not_a_git_repo"
    non_git.mkdir()

    async with db_factory() as db:
        async with db.begin():
            parent = ChatSession(mode="coding", workspace=str(non_git), title="Parent")
            db.add(parent)
            await db.flush()
            parent_id = str(parent.id)

    with pytest.raises(NonGitWorkspaceError):
        await spawn_agent_session(
            parent_session_id=parent_id,
            parent_workspace=str(non_git),
            task="do something",
            db_factory=db_factory,
        )


async def test_compute_spawn_depth_and_depth_cap(tmp_path: Path, db_factory) -> None:
    repo = _repo(tmp_path)

    async with db_factory() as db:
        async with db.begin():
            root = ChatSession(mode="coding", workspace=str(repo), title="Root")
            db.add(root)
            await db.flush()

            child1 = ChatSession(
                mode="coding",
                workspace=str(repo),
                title="Child 1",
                parent_session_id=root.id,
            )
            db.add(child1)
            await db.flush()

            child2 = ChatSession(
                mode="coding",
                workspace=str(repo),
                title="Child 2",
                parent_session_id=child1.id,
            )
            db.add(child2)
            await db.flush()

            assert await compute_spawn_depth(db, root.id) == 0
            assert await compute_spawn_depth(db, child1.id) == 1
            assert await compute_spawn_depth(db, child2.id) == 2

    with pytest.raises(MaxSpawnDepthError):
        await spawn_agent_session(
            parent_session_id=str(child2.id),
            parent_workspace=str(repo),
            task="exceed depth limit",
            db_factory=db_factory,
        )


async def test_concurrency_cap(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, db_factory
) -> None:
    repo = _repo(tmp_path)
    data_dir = tmp_path / "data"
    monkeypatch.setattr(
        "app.services.worktree_service.settings.OPENAGENTD_DATA_DIR",
        str(data_dir),
    )

    async with db_factory() as db:
        async with db.begin():
            parent = ChatSession(mode="coding", workspace=str(repo), title="Parent")
            db.add(parent)
            await db.flush()
            parent_id = str(parent.id)

            for i in range(MAX_CONCURRENT_CHILDREN):
                child = ChatSession(
                    mode="coding",
                    workspace=str(repo),
                    title=f"Child {i}",
                    parent_session_id=parent.id,
                )
                db.add(child)

    # Mock all 5 children as active
    fake_runtime = AsyncMock()
    fake_runtime.state = "working"
    with (
        patch(
            "app.services.team_manager.find_live_team_serving_session",
            return_value=fake_runtime,
        ),
        pytest.raises(MaxConcurrentChildrenError),
    ):
        await spawn_agent_session(
            parent_session_id=parent_id,
            parent_workspace=str(repo),
            task="exceed concurrency limit",
            db_factory=db_factory,
        )


async def test_send_agent_message_family_validation(tmp_path: Path, db_factory) -> None:
    repo = _repo(tmp_path)

    async with db_factory() as db:
        async with db.begin():
            parent = ChatSession(mode="coding", workspace=str(repo), title="Parent")
            db.add(parent)
            await db.flush()

            child = ChatSession(
                mode="coding",
                workspace=str(repo),
                title="Child",
                parent_session_id=parent.id,
            )
            db.add(child)
            await db.flush()

            unrelated = ChatSession(
                mode="coding",
                workspace=str(repo),
                title="Unrelated",
            )
            db.add(unrelated)
            await db.flush()

            parent_id = str(parent.id)
            child_id = str(child.id)
            unrelated_id = str(unrelated.id)

    with patch(
        "app.services.team_manager.deliver_agent_report", AsyncMock()
    ) as mock_deliver:
        # Parent to Child -> allowed
        await send_agent_message(
            sender_session_id=parent_id,
            target_session_id=child_id,
            sender_name="lead",
            content="Follow up from parent",
            db_factory=db_factory,
        )
        mock_deliver.assert_awaited_once()

        mock_deliver.reset_mock()
        # Child to Parent -> allowed
        await send_agent_message(
            sender_session_id=child_id,
            target_session_id=parent_id,
            sender_name="explorer",
            content="Progress update from child",
            db_factory=db_factory,
        )
        mock_deliver.assert_awaited_once()

        # Unrelated session -> raises PermissionError
        with pytest.raises(PermissionError):
            await send_agent_message(
                sender_session_id=unrelated_id,
                target_session_id=child_id,
                sender_name="intruder",
                content="Sneaky message",
                db_factory=db_factory,
            )


async def test_spawn_dispatch_failure_removes_child_session_and_worktree(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, db_factory
) -> None:
    repo = _repo(tmp_path)
    data_dir = tmp_path / "data"
    monkeypatch.setattr(
        "app.services.worktree_service.settings.OPENAGENTD_DATA_DIR",
        str(data_dir),
    )
    async with db_factory() as db:
        async with db.begin():
            parent = ChatSession(mode="coding", workspace=str(repo), title="Parent")
            db.add(parent)
            await db.flush()
            parent_id = str(parent.id)

    with (
        patch(
            "app.services.team_manager.get_or_start_coding_team",
            AsyncMock(return_value=AsyncMock()),
        ),
        patch(
            "app.services.agent_service.dispatch_user_message",
            AsyncMock(side_effect=RuntimeError("dispatch failed")),
        ),
        pytest.raises(RuntimeError, match="dispatch failed"),
    ):
        await spawn_agent_session(
            parent_session_id=parent_id,
            parent_workspace=str(repo),
            task="explore auth",
            db_factory=db_factory,
        )

    async with db_factory() as db:
        children = (
            await db.exec(
                select(ChatSession).where(
                    ChatSession.parent_session_id == UUID(parent_id)
                )
            )
        ).all()
    assert children == []
    assert list((data_dir / "worktrees").rglob("agent-explore-auth")) == []
