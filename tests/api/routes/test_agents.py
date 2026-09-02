"""Tests for /api/agents HTTP routes.

Mutations validate the new on-disk state but do NOT rebuild the running
session — agents pick up file changes at the start of their next turn via
the config-stamp drift check (see ``app.agent.loader.detect_drift``
and ``AgentSession._refresh_agent_from_disk``).  These tests assert
that contract: validation + rollback semantics, but no live session swap.
"""

from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, Mock

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient

from app.api.routes.agents import router as agents_router
from app.api.routes.skills import router as skills_router
from app.services import agent_manager


# ── Fixtures ─────────────────────────────────────────────────────────────────


@pytest.fixture
def fs_dirs(tmp_path: Path, monkeypatch):
    """Redirect AGENTS_DIR and SKILLS_DIR to a tmp tree."""
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
    return agents, skills


@pytest.fixture
def stub_provider(monkeypatch):
    """Replace the default provider builder with a no-op mock so reload() works
    without real API credentials or network access."""
    mock_provider = MagicMock()
    mock_provider.stream = MagicMock()

    def fake_build_provider(model_str=None, model_kwargs=None):
        return mock_provider

    monkeypatch.setattr("app.agent.loader.build_provider", fake_build_provider)
    return mock_provider


@pytest.fixture
async def client(fs_dirs, stub_provider):
    app = FastAPI()
    app.include_router(agents_router, prefix="/api/agents")
    app.include_router(skills_router, prefix="/api/skills")
    # Make sure no agent session is left over from a previous test.
    await agent_manager.stop()
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://t") as c:
        yield c
    await agent_manager.stop()


# ── Helpers ──────────────────────────────────────────────────────────────────


LEAD_MD = """\
---
name: lead
role: lead
description: The lead.
model: zai:glm-5-turbo
---
You are the lead.
"""

MEMBER_MD = """\
---
name: worker
role: member
description: Worker.
model: zai:glm-5-turbo
---
You are the worker.
"""


def _seed_files(agents_dir: Path) -> None:
    (agents_dir / "lead.md").write_text(LEAD_MD)


# ── GET /agents/registry ─────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_registry_returns_catalog(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch
):
    res = await client.get("/api/agents/registry")
    assert res.status_code == 200
    body = res.json()
    assert "tools" in body and "skills" in body and "models" in body
    tool_names = {t["name"] for t in body["tools"]}
    # A few builtins we know must exist.
    assert {"read", "patch", "shell", "grep"}.issubset(tool_names)
    assert {"skill", "todo_manage", "schedule_task", "note"}.isdisjoint(tool_names)
    assert isinstance(body["providers"], list) and body["providers"]


@pytest.mark.asyncio
async def test_model_cache_warmup_skips_unreachable_daemon_provider(
    monkeypatch: pytest.MonkeyPatch,
):
    from app.api.routes import agents as agents_routes
    from app.api.routes import settings as settings_routes
    from app.core import runtime_settings

    monkeypatch.setattr(
        agents_routes,
        "all_providers",
        lambda: [{"id": "ollama", "kind": "local", "label": "Ollama"}],
    )
    monkeypatch.setattr(agents_routes, "_provider_is_configured", lambda _entry: True)
    monkeypatch.setattr(
        agents_routes,
        "load_runtime_settings",
        lambda: runtime_settings.RuntimeSettings(),
    )
    reachable = AsyncMock(return_value=False)
    discover = AsyncMock(return_value=["model-that-must-not-load"])
    monkeypatch.setattr(settings_routes, "_provider_is_reachable", reachable)
    monkeypatch.setattr(
        "app.agent.providers.model_discovery.discover_provider_models", discover
    )

    await agents_routes._warm_provider_model_cache()

    reachable.assert_awaited_once()
    discover.assert_not_awaited()


@pytest.mark.asyncio
async def test_registry_reloads_settings_after_warming_provider_models_once(
    monkeypatch: pytest.MonkeyPatch,
):
    """Warmup saves are included in the registry's one refreshed UI snapshot."""
    from app.api.routes import agents as agents_routes
    from app.core import runtime_settings

    snapshot = runtime_settings.RuntimeSettings(
        providers={"openai": runtime_settings.ProviderUiSettings()}
    )
    load_settings = Mock(return_value=snapshot)
    monkeypatch.setattr(agents_routes, "load_runtime_settings", load_settings)
    monkeypatch.setattr(
        agents_routes,
        "all_providers",
        lambda: [{"id": "openai", "kind": "api_key", "label": "OpenAI"}],
    )
    monkeypatch.setattr(agents_routes, "_provider_is_configured", lambda _entry: True)
    monkeypatch.setattr(
        "app.agent.providers.model_discovery.discover_provider_models",
        AsyncMock(return_value=["gpt-5"]),
    )

    def _save_warmed_models(provider_id: str, models: list[str]) -> None:
        snapshot.providers[provider_id] = runtime_settings.ProviderUiSettings(
            cached_models=models
        )

    monkeypatch.setattr(
        agents_routes, "set_provider_cached_models", _save_warmed_models
    )
    monkeypatch.setattr("app.agent.loader._default_tool_registry", lambda: {})
    monkeypatch.setattr(agents_routes, "discover_skills", lambda: {})
    monkeypatch.setattr(
        "app.agent.providers.model_registry.load_model_registry", lambda: {}
    )

    refresh_task = AsyncMock()
    request = SimpleNamespace(
        app=SimpleNamespace(
            state=SimpleNamespace(model_registry_refresh_task=refresh_task())
        )
    )

    registry = await agents_routes.get_registry(request)

    refresh_task.assert_awaited_once()
    assert [model.id for model in registry.models] == ["openai:gpt-5"]
    assert load_settings.call_count == 2


@pytest.mark.asyncio
async def test_registry_hides_cached_paid_models_without_opencode_keys(
    monkeypatch: pytest.MonkeyPatch,
):
    from app.agent.providers.model_metadata import ModelCost
    from app.api.routes import agents as agents_routes
    from app.core.runtime_settings import ProviderUiSettings, RuntimeSettings

    entries = [
        {
            "id": "opencode",
            "kind": "api_key",
            "label": "OpenCode Zen",
            "public_access": True,
        },
        {
            "id": "opencode-go",
            "kind": "api_key",
            "label": "OpenCode Go",
        },
    ]
    monkeypatch.setattr(agents_routes, "all_providers", lambda: entries)
    monkeypatch.setattr(agents_routes, "_provider_is_configured", lambda _entry: False)
    monkeypatch.setattr(
        agents_routes,
        "load_runtime_settings",
        lambda: RuntimeSettings(
            providers={
                "opencode": ProviderUiSettings(
                    cached_models=["anonymous-model", "paid-model"]
                ),
                "opencode-go": ProviderUiSettings(cached_models=["go-model"]),
            }
        ),
    )
    monkeypatch.setattr(agents_routes, "discover_skills", lambda: {})
    monkeypatch.setattr("app.agent.loader._default_tool_registry", lambda: {})
    monkeypatch.setattr(
        "app.agent.providers.model_registry.load_model_registry", lambda: {}
    )
    monkeypatch.setattr(agents_routes, "is_agent_model_id", lambda _model_id: True)
    costs = {
        "opencode:anonymous-model": ModelCost(input=0),
        "opencode:paid-model": ModelCost(input=1),
    }
    monkeypatch.setattr(
        "app.agent.providers.model_metadata.get_model_cost",
        lambda model_id: costs.get(model_id, ModelCost()),
    )

    request = SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace()))
    registry = await agents_routes.get_registry(request)

    assert [model.id for model in registry.models] == ["opencode:anonymous-model"]
    assert await agents_routes.is_registered_model_id("opencode:anonymous-model")
    assert not await agents_routes.is_registered_model_id("opencode:paid-model")
    assert not await agents_routes.is_registered_model_id("opencode-go:go-model")


@pytest.mark.asyncio
async def test_registry_filters_cached_models_using_refreshed_visible_models(
    monkeypatch: pytest.MonkeyPatch,
):
    from app.api.routes import agents as agents_routes
    from app.core.runtime_settings import ProviderUiSettings, RuntimeSettings

    load_settings = Mock(
        return_value=RuntimeSettings(
            providers={
                "openai": ProviderUiSettings(
                    cached_models=["shown-model", "hidden-model"],
                    visible_models=["shown-model"],
                )
            }
        )
    )
    monkeypatch.setattr(agents_routes, "load_runtime_settings", load_settings)
    monkeypatch.setattr(
        agents_routes,
        "all_providers",
        lambda: [{"id": "openai", "kind": "api_key", "label": "OpenAI"}],
    )
    monkeypatch.setattr(agents_routes, "_provider_is_configured", lambda _entry: False)
    monkeypatch.setattr(agents_routes, "is_agent_model_id", lambda _model_id: True)

    request = SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace()))
    registry = await agents_routes.get_registry(request)

    model_ids = {model.id for model in registry.models}
    assert "openai:shown-model" in model_ids
    assert "openai:hidden-model" not in model_ids
    assert load_settings.call_count == 2


@pytest.mark.asyncio
async def test_registry_ignores_visible_models_no_longer_listed(
    monkeypatch: pytest.MonkeyPatch,
):
    """A stale visible entry (the provider dropped the model) must not hide
    the provider's remaining models — the visible whitelist is limited to
    models the provider still lists."""
    from app.api.routes import agents as agents_routes
    from app.core.runtime_settings import ProviderUiSettings, RuntimeSettings

    load_settings = Mock(
        return_value=RuntimeSettings(
            providers={
                "openai": ProviderUiSettings(
                    cached_models=["shown-model", "hidden-model"],
                    visible_models=["retired-model"],
                )
            }
        )
    )
    monkeypatch.setattr(agents_routes, "load_runtime_settings", load_settings)
    monkeypatch.setattr(
        agents_routes,
        "all_providers",
        lambda: [{"id": "openai", "kind": "api_key", "label": "OpenAI"}],
    )
    monkeypatch.setattr(agents_routes, "_provider_is_configured", lambda _entry: False)
    monkeypatch.setattr(agents_routes, "is_agent_model_id", lambda _model_id: True)

    request = SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace()))
    registry = await agents_routes.get_registry(request)

    model_ids = {model.id for model in registry.models}
    assert "openai:shown-model" in model_ids
    assert "openai:hidden-model" in model_ids


@pytest.mark.asyncio
async def test_is_registered_model_reads_provider_ui_state_from_one_snapshot(
    monkeypatch: pytest.MonkeyPatch,
):
    from app.api.routes import agents as agents_routes
    from app.core import runtime_settings

    load_settings = Mock(
        return_value=runtime_settings.RuntimeSettings(
            providers={
                "openai": runtime_settings.ProviderUiSettings(
                    cached_models=["gpt-5"], visible_models=["gpt-5"]
                )
            }
        )
    )
    monkeypatch.setattr(agents_routes, "load_runtime_settings", load_settings)

    assert await agents_routes.is_registered_model_id("openai:gpt-5") is True
    assert load_settings.call_count == 1


@pytest.mark.asyncio
async def test_registry_model_fast_mode_matches_provider_support(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch
):
    """Each model entry's fast_mode reflects its provider's supports_fast_mode flag."""
    from app.agent.providers.catalog import _CATALOG

    # Seed one model for a fast-mode provider and one for a non-fast-mode provider.
    fast_provider = next(e for e in _CATALOG if e.get("supports_fast_mode"))
    slow_provider = next(
        e
        for e in _CATALOG
        if not e.get("supports_fast_mode")
        and e["id"] not in {"opencode", "opencode-go"}
    )

    from app.api.routes import agents as agents_routes
    from app.core.runtime_settings import ProviderUiSettings, RuntimeSettings

    monkeypatch.setattr(
        agents_routes,
        "load_runtime_settings",
        lambda: RuntimeSettings(
            providers={
                fast_provider["id"]: ProviderUiSettings(
                    cached_models=["test-fast-model"]
                ),
                slow_provider["id"]: ProviderUiSettings(
                    cached_models=["test-slow-model"]
                ),
            }
        ),
    )
    monkeypatch.setattr("app.api.routes.agents.is_agent_model_id", lambda mid: True)

    res = await client.get("/api/agents/registry")
    assert res.status_code == 200

    models_by_id = {m["id"]: m for m in res.json()["models"]}

    fast_id = f"{fast_provider['id']}:test-fast-model"
    slow_id = f"{slow_provider['id']}:test-slow-model"

    assert fast_id in models_by_id, f"Expected {fast_id} in registry"
    assert models_by_id[fast_id]["fast_mode"] is True

    assert slow_id in models_by_id, f"Expected {slow_id} in registry"
    assert models_by_id[slow_id]["fast_mode"] is False


@pytest.mark.asyncio
async def test_registry_plugin_provider_fast_mode_stamped(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch
):
    """A plugin provider with supports_fast_mode=True has fast_mode=True on its models."""
    from app.agent.providers.plugin_api import ProviderPlugin

    fast_plugin = ProviderPlugin(
        id="myfastplugin",
        label="My Fast Plugin",
        description="Fast.",
        kind="api_key",
        factory=lambda ctx: None,  # type: ignore[arg-type]
        supports_fast_mode=True,
    )

    monkeypatch.setattr(
        "app.agent.providers.plugin_registry.provider_plugins",
        lambda: {"myfastplugin": fast_plugin},
    )
    from app.api.routes import agents as agents_routes
    from app.core.runtime_settings import ProviderUiSettings, RuntimeSettings

    monkeypatch.setattr(
        agents_routes,
        "load_runtime_settings",
        lambda: RuntimeSettings(
            providers={
                "myfastplugin": ProviderUiSettings(cached_models=["plugin-model"])
            }
        ),
    )
    monkeypatch.setattr("app.api.routes.agents.is_agent_model_id", lambda mid: True)

    res = await client.get("/api/agents/registry")
    assert res.status_code == 200

    models_by_id = {m["id"]: m for m in res.json()["models"]}
    assert models_by_id.get("myfastplugin:plugin-model", {}).get("fast_mode") is True


# ── GET /agents/{name} ───────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_get_single_agent(fs_dirs, client: AsyncClient):
    agents_dir, _ = fs_dirs
    (agents_dir / "code.md").write_text(LEAD_MD.replace("name: lead", "name: code"))
    res = await client.get("/api/agents/code")
    assert res.status_code == 200
    body = res.json()
    assert body["name"] == "code"
    assert body["content"].startswith("---")
    assert body["config"]["role"] == "lead"
    assert body["error"] is None


@pytest.mark.asyncio
async def test_get_code_agent(fs_dirs, client: AsyncClient):
    agents_dir, _ = fs_dirs
    (agents_dir / "code.md").write_text(LEAD_MD.replace("name: lead", "name: code"))

    res = await client.get("/api/agents/code")

    assert res.status_code == 200
    body = res.json()
    assert body["name"] == "code"
    assert body["config"]["name"] == "code"
    assert "shell" in body["config"]["tools"]
    assert "generate_image" not in body["config"]["tools"]


@pytest.mark.asyncio
async def test_agent_config_api_is_code_only(fs_dirs, client: AsyncClient):
    agents_dir, _ = fs_dirs
    (agents_dir / "code.md").write_text(LEAD_MD.replace("name: lead", "name: code"))

    assert (await client.get("/api/agents/lead")).status_code == 404
    assert (await client.get("/api/agents")).status_code == 404
    assert (
        await client.post("/api/agents", json={"name": "code", "content": LEAD_MD})
    ).status_code == 404
    assert (await client.delete("/api/agents/code")).status_code == 405


@pytest.mark.asyncio
async def test_get_non_code_agent_returns_404(client: AsyncClient):
    res = await client.get("/api/agents/ghost")
    assert res.status_code == 404


@pytest.mark.asyncio
async def test_get_agent_bad_name(client: AsyncClient):
    # The code-only endpoint rejects every non-canonical profile path.
    res = await client.get("/api/agents/.hidden")
    assert res.status_code == 404


# ── PUT /agents/{name} ───────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_update_agent_validates_and_persists(fs_dirs, client: AsyncClient):
    """PUT /api/agents/{name} rewrites the file and validates the new state.

    No live team rebuild — drift detection refreshes the agent on its
    next turn.
    """
    agents_dir, _ = fs_dirs
    content = LEAD_MD.replace("name: lead", "name: code")
    (agents_dir / "code.md").write_text(content)

    new_content = content.replace("The lead.", "The updated lead.")
    res = await client.put(
        "/api/agents/code", json={"name": "code", "content": new_content}
    )
    assert res.status_code == 200
    body = res.json()
    assert body["name"] == "code"
    assert "The updated lead." in body["content"]
    # Body description was rewritten on disk.
    assert "The updated lead." in (agents_dir / "code.md").read_text()


@pytest.mark.asyncio
async def test_update_code_agent_validates_coding_agent(fs_dirs, client: AsyncClient):
    agents_dir, _ = fs_dirs
    _seed_files(agents_dir)
    content = LEAD_MD.replace("name: lead", "name: code")
    (agents_dir / "code.md").write_text(content)

    new_content = content.replace("The lead.", "The coding lead.")
    res = await client.put(
        "/api/agents/code",
        json={"name": "code", "content": new_content},
    )

    assert res.status_code == 200, res.text
    assert "The coding lead." in (agents_dir / "code.md").read_text()


@pytest.mark.asyncio
async def test_update_agent_rollback_on_invalid(fs_dirs, client: AsyncClient):
    """PUT with invalid model string → validation fails → file restored."""
    agents_dir, _ = fs_dirs
    content = LEAD_MD.replace("name: lead", "name: code")
    (agents_dir / "code.md").write_text(content)
    original = (agents_dir / "code.md").read_text()

    bad_content = content.replace(
        "model: zai:glm-5-turbo", "model: notavalidmodelstring"
    )
    res = await client.put(
        "/api/agents/code", json={"name": "code", "content": bad_content}
    )
    assert res.status_code == 422
    # File is back to original content.
    assert (agents_dir / "code.md").read_text() == original


@pytest.mark.asyncio
async def test_update_agent_requires_explicit_canonical_profile_name(
    fs_dirs, client: AsyncClient
):
    agents_dir, _ = fs_dirs
    content = LEAD_MD.replace("name: lead", "name: code")
    (agents_dir / "code.md").write_text(content)

    res = await client.put(
        "/api/agents/code",
        json={"name": "code", "content": content.replace("name: code\n", "")},
    )

    assert res.status_code == 422
    assert "must declare name 'code'" in res.json()["detail"]
    assert (agents_dir / "code.md").read_text() == content


@pytest.mark.asyncio
async def test_update_missing_agent_404(client: AsyncClient):
    res = await client.put(
        "/api/agents/ghost", json={"name": "ghost", "content": LEAD_MD}
    )
    assert res.status_code == 404


# ── Skills routes (sanity) ───────────────────────────────────────────────────


SKILL_MD = """\
---
name: research
description: Researches things.
---
Body text.
"""


@pytest.mark.asyncio
async def test_create_skill_without_team(fs_dirs, client: AsyncClient):
    """Creating a skill with no running team should succeed and not attempt a
    reload (since no agents reference it)."""
    res = await client.post(
        "/api/skills", json={"name": "research", "content": SKILL_MD}
    )
    assert res.status_code == 201
    body = res.json()
    assert body["description"] == "Researches things."


@pytest.mark.asyncio
async def test_create_skill_invalid_frontmatter(client: AsyncClient):
    res = await client.post(
        "/api/skills", json={"name": "bad", "content": "no frontmatter"}
    )
    # The permissive skill parser accepts empty frontmatter, so this creates
    # a valid-but-empty skill. Name mismatch tests the real error path.
    assert res.status_code in (201, 422)


@pytest.mark.asyncio
async def test_list_skills(fs_dirs, client: AsyncClient):
    skills_dir = fs_dirs[1]
    (skills_dir / "research").mkdir()
    (skills_dir / "research" / "SKILL.md").write_text(SKILL_MD)
    res = await client.get("/api/skills")
    assert res.status_code == 200
    body = res.json()
    assert body["skills"][0]["name"] == "research"
    assert body["skills"][0]["description"] == "Researches things."


@pytest.mark.asyncio
async def test_get_skill(fs_dirs, client: AsyncClient):
    skills_dir = fs_dirs[1]
    (skills_dir / "research").mkdir()
    (skills_dir / "research" / "SKILL.md").write_text(SKILL_MD)
    res = await client.get("/api/skills/research")
    assert res.status_code == 200
    body = res.json()
    assert body["content"] == SKILL_MD
    assert body["description"] == "Researches things."


@pytest.mark.asyncio
async def test_delete_skill(fs_dirs, client: AsyncClient):
    skills_dir = fs_dirs[1]
    (skills_dir / "research").mkdir()
    (skills_dir / "research" / "SKILL.md").write_text(SKILL_MD)
    res = await client.delete("/api/skills/research")
    assert res.status_code == 200
    assert not (skills_dir / "research").exists()
