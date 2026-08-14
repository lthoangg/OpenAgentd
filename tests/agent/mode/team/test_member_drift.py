"""End-to-end drift tests: detection + in-place agent rebuild."""

from __future__ import annotations

import asyncio
import os
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock

import pytest
import yaml

from app.agent.agent_loop import Agent
from app.agent.loader import _build_agent, parse_agent_md
from app.agent.mode.team.member import TeamMember


def _write_agent(path: Path, fm: dict, body: str = "You are X.") -> None:
    path.write_text(f"---\n{yaml.dump(fm).strip()}\n---\n\n{body}\n")


def _provider_factory():
    """Factory returning a fresh MagicMock per call (so model swaps are visible)."""

    def factory(model: str | None, model_kwargs: dict | None = None):
        p = MagicMock()
        p.model = model
        return p

    return factory


def _bump_mtime(path: Path) -> None:
    """Force mtime forward without sleep."""
    s = path.stat()
    os.utime(path, ns=(s.st_mtime_ns + 1_000_000, s.st_mtime_ns + 1_000_000))


@pytest.fixture
def _settings_dirs(tmp_path: Path, monkeypatch):
    """Point settings at a tmp config tree."""
    from app.core.config import settings

    settings.OPENAGENTD_CONFIG_DIR = str(tmp_path)
    settings.SKILLS_DIR = str(tmp_path / "skills")
    return tmp_path


def _build_member(tmp_path: Path, fm: dict, body: str = "You are X.") -> TeamMember:
    md = tmp_path / "agents" / f"{fm['name']}.md"
    md.parent.mkdir(exist_ok=True)
    _write_agent(md, fm, body)
    cfg = parse_agent_md(md)
    agent = _build_agent(cfg, {}, _provider_factory(), source_path=md)
    return TeamMember(agent)


# ── Refresh (start-of-turn rebuild) ──────────────────────────────────────────


def test_refresh_replaces_agent_in_place(
    _settings_dirs: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import app.agent.loader as _loader

    monkeypatch.setattr(
        _loader,
        "build_provider",
        _provider_factory(),
    )

    member = _build_member(
        _settings_dirs, {"name": "worker", "model": "openai:v1", "tools": []}
    )
    original = member.agent
    original_session = member.session_id

    md = _settings_dirs / "agents" / "worker.md"
    _write_agent(
        md,
        {"name": "worker", "model": "openai:v2", "tools": ["grep"]},
        body="Updated prompt.",
    )
    _bump_mtime(md)
    member._config_dirty = True

    member._refresh_agent_from_disk()

    assert member.agent is not original
    assert member.agent.model_id == "openai:v2"
    assert "grep" in member.agent._tools
    assert "Updated prompt." in member.agent.system_prompt
    assert member._config_dirty is False
    assert member.session_id == original_session


@pytest.mark.asyncio
async def test_refresh_closes_replaced_provider(
    _settings_dirs: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import app.agent.loader as _loader

    monkeypatch.setattr(_loader, "build_provider", _provider_factory())
    member = _build_member(
        _settings_dirs, {"name": "worker", "model": "openai:v1", "tools": []}
    )
    old_provider = member.agent.llm_provider
    old_provider.aclose = AsyncMock()

    md = _settings_dirs / "agents" / "worker.md"
    _write_agent(md, {"name": "worker", "model": "openai:v2", "tools": []})
    _bump_mtime(md)
    member._config_dirty = True

    member._refresh_agent_from_disk()
    await asyncio.sleep(0)

    old_provider.aclose.assert_awaited_once()


def test_refresh_preserves_spawned_instance_handle(
    _settings_dirs: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import app.agent.loader as _loader

    monkeypatch.setattr(
        _loader,
        "build_provider",
        _provider_factory(),
    )

    member = _build_member(
        _settings_dirs, {"name": "executor", "model": "openai:v1", "tools": []}
    )
    member.name = "executor#2"

    md = _settings_dirs / "agents" / "executor.md"
    _write_agent(md, {"name": "executor", "model": "openai:v2"}, body="Updated.")
    _bump_mtime(md)
    member._config_dirty = True

    member._refresh_agent_from_disk()

    assert member.agent.name == "executor#2"
    assert member.name == "executor#2"
    assert "Updated." in member.agent.system_prompt


def test_refresh_keeps_agent_on_parse_failure(_settings_dirs: Path) -> None:
    member = _build_member(
        _settings_dirs, {"name": "worker", "model": "openai:v1", "tools": []}
    )
    original = member.agent

    md = _settings_dirs / "agents" / "worker.md"
    md.write_text("not valid frontmatter")
    _bump_mtime(md)
    member._config_dirty = True

    member._refresh_agent_from_disk()

    assert member.agent is original
    assert member._config_dirty is False  # cleared to avoid loop


def test_refresh_does_not_inject_teammates_section(
    _settings_dirs: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Dynamic teammate roster is runtime context, not refreshed system prompt."""
    import app.agent.loader as _loader

    monkeypatch.setattr(
        _loader,
        "build_provider",
        _provider_factory(),
    )

    worker = _build_member(_settings_dirs, {"name": "worker", "model": "openai:v1"})
    peer = _build_member(_settings_dirs, {"name": "peer", "model": "openai:v1"})

    # Stub the team — only the bits _refresh_agent_from_disk reads.
    fake_team = MagicMock()
    fake_team.lead = worker
    fake_team.all_members = [worker, peer]
    worker._team = fake_team

    md = _settings_dirs / "agents" / "worker.md"
    _write_agent(md, {"name": "worker", "model": "openai:v2"}, body="New body.")
    _bump_mtime(md)
    worker._config_dirty = True

    worker._refresh_agent_from_disk()

    assert "## Teammates" not in worker.agent.system_prompt
    assert "**peer**" not in worker.agent.system_prompt


# ── Drift detection (end-of-turn flag) ───────────────────────────────────────


def test_detect_drift_flips_dirty_on_md_change(_settings_dirs: Path) -> None:
    member = _build_member(_settings_dirs, {"name": "worker", "model": "openai:v1"})
    md = _settings_dirs / "agents" / "worker.md"

    md.write_text(md.read_text() + "\nappended\n")
    _bump_mtime(md)

    member._detect_config_drift()
    assert member._config_dirty is True


def test_detect_drift_flips_dirty_on_mcp_json_change(_settings_dirs: Path) -> None:
    member = _build_member(_settings_dirs, {"name": "worker", "model": "openai:v1"})
    mcp = _settings_dirs / "mcp.json"

    mcp.write_text("{}")  # appearance counts as drift

    member._detect_config_drift()
    assert member._config_dirty is True


def test_detect_drift_noop_for_in_memory_agent() -> None:
    """Agent built without source_path has no stamp; drift check is a no-op."""
    agent = Agent(name="x", llm_provider=MagicMock())
    member = TeamMember(agent)

    member._detect_config_drift()

    assert member._config_dirty is False
