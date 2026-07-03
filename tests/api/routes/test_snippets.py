"""Tests for /api/snippets HTTP routes."""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient

from app.api.routes.snippets import router as snippets_router


@pytest.fixture
def roots(tmp_path: Path, monkeypatch):
    workspace = tmp_path / "project"
    workspace.mkdir()
    project_root = workspace / ".openagentd" / "snippets"
    global_config = tmp_path / "config"
    global_root = global_config / "snippets"

    from app.core import config as config_module

    monkeypatch.setattr(
        config_module.settings, "OPENAGENTD_CONFIG_DIR", str(global_config)
    )
    return workspace, project_root, global_root


@pytest.fixture
async def client(roots):
    app = FastAPI()
    app.include_router(snippets_router, prefix="/api/snippets")
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://t") as c:
        yield c


def _write(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")


@pytest.mark.asyncio
async def test_list_requires_workspace(client):
    res = await client.get("/api/snippets")
    assert res.status_code == 422


@pytest.mark.asyncio
async def test_list_rejects_missing_workspace(client, tmp_path):
    res = await client.get(
        "/api/snippets", params={"workspace": str(tmp_path / "missing")}
    )
    assert res.status_code == 422


@pytest.mark.asyncio
@pytest.mark.parametrize("blocked", ["/etc", "/private/etc"])
async def test_list_rejects_blocked_system_workspace(client, blocked):
    if not Path(blocked).is_dir():
        pytest.skip(f"{blocked} is not a directory on this system")
    res = await client.get("/api/snippets", params={"workspace": blocked})
    assert res.status_code == 422
    assert "restricted system directory" in res.json()["detail"]


@pytest.mark.asyncio
@pytest.mark.parametrize("blocked", ["/etc", "/private/etc"])
async def test_render_rejects_blocked_system_workspace(client, blocked):
    if not Path(blocked).is_dir():
        pytest.skip(f"{blocked} is not a directory on this system")
    res = await client.post("/api/snippets/any/render", params={"workspace": blocked})
    assert res.status_code == 422
    assert "restricted system directory" in res.json()["detail"]


@pytest.mark.asyncio
async def test_list_and_render_snippets(client, roots):
    workspace, project_root, global_root = roots
    _write(
        project_root / "review.md", "---\ndescription: Review\n---\nReview the diff."
    )
    _write(global_root / "git" / "commit.md", "Commit staged changes.")

    res = await client.get("/api/snippets", params={"workspace": str(workspace)})

    assert res.status_code == 200
    assert res.json() == {
        "snippets": [
            {"name": "git/commit", "description": "", "source": "global-openagentd"},
            {"name": "review", "description": "Review", "source": "project-openagentd"},
        ]
    }

    rendered = await client.post(
        "/api/snippets/git/commit/render", params={"workspace": str(workspace)}
    )
    assert rendered.status_code == 200
    assert rendered.json() == {
        "name": "git/commit",
        "content": "Commit staged changes.",
    }
