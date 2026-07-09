from __future__ import annotations

from datetime import datetime, timedelta, timezone
import os
import uuid

import pytest
from sqlalchemy.exc import OperationalError
from sqlmodel import select

from app.models.chat import ChatSession, SessionMessage
from app.services.artifact_cleanup import cleanup_generated_artifacts

pytestmark = pytest.mark.usefixtures("setup_db")


@pytest.mark.asyncio
async def test_cleanup_targets_orphaned_session_artifacts(tmp_path, monkeypatch):
    from app.core import db as core_db
    from app.core.config import settings

    monkeypatch.setattr(settings, "OPENAGENTD_DATA_DIR", str(tmp_path / "data"))
    old_session_id = str(uuid.uuid4())
    artifact_dir = tmp_path / "data" / "sessions" / old_session_id
    artifact_dir.mkdir(parents=True)
    (artifact_dir / ".todos.json").write_text("{}", encoding="utf-8")
    old_time = (datetime.now(timezone.utc) - timedelta(days=30)).timestamp()
    artifact_dir.touch()
    (artifact_dir / ".todos.json").touch()
    os.utime(artifact_dir, (old_time, old_time))
    os.utime(artifact_dir / ".todos.json", (old_time, old_time))

    async with core_db.async_session_factory() as session:
        result = await cleanup_generated_artifacts(
            session, older_than_days=7, dry_run=True
        )

    assert artifact_dir in [candidate.path for candidate in result.candidates]
    assert any(
        candidate.reason == "orphaned session artifacts"
        for candidate in result.candidates
    )


@pytest.mark.asyncio
async def test_cleanup_keeps_live_session_artifacts(tmp_path, monkeypatch):
    from app.core import db as core_db
    from app.core.config import settings

    monkeypatch.setattr(settings, "OPENAGENTD_DATA_DIR", str(tmp_path / "data"))
    live_id = uuid.uuid4()
    artifact_dir = tmp_path / "data" / "sessions" / str(live_id)
    artifact_dir.mkdir(parents=True)
    old_time = (datetime.now(timezone.utc) - timedelta(days=30)).timestamp()
    os.utime(artifact_dir, (old_time, old_time))

    async with core_db.async_session_factory() as session:
        session.add(ChatSession(id=live_id, agent_name="lead"))
        await session.commit()
        result = await cleanup_generated_artifacts(
            session, older_than_days=7, dry_run=True
        )

    assert artifact_dir not in [candidate.path for candidate in result.candidates]


@pytest.mark.asyncio
async def test_cleanup_falls_back_when_chat_sessions_query_fails(tmp_path, monkeypatch):
    from app.core import db as core_db
    from app.core.config import settings
    from app.services import artifact_cleanup as cleanup_mod

    monkeypatch.setattr(settings, "OPENAGENTD_DATA_DIR", str(tmp_path / "data"))
    monkeypatch.setattr(
        settings, "OPENAGENTD_WORKSPACE_DIR", str(tmp_path / "workspace")
    )
    monkeypatch.setattr(settings, "OPENAGENTD_STATE_DIR", str(tmp_path / "state"))

    orphan_id = str(uuid.uuid4())
    artifact_dir = tmp_path / "data" / "sessions" / orphan_id
    artifact_dir.mkdir(parents=True)
    snapshot_dir = tmp_path / "state" / "snapshot" / orphan_id
    snapshot_dir.mkdir(parents=True)
    worktree_dir = tmp_path / "data" / "worktrees" / "repo-abc" / "task-1"
    worktree_dir.mkdir(parents=True)
    old_time = (datetime.now(timezone.utc) - timedelta(days=30)).timestamp()
    for path in (artifact_dir, snapshot_dir, worktree_dir):
        os.utime(path, (old_time, old_time))

    orig_exec = core_db.AsyncSession.exec

    class _OrigExc(Exception):
        pass

    async def flaky_exec(self, statement, *args, **kwargs):
        if "chat_sessions" in str(statement):
            raise OperationalError(
                "SELECT chat_sessions.id FROM chat_sessions",
                {},
                _OrigExc("no such table: chat_sessions"),
            )
        return await orig_exec(self, statement, *args, **kwargs)

    monkeypatch.setattr(core_db.AsyncSession, "exec", flaky_exec)

    monkeypatch.setattr(
        cleanup_mod, "find_managed_worktree_source", lambda path: str(tmp_path / "repo")
    )

    async with core_db.async_session_factory() as session:
        result = await cleanup_mod.cleanup_generated_artifacts(
            session, older_than_days=7, dry_run=True
        )

    reasons = {candidate.reason for candidate in result.candidates}
    paths = {candidate.path for candidate in result.candidates}
    assert "orphaned session artifacts" in reasons
    assert "old session snapshots" in reasons
    assert "old managed git worktrees" in reasons
    assert artifact_dir in paths
    assert snapshot_dir in paths
    assert worktree_dir in paths


@pytest.mark.asyncio
async def test_cleanup_apply_deletes_old_normal_sessions_and_linked_storage(
    tmp_path, monkeypatch
):
    from app.core import db as core_db
    from app.core.config import settings

    monkeypatch.setattr(settings, "OPENAGENTD_DATA_DIR", str(tmp_path / "data"))
    monkeypatch.setattr(
        settings, "OPENAGENTD_WORKSPACE_DIR", str(tmp_path / "workspace")
    )
    monkeypatch.setattr(settings, "OPENAGENTD_STATE_DIR", str(tmp_path / "state"))

    old_id = uuid.uuid4()
    new_id = uuid.uuid4()
    old_workspace = tmp_path / "workspace" / str(old_id)
    new_workspace = tmp_path / "workspace" / str(new_id)
    old_artifacts = tmp_path / "data" / "sessions" / str(old_id)
    new_artifacts = tmp_path / "data" / "sessions" / str(new_id)
    old_snapshot = tmp_path / "state" / "snapshot" / str(old_id)
    new_snapshot = tmp_path / "state" / "snapshot" / str(new_id)
    for path in (
        old_workspace,
        new_workspace,
        old_artifacts,
        new_artifacts,
        old_snapshot,
        new_snapshot,
    ):
        path.mkdir(parents=True)

    old_time = datetime.now(timezone.utc) - timedelta(days=30)

    async with core_db.async_session_factory() as session:
        old_session = ChatSession(
            id=old_id,
            agent_name="lead",
            created_at=old_time,
            updated_at=old_time,
        )
        new_session = ChatSession(id=new_id, agent_name="lead")
        session.add(old_session)
        session.add(new_session)
        await session.flush()
        session.add(SessionMessage(session_id=old_id, role="user", content="old"))
        session.add(SessionMessage(session_id=new_id, role="user", content="new"))
        await session.commit()

        result = await cleanup_generated_artifacts(
            session, older_than_days=7, dry_run=False
        )

        remaining_sessions = (await session.exec(select(ChatSession))).all()
        remaining_messages = (await session.exec(select(SessionMessage))).all()

    deleted_paths = set(result.deleted)
    assert old_workspace in deleted_paths
    assert old_artifacts in deleted_paths
    assert old_snapshot in deleted_paths
    assert not old_workspace.exists()
    assert not old_artifacts.exists()
    assert not old_snapshot.exists()
    assert new_workspace.exists()
    assert new_artifacts.exists()
    assert new_snapshot.exists()
    assert [row.id for row in remaining_sessions] == [new_id]
    assert [row.session_id for row in remaining_messages] == [new_id]


@pytest.mark.asyncio
async def test_cleanup_keeps_old_coding_sessions_and_worktrees(tmp_path, monkeypatch):
    from app.core import db as core_db
    from app.core.config import settings
    from app.services import artifact_cleanup as cleanup_mod

    monkeypatch.setattr(settings, "OPENAGENTD_DATA_DIR", str(tmp_path / "data"))
    monkeypatch.setattr(settings, "OPENAGENTD_STATE_DIR", str(tmp_path / "state"))

    coding_id = uuid.uuid4()
    worktree_dir = tmp_path / "data" / "worktrees" / "repo-abc" / "task-1"
    snapshot_dir = tmp_path / "state" / "snapshot" / str(coding_id)
    artifact_dir = tmp_path / "data" / "sessions" / str(coding_id)
    for path in (worktree_dir, snapshot_dir, artifact_dir):
        path.mkdir(parents=True)
    old_time = datetime.now(timezone.utc) - timedelta(days=30)

    async with core_db.async_session_factory() as session:
        session.add(
            ChatSession(
                id=coding_id,
                agent_name="lead",
                mode="coding",
                workspace=str(worktree_dir),
                created_at=old_time,
                updated_at=old_time,
            )
        )
        await session.commit()

        monkeypatch.setattr(
            cleanup_mod,
            "find_managed_worktree_source",
            lambda path: str(tmp_path / "repo") if path == worktree_dir else None,
        )
        result = await cleanup_mod.cleanup_generated_artifacts(
            session, older_than_days=7, dry_run=True
        )

    paths = {candidate.path for candidate in result.candidates}
    assert worktree_dir not in paths
    assert artifact_dir not in paths
    assert snapshot_dir not in paths


@pytest.mark.asyncio
async def test_cleanup_dry_run_reports_expired_db_rows_without_paths(
    tmp_path, monkeypatch
):
    from app.core import db as core_db
    from app.core.config import settings

    monkeypatch.setattr(settings, "OPENAGENTD_DATA_DIR", str(tmp_path / "data"))
    monkeypatch.setattr(
        settings, "OPENAGENTD_WORKSPACE_DIR", str(tmp_path / "workspace")
    )
    monkeypatch.setattr(settings, "OPENAGENTD_STATE_DIR", str(tmp_path / "state"))

    old_id = uuid.uuid4()
    old_time = datetime.now(timezone.utc) - timedelta(days=30)

    async with core_db.async_session_factory() as session:
        session.add(
            ChatSession(
                id=old_id,
                agent_name="lead",
                created_at=old_time,
                updated_at=old_time,
            )
        )
        await session.flush()
        session.add(SessionMessage(session_id=old_id, role="user", content="old"))
        session.add(
            SessionMessage(session_id=old_id, role="assistant", content="reply")
        )
        await session.commit()

        result = await cleanup_generated_artifacts(
            session, older_than_days=7, dry_run=True
        )

    assert result.expired_sessions == 1
    assert result.expired_messages == 2
    assert result.candidates == []
