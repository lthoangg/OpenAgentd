"""Tests for :mod:`app.services.snapshot_maintenance`."""

from __future__ import annotations

import shutil
from pathlib import Path

import pytest
import pytest_asyncio
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlmodel import SQLModel
from sqlmodel.ext.asyncio.session import AsyncSession

from app.agent.schemas.chat import HumanMessage
from app.services import snapshot_service
from app.services.chat_service import create_chat_session, save_message
from app.services.snapshot_maintenance import (
    collect_keep_snapshots,
    sweep_snapshots,
)


pytestmark = pytest.mark.skipif(
    shutil.which("git") is None, reason="git binary not available"
)


@pytest_asyncio.fixture
async def engine():
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        await conn.run_sync(SQLModel.metadata.create_all)
    yield engine
    async with engine.begin() as conn:
        await conn.run_sync(SQLModel.metadata.drop_all)
    await engine.dispose()


@pytest_asyncio.fixture
async def session(engine):
    async_session = async_sessionmaker(
        engine, class_=AsyncSession, expire_on_commit=False
    )
    async with async_session() as session:
        yield session


@pytest.fixture
def state_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    from app.core.config import settings

    state = tmp_path / "state"
    state.mkdir(parents=True, exist_ok=True)
    monkeypatch.setattr(settings, "OPENAGENTD_STATE_DIR", str(state))
    return state


@pytest.fixture
def workspace(tmp_path: Path) -> Path:
    ws = tmp_path / "workspace"
    ws.mkdir()
    return ws


@pytest.mark.asyncio
async def test_sweep_keeps_referenced_snapshots_and_prunes_orphans(
    session: AsyncSession, state_dir: Path, workspace: Path
) -> None:
    chat = await create_chat_session(session, title="t", workspace=str(workspace))
    sid = str(chat.id)

    (workspace / "a.txt").write_text("v1")
    first = await snapshot_service.track(sid, workspace)
    (workspace / "a.txt").write_text("v2")
    second = await snapshot_service.track(sid, workspace)
    assert first and second

    await save_message(
        session, chat.id, HumanMessage(content="one", extra={"snapshot": first})
    )
    await save_message(
        session, chat.id, HumanMessage(content="two", extra={"snapshot": second})
    )
    await session.commit()

    # A snapshot no database row points at — the sweep must reclaim its ref.
    (workspace / "a.txt").write_text("v3")
    orphan = await snapshot_service.track(sid, workspace)
    assert orphan and orphan not in {first, second}

    result = await sweep_snapshots(session, max_bytes=None)

    assert result.sessions == 1
    refs = await snapshot_service._list_snapshot_refs(
        snapshot_service.snapshot_dir(sid)
    )
    assert set(refs) == {first, second}
    assert await snapshot_service.restore(sid, workspace, first)
    assert (workspace / "a.txt").read_text() == "v1"


@pytest.mark.asyncio
async def test_collect_keep_includes_redo_anchor(
    session: AsyncSession, state_dir: Path, workspace: Path
) -> None:
    chat = await create_chat_session(session, title="t", workspace=str(workspace))

    (workspace / "a.txt").write_text("v1")
    first = await snapshot_service.track(str(chat.id), workspace)
    assert first
    await save_message(
        session, chat.id, HumanMessage(content="one", extra={"snapshot": first})
    )
    chat.revert = {
        "message_id": "msg",
        "created_at": "2026-01-01T00:00:00+00:00",
        "snapshot": "anchor-tree",
    }
    session.add(chat)
    await session.commit()

    ordered, protected = await collect_keep_snapshots(session, chat.id)

    assert ordered == [first]
    assert protected == ["anchor-tree"]
