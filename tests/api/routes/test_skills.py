"""Tests for /api/skills HTTP routes."""

from __future__ import annotations

from pathlib import Path
from unittest.mock import AsyncMock

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient

from app.api.routes import skills as skills_routes
from app.api.routes.skills import router as skills_router
from app.services import team_manager


# ── Fixtures ──────────────────────────────────────────────────────────────────


@pytest.fixture
def fs_dirs(tmp_path: Path, monkeypatch):
    """Redirect AGENTS_DIR and SKILLS_DIR to an isolated tmp tree."""
    from app.core.config import settings

    agents = tmp_path / "agents"
    skills = tmp_path / "skills"
    agents.mkdir()
    skills.mkdir()
    monkeypatch.setattr(settings, "AGENTS_DIR", str(agents))
    monkeypatch.setattr(settings, "SKILLS_DIR", str(skills))
    from app.agent.tools.builtin import skill as skill_module

    monkeypatch.setattr(skill_module, "_iter_skill_roots", lambda: [skills])
    skill_module._discover_skills_cached.cache_clear()
    skills_routes._cached_skill_list_metadata.cache_clear()
    return agents, skills


@pytest.fixture
async def client(fs_dirs):
    app = FastAPI()
    app.include_router(skills_router, prefix="/api/skills")
    # Clear any team state that may linger from parallel tests
    await team_manager.stop()
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://t") as c:
        yield c
    await team_manager.stop()


# ── Sample skill content ───────────────────────────────────────────────────────

VALID_SKILL = """\
---
name: research
description: A research skill.
---
Do research.
"""

MISMATCHED_NAME_SKILL = """\
---
name: other
description: Mismatch.
---
Body.
"""

NON_DICT_FRONTMATTER_SKILL = """\
---
- item1
- item2
---
Body.
"""

NON_STRING_DESC_SKILL = """\
---
name: research
description: 42
---
Body.
"""

INVALID_YAML_SKILL = """\
---
name: research
description: [unclosed
---
Body.
"""


# ── _parse_skill unit tests (via POST /api/skills validation) ─────────────────


@pytest.mark.asyncio
async def test_create_invalid_yaml_returns_422(client):
    resp = await client.post(
        "/api/skills",
        json={"name": "research", "content": INVALID_YAML_SKILL},
    )
    assert resp.status_code == 422
    assert "frontmatter" in resp.json()["detail"].lower()


@pytest.mark.asyncio
async def test_create_non_dict_frontmatter_returns_422(client):
    resp = await client.post(
        "/api/skills",
        json={"name": "research", "content": NON_DICT_FRONTMATTER_SKILL},
    )
    assert resp.status_code == 422
    assert "mapping" in resp.json()["detail"].lower()


@pytest.mark.asyncio
async def test_create_non_string_description_returns_422(client):
    resp = await client.post(
        "/api/skills",
        json={"name": "research", "content": NON_STRING_DESC_SKILL},
    )
    assert resp.status_code == 422
    assert "description" in resp.json()["detail"].lower()


@pytest.mark.asyncio
async def test_create_name_mismatch_returns_422(client):
    resp = await client.post(
        "/api/skills",
        json={"name": "research", "content": MISMATCHED_NAME_SKILL},
    )
    assert resp.status_code == 422
    assert "other" in resp.json()["detail"]


# ── GET /api/skills ───────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_list_skills_empty(client):
    resp = await client.get("/api/skills")
    assert resp.status_code == 200
    assert resp.json() == {"skills": []}


@pytest.mark.asyncio
async def test_list_skills_reuses_unchanged_read_and_strict_parse(
    client, fs_dirs, monkeypatch
):
    """Metadata changes invalidate route parsing while unchanged files reuse it."""
    _, skills_dir = fs_dirs
    skill_file = skills_dir / "research" / "SKILL.md"
    skill_file.parent.mkdir()
    skill_file.write_text(VALID_SKILL)
    reads = 0
    parses = 0
    original_read_text = Path.read_text
    original_parse = skills_routes._parse_skill

    def count_read(path: Path, *args, **kwargs):
        nonlocal reads
        if path == skill_file:
            reads += 1
        return original_read_text(path, *args, **kwargs)

    def count_parse(name: str, content: str):
        nonlocal parses
        parses += 1
        return original_parse(name, content)

    monkeypatch.setattr(Path, "read_text", count_read)
    monkeypatch.setattr(skills_routes, "_parse_skill", count_parse)

    assert (await client.get("/api/skills")).status_code == 200
    first_counts = (reads, parses)
    assert (await client.get("/api/skills")).status_code == 200
    assert (reads, parses) == first_counts

    skill_file.write_text(VALID_SKILL.replace("A research skill.", "Updated."))
    response = await client.get("/api/skills")
    assert response.json()["skills"][0]["description"] == "Updated."
    assert (reads, parses) == (first_counts[0] + 2, first_counts[1] + 1)


@pytest.mark.asyncio
async def test_list_skills_keeps_malformed_files_visible_from_cache(
    client, fs_dirs, monkeypatch
):
    _, skills_dir = fs_dirs
    skill_file = skills_dir / "broken" / "SKILL.md"
    skill_file.parent.mkdir()
    skill_file.write_text(INVALID_YAML_SKILL.replace("research", "broken"))
    parses = 0
    original_parse = skills_routes._parse_skill

    def count_parse(name: str, content: str):
        nonlocal parses
        parses += 1
        return original_parse(name, content)

    monkeypatch.setattr(skills_routes, "_parse_skill", count_parse)
    first = await client.get("/api/skills")
    second = await client.get("/api/skills")

    assert first.json()["skills"][0]["valid"] is False
    assert "Invalid frontmatter" in first.json()["skills"][0]["error"]
    assert second.json()["skills"] == first.json()["skills"]
    assert parses == 1


@pytest.mark.asyncio
async def test_list_skills_retries_transient_read_failures(
    client, fs_dirs, monkeypatch
):
    _, skills_dir = fs_dirs
    skill_file = skills_dir / "research" / "SKILL.md"
    skill_file.parent.mkdir()
    skill_file.write_text(VALID_SKILL)
    assert (await client.get("/api/skills")).status_code == 200
    skills_routes._invalidate_skill_parse_cache()
    original_read_text = Path.read_text
    failures = 0

    def transient_read(path: Path, *args, **kwargs):
        nonlocal failures
        if path == skill_file and failures == 0:
            failures += 1
            raise OSError("temporary read failure")
        return original_read_text(path, *args, **kwargs)

    monkeypatch.setattr(Path, "read_text", transient_read)
    failed = await client.get("/api/skills")
    retried = await client.get("/api/skills")

    assert failed.json()["skills"][0]["valid"] is False
    assert "temporary read failure" in failed.json()["skills"][0]["error"]
    assert retried.json()["skills"][0]["valid"] is True
    assert failures == 1


def test_skill_parse_cache_is_bounded(tmp_path):
    skills_routes._cached_skill_list_metadata.cache_clear()
    for index in range(skills_routes._SKILL_PARSE_CACHE_LIMIT + 1):
        skill_file = tmp_path / str(index) / "SKILL.md"
        skill_file.parent.mkdir()
        skill_file.write_text(VALID_SKILL)
        assert skills_routes._read_parsed_skill("research", skill_file) is not None
    assert (
        skills_routes._cached_skill_list_metadata.cache_info().currsize
        == skills_routes._SKILL_PARSE_CACHE_LIMIT
    )


def test_skill_parse_cache_does_not_retain_oversized_file(tmp_path):
    skill_file = tmp_path / "large" / "SKILL.md"
    skill_file.parent.mkdir()
    skill_file.write_text(
        "---\nname: research\ndescription: " + ("x" * 200_000) + "\n---\nBody.\n",
        encoding="utf-8",
    )
    skills_routes._cached_skill_list_metadata.cache_clear()

    assert skills_routes._read_parsed_skill("research", skill_file)[0]
    assert skills_routes._read_parsed_skill("research", skill_file)[0]
    assert skills_routes._cached_skill_list_metadata.cache_info().currsize == 0


@pytest.mark.asyncio
async def test_list_skills_rename_reparses_new_path(client, fs_dirs, monkeypatch):
    _, skills_dir = fs_dirs
    original_dir = skills_dir / "research"
    skill_file = original_dir / "SKILL.md"
    original_dir.mkdir()
    skill_file.write_text(VALID_SKILL)
    parses = 0
    original_parse = skills_routes._parse_skill

    def count_parse(name: str, content: str):
        nonlocal parses
        parses += 1
        return original_parse(name, content)

    monkeypatch.setattr(skills_routes, "_parse_skill", count_parse)
    await client.get("/api/skills")
    original_dir.rename(skills_dir / "renamed")
    response = await client.get("/api/skills")

    assert response.json()["skills"][0]["name"] == "research"
    assert parses == 2


@pytest.mark.asyncio
async def test_list_skills_returns_created_skill(client):
    await client.post("/api/skills", json={"name": "research", "content": VALID_SKILL})
    resp = await client.get("/api/skills")
    assert resp.status_code == 200
    skills = resp.json()["skills"]
    assert len(skills) == 1
    assert skills[0]["name"] == "research"
    assert skills[0]["valid"] is True
    assert skills[0]["built_in"] is False
    assert skills[0]["editable"] is True
    assert skills[0]["source"] == "global-openagentd"


@pytest.mark.asyncio
async def test_list_skills_includes_opencode_skill(
    client, fs_dirs, tmp_path, monkeypatch
):
    _, openagentd_skills = fs_dirs
    opencode_skills = tmp_path / "home" / ".config" / "opencode" / "skills"
    skill_dir = opencode_skills / "research"
    skill_dir.mkdir(parents=True)
    (skill_dir / "SKILL.md").write_text(VALID_SKILL)

    from app.agent.tools.builtin import skill as skill_module

    monkeypatch.setattr(
        skill_module, "_iter_skill_roots", lambda: [openagentd_skills, opencode_skills]
    )
    monkeypatch.setattr(
        skills_routes.Path, "home", classmethod(lambda cls: tmp_path / "home")
    )
    skill_module._discover_skills_cached.cache_clear()

    resp = await client.get("/api/skills")

    assert resp.status_code == 200
    skills = resp.json()["skills"]
    assert skills == [
        {
            "name": "research",
            "description": "A research skill.",
            "valid": True,
            "error": None,
            "built_in": False,
            "editable": True,
            "source": "global-opencode",
        }
    ]


@pytest.mark.asyncio
async def test_list_skills_labels_project_openagentd_source(
    client, fs_dirs, tmp_path, monkeypatch
):
    workspace = tmp_path / "workspace"
    project_skills = workspace / ".openagentd" / "skills"
    skill_file = project_skills / "oad" / "commit" / "SKILL.md"
    skill_file.parent.mkdir(parents=True)
    skill_file.write_text(
        "---\nname: oad/commit\ndescription: Commit workflow.\n---\nBody."
    )
    openagentd_skills = fs_dirs[1]

    from app.agent.tools.builtin import skill as skill_module

    monkeypatch.setattr(
        skill_module, "_iter_skill_roots", lambda: [project_skills, openagentd_skills]
    )
    monkeypatch.setattr(skill_module, "_project_root", lambda: workspace)
    skill_module._discover_skills_cached.cache_clear()

    resp = await client.get("/api/skills")

    assert resp.status_code == 200
    assert resp.json()["skills"] == [
        {
            "name": "oad/commit",
            "description": "Commit workflow.",
            "valid": True,
            "error": None,
            "built_in": False,
            "editable": True,
            "source": "project-openagentd",
        }
    ]


@pytest.mark.asyncio
async def test_list_skills_labels_project_opencode_source(
    client, fs_dirs, tmp_path, monkeypatch
):
    workspace = tmp_path / "workspace"
    project_skills = workspace / ".opencode" / "skills"
    skill_file = project_skills / "research" / "SKILL.md"
    skill_file.parent.mkdir(parents=True)
    skill_file.write_text(VALID_SKILL)
    openagentd_skills = fs_dirs[1]

    from app.agent.tools.builtin import skill as skill_module

    monkeypatch.setattr(
        skill_module, "_iter_skill_roots", lambda: [project_skills, openagentd_skills]
    )
    monkeypatch.setattr(skill_module, "_project_root", lambda: workspace)
    skill_module._discover_skills_cached.cache_clear()

    resp = await client.get("/api/skills")

    assert resp.status_code == 200
    assert resp.json()["skills"][0]["source"] == "project-opencode"


@pytest.mark.asyncio
async def test_delete_opencode_skill_removes_source_file(
    client, fs_dirs, tmp_path, monkeypatch
):
    openagentd_skills = fs_dirs[1]
    opencode_skills = tmp_path / "home" / ".config" / "opencode" / "skills"
    skill_file = opencode_skills / "research" / "SKILL.md"
    skill_file.parent.mkdir(parents=True)
    skill_file.write_text(VALID_SKILL)

    from app.agent.tools.builtin import skill as skill_module

    monkeypatch.setattr(
        skill_module, "_iter_skill_roots", lambda: [openagentd_skills, opencode_skills]
    )
    monkeypatch.setattr(
        skills_routes.Path, "home", classmethod(lambda cls: tmp_path / "home")
    )
    skill_module._discover_skills_cached.cache_clear()

    resp = await client.delete("/api/skills/research")

    assert resp.status_code == 200
    assert not skill_file.exists()


@pytest.mark.asyncio
async def test_list_skills_includes_read_error(client, fs_dirs, monkeypatch):
    """A skill whose file is unreadable shows up as invalid instead of crashing."""
    _, skills_dir = fs_dirs
    # Manually create a skill directory but make read_skill raise
    (skills_dir / "broken").mkdir()
    (skills_dir / "broken" / "SKILL.md").write_text("content")

    original_read_text = Path.read_text

    def bad_read_text(path, *args, **kwargs):
        if path.name == "SKILL.md" and path.parent.name == "broken":
            raise OSError("permission denied")
        return original_read_text(path, *args, **kwargs)

    monkeypatch.setattr(Path, "read_text", bad_read_text)

    resp = await client.get("/api/skills")
    assert resp.status_code == 200
    skills = resp.json()["skills"]
    broken = next(s for s in skills if s["name"] == "broken")
    assert broken["valid"] is False
    assert "permission denied" in broken["error"]


# ── GET /api/skills/{name} ────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_get_skill_not_found_returns_404(client):
    resp = await client.get("/api/skills/missing")
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_get_skill_bad_name_returns_400(client):
    # Names with spaces/special chars fail _validate_name → AgentFsPathError → 400
    resp = await client.get("/api/skills/bad%20name")
    assert resp.status_code == 400


@pytest.mark.asyncio
async def test_get_skill_returns_detail(client):
    await client.post("/api/skills", json={"name": "research", "content": VALID_SKILL})
    resp = await client.get("/api/skills/research")
    assert resp.status_code == 200
    data = resp.json()
    assert data["name"] == "research"
    assert data["description"] == "A research skill."
    assert "Do research" in data["content"]


@pytest.mark.asyncio
async def test_sub_skill_crud_routes_accept_slash_name(client):
    content = "---\nname: git/commit\ndescription: Commit helper.\n---\nCommit body.\n"

    create = await client.post(
        "/api/skills",
        json={"name": "git/commit", "content": content},
    )
    assert create.status_code == 201

    detail = await client.get("/api/skills/git/commit")
    assert detail.status_code == 200
    assert detail.json()["name"] == "git/commit"

    updated = content.replace("Commit helper.", "Updated helper.")
    update = await client.put(
        "/api/skills/git/commit",
        json={"name": "git/commit", "content": updated},
    )
    assert update.status_code == 200
    assert update.json()["description"] == "Updated helper."

    delete = await client.delete("/api/skills/git/commit")
    assert delete.status_code == 200
    assert delete.json() == {"name": "git/commit"}


# ── POST /api/skills ──────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_create_skill_success(client):
    resp = await client.post(
        "/api/skills", json={"name": "research", "content": VALID_SKILL}
    )
    assert resp.status_code == 201
    data = resp.json()
    assert data["name"] == "research"
    assert data["description"] == "A research skill."


@pytest.mark.asyncio
async def test_create_skill_conflict_returns_409(client):
    await client.post("/api/skills", json={"name": "research", "content": VALID_SKILL})
    resp = await client.post(
        "/api/skills", json={"name": "research", "content": VALID_SKILL}
    )
    assert resp.status_code == 409


@pytest.mark.asyncio
async def test_create_skill_bad_path_returns_400(client, monkeypatch):
    from app.services import agent_fs
    from app.services.agent_fs import AgentFsPathError

    monkeypatch.setattr(
        agent_fs,
        "write_skill",
        lambda *a, **kw: (_ for _ in ()).throw(AgentFsPathError("bad")),
    )
    resp = await client.post(
        "/api/skills",
        json={"name": "research", "content": VALID_SKILL},
    )
    assert resp.status_code == 400


# ── PUT /api/skills/{name} ────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_update_skill_name_mismatch_returns_422(client):
    await client.post("/api/skills", json={"name": "research", "content": VALID_SKILL})
    resp = await client.put(
        "/api/skills/research",
        json={"name": "other", "content": VALID_SKILL},
    )
    assert resp.status_code == 422
    assert "research" in resp.json()["detail"]


@pytest.mark.asyncio
async def test_update_skill_invalid_content_returns_422(client):
    await client.post("/api/skills", json={"name": "research", "content": VALID_SKILL})
    resp = await client.put(
        "/api/skills/research",
        json={"name": "research", "content": INVALID_YAML_SKILL},
    )
    assert resp.status_code == 422


@pytest.mark.asyncio
async def test_update_skill_success(client):
    await client.post("/api/skills", json={"name": "research", "content": VALID_SKILL})
    updated = VALID_SKILL.replace("A research skill.", "Updated description.")
    resp = await client.put(
        "/api/skills/research",
        json={"name": "research", "content": updated},
    )
    assert resp.status_code == 200
    assert resp.json()["description"] == "Updated description."


@pytest.mark.asyncio
async def test_update_skill_bad_path_returns_400(client, monkeypatch):
    await client.post("/api/skills", json={"name": "research", "content": VALID_SKILL})

    def bad_write(*_args, **_kwargs):
        raise OSError("bad")

    monkeypatch.setattr(skills_routes, "_atomic_write", bad_write)
    resp = await client.put(
        "/api/skills/research",
        json={"name": "research", "content": VALID_SKILL},
    )
    assert resp.status_code == 400


# ── DELETE /api/skills/{name} ─────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_delete_skill_success(client):
    await client.post("/api/skills", json={"name": "research", "content": VALID_SKILL})
    resp = await client.delete("/api/skills/research")
    assert resp.status_code == 200
    assert resp.json() == {"name": "research"}


@pytest.mark.asyncio
async def test_delete_builtin_skill_returns_403(client, monkeypatch):
    from app.agent.tools.builtin import skill as skill_module

    monkeypatch.setattr(
        skill_module,
        "_iter_skill_roots",
        lambda: [skills_routes._builtin_skills_root()],
    )
    skill_module._discover_skills_cached.cache_clear()

    resp = await client.delete("/api/skills/self-healing")
    assert resp.status_code == 403
    assert "read-only" in resp.json()["detail"]


@pytest.mark.asyncio
async def test_delete_skill_not_found_returns_404(client):
    resp = await client.delete("/api/skills/missing")
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_delete_skill_bad_path_returns_400(client, monkeypatch):
    await client.post("/api/skills", json={"name": "research", "content": VALID_SKILL})

    def bad_delete(*_args, **_kwargs):
        raise OSError("bad")

    monkeypatch.setattr(skills_routes, "_delete_skill_file", bad_delete)
    resp = await client.delete("/api/skills/research")
    assert resp.status_code == 400


# ── Cache invalidation — no team reload, drift detection picks up changes ─────


@pytest.mark.asyncio
async def test_create_skill_invalidates_cache_without_reloading_team(
    client, monkeypatch, fs_dirs
):
    """Skill mutations must invalidate the discovery cache but never reload the team.

    Mid-turn team reloads tear down in-flight tool execution.  Agents
    instead pick up new/updated skills at the start of their next turn
    via the config-stamp drift check.
    """
    invalidated: list[bool] = []
    reload_called: list[bool] = []

    monkeypatch.setattr(
        team_manager,
        "invalidate_skill_cache",
        lambda: invalidated.append(True),
    )
    # Sentinel: if the route accidentally re-introduces a reload call,
    # this will record it.
    monkeypatch.setattr(
        team_manager,
        "reload",
        AsyncMock(side_effect=lambda: reload_called.append(True)),
    )

    resp = await client.post(
        "/api/skills", json={"name": "research", "content": VALID_SKILL}
    )
    assert resp.status_code == 201
    assert resp.json()["name"] == "research"
    assert invalidated == [True], "skill cache must be invalidated"
    assert reload_called == [], "team must NOT be reloaded mid-turn"
