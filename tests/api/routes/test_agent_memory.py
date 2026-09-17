"""Tests for /api/agent/memory REST API endpoints."""

from __future__ import annotations

from pathlib import Path
import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient

from app.api.routes.agent.memory import router as memory_router
from app.core.config import settings
from app.services.memory.manager import reset_memory_manager


@pytest.fixture(autouse=True)
def _clean_memory_state():
    reset_memory_manager()
    yield
    reset_memory_manager()


@pytest.fixture
def mem_dirs(tmp_path: Path, monkeypatch):
    config_dir = tmp_path / "config"
    config_dir.mkdir(parents=True, exist_ok=True)
    monkeypatch.setattr(settings, "OPENAGENTD_CONFIG_DIR", str(config_dir))

    ws_dir = tmp_path / "workspace"
    ws_dir.mkdir(parents=True, exist_ok=True)
    (ws_dir / ".openagentd" / "memory").mkdir(parents=True, exist_ok=True)

    return config_dir, ws_dir


@pytest.fixture
async def client(mem_dirs):
    app = FastAPI()
    app.include_router(memory_router, prefix="/api/agent")
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as c:
        yield c


@pytest.mark.asyncio
async def test_get_tree_global_and_workspace(client, mem_dirs):
    config_dir, ws_dir = mem_dirs
    # Create a global page
    (config_dir / "memory").mkdir(parents=True, exist_ok=True)
    (config_dir / "memory" / "preferences.md").write_text(
        "# Preferences\nKeep responses short.\n"
    )
    (config_dir / "memory" / "tools.md").write_text(
        "---\ntitle: Tools Guide\ntype: guide\n---\n# Tools\n"
    )

    # Create a workspace page
    (ws_dir / ".openagentd" / "memory" / "architecture.md").write_text(
        "# Architecture\nMicroservices.\n"
    )

    # Query global tree
    res_global = await client.get("/api/agent/memory/tree?scope=global")
    assert res_global.status_code == 200
    data_global = res_global.json()
    paths_global = [p["path"] for p in data_global["pages"]]
    assert "preferences.md" in paths_global
    assert "tools.md" in paths_global

    # Query workspace tree
    res_ws = await client.get(
        f"/api/agent/memory/tree?scope=workspace&workspace={ws_dir}"
    )
    assert res_ws.status_code == 200
    data_ws = res_ws.json()
    assert len(data_ws["pages"]) == 1
    assert data_ws["pages"][0]["path"] == "architecture.md"
    assert data_ws["pages"][0]["title"] == "Architecture"


@pytest.mark.asyncio
async def test_file_lifecycle_with_etags(client, mem_dirs):
    _, ws_dir = mem_dirs
    url_params = f"path=auth.md&scope=workspace&workspace={ws_dir}"

    # 1. 404 on non-existent read
    res = await client.get(f"/api/agent/memory/file?{url_params}")
    assert res.status_code == 404

    # 2. Create file without If-Match (new file)
    create_res = await client.put(
        f"/api/agent/memory/file?{url_params}",
        json={"content": "# Auth\nInitial content\n"},
    )
    assert create_res.status_code == 200
    etag = create_res.json()["etag"]
    assert etag.startswith('"') and etag.endswith('"')
    assert create_res.headers.get("etag") == etag

    # 3. Read back file
    get_res = await client.get(f"/api/agent/memory/file?{url_params}")
    assert get_res.status_code == 200
    assert get_res.json()["content"] == "# Auth\nInitial content\n"
    assert get_res.json()["etag"] == etag

    # 4. Update without If-Match -> 428 Precondition Required
    update_fail = await client.put(
        f"/api/agent/memory/file?{url_params}",
        json={"content": "# Auth\nUpdated\n"},
    )
    assert update_fail.status_code == 428

    # 5. Update with mismatched If-Match -> 412 Precondition Failed
    update_mismatch = await client.put(
        f"/api/agent/memory/file?{url_params}",
        headers={"If-Match": '"stale-etag"'},
        json={"content": "# Auth\nUpdated\n"},
    )
    assert update_mismatch.status_code == 412

    # 6. Update with correct If-Match -> 200
    update_ok = await client.put(
        f"/api/agent/memory/file?{url_params}",
        headers={"If-Match": etag},
        json={"content": "# Auth\nUpdated content\n"},
    )
    assert update_ok.status_code == 200
    new_etag = update_ok.json()["etag"]
    assert new_etag != etag

    # 7. No-op update with correct If-Match -> 200
    noop_res = await client.put(
        f"/api/agent/memory/file?{url_params}",
        headers={"If-Match": new_etag},
        json={"content": "# Auth\nUpdated content\n"},
    )
    assert noop_res.status_code == 200
    assert noop_res.json()["etag"] == new_etag

    # 8. Delete without If-Match -> 428
    del_fail = await client.delete(f"/api/agent/memory/file?{url_params}")
    assert del_fail.status_code == 428

    # 9. Delete with correct If-Match -> 200
    del_ok = await client.delete(
        f"/api/agent/memory/file?{url_params}",
        headers={"If-Match": new_etag},
    )
    assert del_ok.status_code == 200
    assert del_ok.json() == {"status": "deleted", "path": "auth.md"}

    # Verify deleted on disk
    assert not (ws_dir / ".openagentd" / "memory" / "auth.md").exists()


@pytest.mark.asyncio
async def test_chat_mode_forbids_workspace_memory(client, tmp_path, monkeypatch):
    chat_root = tmp_path / "chat_home"
    chat_root.mkdir()
    monkeypatch.setattr(settings, "CHAT_WORKSPACE_DIR", str(chat_root))

    res = await client.get(
        f"/api/agent/memory/tree?scope=workspace&workspace={chat_root}"
    )
    assert res.status_code == 403


@pytest.mark.asyncio
async def test_search_and_lint_endpoints(client, mem_dirs):
    config_dir, ws_dir = mem_dirs
    (config_dir / "memory").mkdir(parents=True, exist_ok=True)
    (config_dir / "memory" / "preferences.md").write_text("# Preferences\n")
    (config_dir / "memory" / "db.md").write_text("# Database\nPostgres setup.\n")
    (ws_dir / ".openagentd" / "memory" / "auth.md").write_text(
        "# Auth\nSee [[db]] and [[missing]].\n"
    )

    # Search
    search_res = await client.get(
        f"/api/agent/memory/search?query=postgres&workspace={ws_dir}"
    )
    assert search_res.status_code == 200
    results = search_res.json()["results"]
    assert len(results) == 1
    assert results[0]["path"] == "db.md"
    assert results[0]["scope"] == "global"

    # Lint
    lint_res = await client.post(f"/api/agent/memory/lint?workspace={ws_dir}")
    assert lint_res.status_code == 200
    findings = lint_res.json()["findings"]
    codes = [f["code"] for f in findings]
    assert "BROKEN_LINK" in codes
