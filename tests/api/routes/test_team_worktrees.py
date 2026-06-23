from __future__ import annotations

import hashlib
import subprocess
from pathlib import Path

from unittest.mock import AsyncMock, patch

from fastapi.testclient import TestClient
import pytest

from app.api.routes.team.worktrees import find_managed_worktree_source


@pytest.fixture
def app_without_team():
    from app.api.app import create_app
    from app.services.team_manager import set_team

    app = create_app()
    set_team(None)
    yield app
    set_team(None)


def _git(cwd, *args: str) -> None:
    subprocess.run(
        ["git", "-C", str(cwd), *args], check=True, capture_output=True, text=True
    )


def _repo(tmp_path):
    repo = tmp_path / "repo"
    repo.mkdir()
    _git(repo, "init")
    _git(repo, "config", "user.email", "test@example.com")
    _git(repo, "config", "user.name", "Test User")
    (repo / "README.md").write_text("hello\n", encoding="utf-8")
    _git(repo, "add", "README.md")
    _git(repo, "commit", "-m", "init")
    return repo


def test_create_worktree_returns_directory_and_branch(
    app_without_team, tmp_path, monkeypatch
):
    repo = _repo(tmp_path)
    data_dir = tmp_path / "data"
    monkeypatch.setattr(
        "app.api.routes.team.worktrees.settings.OPENAGENTD_DATA_DIR",
        str(data_dir),
    )
    client = TestClient(app_without_team)

    resp = client.post(
        "/api/team/workspace/worktrees",
        json={"source_workspace": str(repo), "name": "Feature Login"},
    )

    assert resp.status_code == 200
    body = resp.json()
    assert body["name"] == "feature-login"
    assert body["branch"] == "openagentd/feature-login"
    assert body["source_workspace"] == str(repo.resolve())
    root = f"repo-{hashlib.sha1(str(repo.resolve()).encode('utf-8')).hexdigest()[:10]}"
    assert body["directory"].startswith(str(data_dir / "worktrees" / root))
    assert (
        tmp_path / "data" / "worktrees" / root / "feature-login" / "README.md"
    ).read_text(encoding="utf-8") == "hello\n"


def test_find_managed_worktree_source_detects_openagentd_worktree(
    app_without_team, tmp_path, monkeypatch
):
    repo = _repo(tmp_path)
    data_dir = tmp_path / "data"
    monkeypatch.setattr(
        "app.api.routes.team.worktrees.settings.OPENAGENTD_DATA_DIR",
        str(data_dir),
    )
    client = TestClient(app_without_team)
    created = client.post(
        "/api/team/workspace/worktrees",
        json={"source_workspace": str(repo), "name": "Task"},
    ).json()

    assert find_managed_worktree_source(Path(created["directory"])) == str(
        repo.resolve()
    )


def test_list_worktrees_excludes_primary(app_without_team, tmp_path, monkeypatch):
    repo = _repo(tmp_path)
    data_dir = tmp_path / "data"
    monkeypatch.setattr(
        "app.api.routes.team.worktrees.settings.OPENAGENTD_DATA_DIR",
        str(data_dir),
    )
    client = TestClient(app_without_team)
    created = client.post(
        "/api/team/workspace/worktrees",
        json={"source_workspace": str(repo), "name": "Task"},
    ).json()

    resp = client.get(
        "/api/team/workspace/worktrees",
        params={"source_workspace": str(repo)},
    )

    assert resp.status_code == 200
    assert resp.json() == [
        {
            "name": "task",
            "directory": created["directory"],
            "branch": "openagentd/task",
            "managed": True,
        }
    ]


def test_rename_worktree_updates_sidebar_title(app_without_team, tmp_path, monkeypatch):
    repo = _repo(tmp_path)
    data_dir = tmp_path / "data"
    monkeypatch.setattr(
        "app.api.routes.team.worktrees.settings.OPENAGENTD_DATA_DIR",
        str(data_dir),
    )
    client = TestClient(app_without_team)
    created = client.post(
        "/api/team/workspace/worktrees",
        json={"source_workspace": str(repo), "name": "Task"},
    ).json()

    resp = client.patch(
        "/api/team/workspace/worktrees",
        json={"directory": created["directory"], "name": "Review UI"},
    )

    assert resp.status_code == 200
    assert resp.json()["name"] == "Review UI"
    tree = client.get("/api/team/workspace/tree")
    assert tree.status_code == 200
    assert tree.json()["repositories"][0]["worktrees"][0]["name"] == "Review UI"


def test_create_worktree_rejects_non_git_workspace(app_without_team, tmp_path):
    client = TestClient(app_without_team)

    resp = client.post(
        "/api/team/workspace/worktrees",
        json={"source_workspace": str(tmp_path), "name": "task"},
    )

    assert resp.status_code == 422
    assert "git" in resp.json()["detail"].lower()


def test_create_worktree_rejects_invalid_branch(app_without_team, tmp_path):
    repo = _repo(tmp_path)
    client = TestClient(app_without_team)

    resp = client.post(
        "/api/team/workspace/worktrees",
        json={
            "source_workspace": str(repo),
            "name": "task",
            "branch": "bad..branch",
        },
    )

    assert resp.status_code == 422
    assert "branch" in resp.json()["detail"].lower()


def test_remove_managed_worktree(app_without_team, tmp_path, monkeypatch):
    repo = _repo(tmp_path)
    data_dir = tmp_path / "data"
    monkeypatch.setattr(
        "app.api.routes.team.worktrees.settings.OPENAGENTD_DATA_DIR",
        str(data_dir),
    )
    client = TestClient(app_without_team)
    created = client.post(
        "/api/team/workspace/worktrees",
        json={"source_workspace": str(repo), "name": "remove-me"},
    ).json()

    resp = client.request(
        "DELETE",
        "/api/team/workspace/worktrees",
        json={"source_workspace": str(repo), "directory": created["directory"]},
    )

    assert resp.status_code == 200
    assert resp.json() == {"removed": True}
    assert not Path(created["directory"]).exists()


def test_remove_managed_worktree_keeps_user_branch(
    app_without_team, tmp_path, monkeypatch
):
    repo = _repo(tmp_path)
    data_dir = tmp_path / "data"
    monkeypatch.setattr(
        "app.api.routes.team.worktrees.settings.OPENAGENTD_DATA_DIR",
        str(data_dir),
    )
    client = TestClient(app_without_team)
    created = client.post(
        "/api/team/workspace/worktrees",
        json={
            "source_workspace": str(repo),
            "name": "remove-user-branch",
            "branch": "user/remove-branch",
        },
    ).json()

    resp = client.request(
        "DELETE",
        "/api/team/workspace/worktrees",
        json={"source_workspace": str(repo), "directory": created["directory"]},
    )

    assert resp.status_code == 200
    subprocess.run(
        [
            "git",
            "-C",
            str(repo),
            "show-ref",
            "--verify",
            "--quiet",
            "refs/heads/user/remove-branch",
        ],
        check=True,
    )


def test_remove_managed_worktree_deletes_openagentd_branch(
    app_without_team, tmp_path, monkeypatch
):
    repo = _repo(tmp_path)
    data_dir = tmp_path / "data"
    monkeypatch.setattr(
        "app.api.routes.team.worktrees.settings.OPENAGENTD_DATA_DIR",
        str(data_dir),
    )
    client = TestClient(app_without_team)
    created = client.post(
        "/api/team/workspace/worktrees",
        json={"source_workspace": str(repo), "name": "remove-branch"},
    ).json()

    resp = client.request(
        "DELETE",
        "/api/team/workspace/worktrees",
        json={"source_workspace": str(repo), "directory": created["directory"]},
    )

    assert resp.status_code == 200
    result = subprocess.run(
        [
            "git",
            "-C",
            str(repo),
            "show-ref",
            "--verify",
            "--quiet",
            "refs/heads/openagentd/remove-branch",
        ],
        check=False,
    )
    assert result.returncode != 0


def test_remove_managed_worktree_deletes_registry_entry(
    app_without_team, tmp_path, monkeypatch
):
    from app.core.db import async_session_factory
    from app.models.chat import ChatSession

    repo = _repo(tmp_path)
    data_dir = tmp_path / "data"
    monkeypatch.setattr(
        "app.api.routes.team.worktrees.settings.OPENAGENTD_DATA_DIR",
        str(data_dir),
    )
    client = TestClient(app_without_team)
    created = client.post(
        "/api/team/workspace/worktrees",
        json={"source_workspace": str(repo), "name": "remove-session"},
    ).json()

    async def create_session() -> None:
        async with async_session_factory() as db:
            async with db.begin():
                db.add(ChatSession(mode="coding", workspace=created["directory"]))

    import asyncio

    asyncio.run(create_session())

    resp = client.request(
        "DELETE",
        "/api/team/workspace/worktrees",
        json={"source_workspace": str(repo), "directory": created["directory"]},
    )

    assert resp.status_code == 200
    tree = client.get("/api/team/workspace/tree")
    assert tree.status_code == 200
    repositories = tree.json()["repositories"]
    assert all(
        worktree["path"] != created["directory"]
        for repository in repositories
        for worktree in repository["worktrees"]
    )


def test_remove_missing_managed_worktree_cleans_registry(
    app_without_team, tmp_path, monkeypatch
):
    from app.core.db import async_session_factory
    from app.models.chat import CodingWorkspace

    repo = _repo(tmp_path)
    data_dir = tmp_path / "data"
    directory = (
        data_dir
        / "worktrees"
        / f"repo-{hashlib.sha1(str(repo.resolve()).encode('utf-8')).hexdigest()[:10]}"
        / "missing"
    )
    monkeypatch.setattr(
        "app.api.routes.team.worktrees.settings.OPENAGENTD_DATA_DIR",
        str(data_dir),
    )

    async def create_registry_row() -> None:
        async with async_session_factory() as db:
            async with db.begin():
                db.add(
                    CodingWorkspace(
                        path=str(repo.resolve()),
                        kind="repo",
                        name="repo",
                    )
                )
                db.add(
                    CodingWorkspace(
                        path=str(directory),
                        kind="worktree",
                        source_path=str(repo.resolve()),
                        name="missing",
                        managed=True,
                    )
                )

    import asyncio

    asyncio.run(create_registry_row())
    client = TestClient(app_without_team)
    resp = client.request(
        "DELETE",
        "/api/team/workspace/worktrees",
        json={"source_workspace": str(repo), "directory": str(directory)},
    )

    assert resp.status_code == 200
    assert resp.json() == {"removed": True}
    tree = client.get("/api/team/workspace/tree")
    assert tree.status_code == 200
    assert tree.json()["repositories"] == [
        {"path": str(repo.resolve()), "name": "repo", "worktrees": []}
    ]


def test_find_managed_worktree_source_does_not_create_root(
    app_without_team, tmp_path, monkeypatch
):
    repo = _repo(tmp_path)
    data_dir = tmp_path / "data"
    unmanaged = tmp_path / "unmanaged"
    root = (
        data_dir
        / "worktrees"
        / f"repo-{hashlib.sha1(str(repo.resolve()).encode('utf-8')).hexdigest()[:10]}"
    )
    monkeypatch.setattr(
        "app.api.routes.team.worktrees.settings.OPENAGENTD_DATA_DIR",
        str(data_dir),
    )
    _git(repo, "worktree", "add", "-b", "unmanaged-no-root", str(unmanaged))

    assert find_managed_worktree_source(unmanaged) is None
    assert not root.exists()


def test_find_managed_worktree_source_rejects_external_worktree(
    app_without_team, tmp_path, monkeypatch
):
    repo = _repo(tmp_path)
    data_dir = tmp_path / "data"
    unmanaged = tmp_path / "unmanaged"
    monkeypatch.setattr(
        "app.api.routes.team.worktrees.settings.OPENAGENTD_DATA_DIR",
        str(data_dir),
    )
    _git(repo, "worktree", "add", "-b", "unmanaged-detect", str(unmanaged))

    assert find_managed_worktree_source(unmanaged) is None


def test_remove_rejects_unmanaged_worktree(app_without_team, tmp_path):
    repo = _repo(tmp_path)
    unmanaged = tmp_path / "unmanaged"
    _git(repo, "worktree", "add", "-b", "unmanaged", str(unmanaged))
    client = TestClient(app_without_team)

    resp = client.request(
        "DELETE",
        "/api/team/workspace/worktrees",
        json={"source_workspace": str(repo), "directory": str(unmanaged)},
    )

    assert resp.status_code == 403


def test_resolve_validates_model_before_creating_worktree(
    app_without_team, tmp_path, monkeypatch
):
    repo = _repo(tmp_path)
    data_dir = tmp_path / "data"
    monkeypatch.setattr(
        "app.api.routes.team.worktrees.settings.OPENAGENTD_DATA_DIR",
        str(data_dir),
    )
    client = TestClient(app_without_team)

    with patch(
        "app.api.routes.team.chat.is_registered_model_id",
        AsyncMock(return_value=False),
    ):
        resp = client.post(
            "/api/team/sessions/resolve",
            json={
                "mode": "coding",
                "worktree_from": str(repo),
                "worktree_name": "task",
                "model": "bad:model",
            },
        )

    assert resp.status_code == 422
    assert not (data_dir / "worktrees").exists()
