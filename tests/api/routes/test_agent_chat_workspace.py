"""Chat ("cockpit") workspace contract on the coding routes.

The chat root is surfaced as a pinned ``chat`` entry on the workspace tree and
is never stored as a repository, so its sessions group under that row while a
real workspace keeps upserting ``coding_workspaces`` rows as before.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlmodel import select

import app.core.db as _db
from app.models.chat import CodingWorkspace


@pytest.fixture
def chat_root(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    from app.core.config import settings

    root = tmp_path / "home"
    root.mkdir()
    monkeypatch.setattr(settings, "CHAT_WORKSPACE_DIR", str(root))
    return root


@pytest.fixture
def client() -> TestClient:
    from app.api.app import create_app

    return TestClient(create_app())


async def _workspace_rows() -> list[CodingWorkspace]:
    async with _db.async_session_factory() as db:
        return list((await db.exec(select(CodingWorkspace))).all())


def test_workspace_tree_exposes_the_pinned_chat_entry(
    client: TestClient, chat_root: Path
) -> None:
    response = client.get("/api/agent/workspace/tree")

    assert response.status_code == 200
    payload = response.json()
    assert payload["chat"] == {"path": str(chat_root.resolve()), "name": "Chat"}
    assert payload["repositories"] == []


@pytest.mark.asyncio
async def test_chat_session_resolves_without_creating_a_repository_row(
    client: TestClient, chat_root: Path
) -> None:
    response = client.post(
        "/api/agent/sessions/resolve", json={"workspace": str(chat_root)}
    )

    assert response.status_code == 200
    session = response.json()
    assert session["created"] is True
    assert session["workspace"] == str(chat_root.resolve())
    assert await _workspace_rows() == []


@pytest.mark.asyncio
async def test_chat_session_resolve_reuses_the_latest_session(
    client: TestClient, chat_root: Path
) -> None:
    first = client.post(
        "/api/agent/sessions/resolve", json={"workspace": str(chat_root)}
    ).json()

    second = client.post(
        "/api/agent/sessions/resolve", json={"workspace": str(chat_root)}
    ).json()

    assert second["id"] == first["id"]
    assert second["created"] is False


@pytest.mark.asyncio
async def test_repository_workspace_still_upserts_its_row(
    client: TestClient, tmp_path: Path, chat_root: Path
) -> None:
    repo = tmp_path / "repo"
    repo.mkdir()

    response = client.post("/api/agent/sessions/resolve", json={"workspace": str(repo)})
    assert response.status_code == 200

    tree = client.get("/api/agent/workspace/tree").json()
    assert [item["path"] for item in tree["repositories"]] == [str(repo.resolve())]
    assert [row.path for row in await _workspace_rows()] == [str(repo.resolve())]


@pytest.mark.asyncio
async def test_legacy_chat_root_repository_row_is_filtered_from_the_tree(
    client: TestClient, chat_root: Path
) -> None:
    """A home row persisted before the reservation must not duplicate the row."""
    async with _db.async_session_factory() as db:
        async with db.begin():
            db.add(
                CodingWorkspace(
                    path=str(chat_root.resolve()), kind="repo", name="someuser"
                )
            )

    tree = client.get("/api/agent/workspace/tree").json()

    assert tree["repositories"] == []
    assert tree["chat"] == {"path": str(chat_root.resolve()), "name": "Chat"}
