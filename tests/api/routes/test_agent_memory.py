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
    (config_dir / "memory").mkdir(parents=True, exist_ok=True)
    return config_dir


@pytest.fixture
async def client(mem_dirs):
    app = FastAPI()
    app.include_router(memory_router, prefix="/api/agent")
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as c:
        yield c


@pytest.mark.asyncio
async def test_get_tree_global(client, mem_dirs):
    config_dir = mem_dirs
    (config_dir / "memory" / "preferences.md").write_text(
        "# Preferences\nKeep responses short.\n"
    )
    (config_dir / "memory" / "tools.md").write_text(
        "---\ntitle: Tools Guide\ntype: guide\n---\n# Tools\n"
    )

    res = await client.get("/api/agent/memory/tree")
    assert res.status_code == 200
    data = res.json()
    paths = [p["path"] for p in data["pages"]]
    assert "preferences.md" in paths
    assert "tools.md" in paths


@pytest.mark.asyncio
async def test_file_lifecycle_with_etags(client, mem_dirs):
    config_dir = mem_dirs
    url_params = "path=auth.md"

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
    assert not (config_dir / "memory" / "auth.md").exists()


@pytest.mark.asyncio
async def test_search_and_lint_endpoints(client, mem_dirs):
    config_dir = mem_dirs
    (config_dir / "memory" / "preferences.md").write_text("# Preferences\n")
    (config_dir / "memory" / "db.md").write_text("# Database\nPostgres setup.\n")
    (config_dir / "memory" / "auth.md").write_text(
        "# Auth\nSee [[db]] and [[missing]].\n"
    )

    # Search
    search_res = await client.get("/api/agent/memory/search?query=postgres")
    assert search_res.status_code == 200
    results = search_res.json()["results"]
    assert len(results) == 1
    assert results[0]["path"] == "db.md"

    # Lint
    lint_res = await client.post("/api/agent/memory/lint")
    assert lint_res.status_code == 200
    findings = lint_res.json()["findings"]
    codes = [f["code"] for f in findings]
    assert "BROKEN_LINK" in codes
