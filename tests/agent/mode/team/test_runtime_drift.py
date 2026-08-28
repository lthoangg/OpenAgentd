"""Live-config drift detection and in-place agent rebuild on ``SessionRuntime``."""

from __future__ import annotations

import asyncio
import os
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock

import pytest
import yaml

from app.agent.agent_loop import Agent
from app.agent.loader import _build_agent, parse_agent_md
from app.agent.mode.team.runtime import SessionRuntime


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


def _build_runtime(
    tmp_path: Path, fm: dict, body: str = "You are X."
) -> SessionRuntime:
    md = tmp_path / "agents" / f"{fm['name']}.md"
    md.parent.mkdir(exist_ok=True)
    _write_agent(md, fm, body)
    cfg = parse_agent_md(md)
    agent = _build_agent(cfg, {}, _provider_factory(), source_path=md)
    return SessionRuntime(agent)


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

    runtime = _build_runtime(
        _settings_dirs, {"name": "worker", "model": "openai:v1", "tools": []}
    )
    original = runtime.agent
    original_session = runtime.session_id

    md = _settings_dirs / "agents" / "worker.md"
    _write_agent(
        md,
        {"name": "worker", "model": "openai:v2", "tools": ["grep"]},
        body="Updated prompt.",
    )
    _bump_mtime(md)
    runtime._config_dirty = True

    runtime._refresh_agent_from_disk()

    assert runtime.agent is not original
    assert runtime.agent.model_id == "openai:v2"
    assert "grep" in runtime.agent._tools
    assert "Updated prompt." in runtime.agent.system_prompt
    assert runtime._config_dirty is False
    assert runtime.session_id == original_session


@pytest.mark.asyncio
async def test_refresh_closes_replaced_provider(
    _settings_dirs: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import app.agent.loader as _loader

    monkeypatch.setattr(_loader, "build_provider", _provider_factory())
    runtime = _build_runtime(
        _settings_dirs, {"name": "worker", "model": "openai:v1", "tools": []}
    )
    old_provider = runtime.agent.llm_provider
    old_provider.aclose = AsyncMock()

    md = _settings_dirs / "agents" / "worker.md"
    _write_agent(md, {"name": "worker", "model": "openai:v2", "tools": []})
    _bump_mtime(md)
    runtime._config_dirty = True

    runtime._refresh_agent_from_disk()
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

    runtime = _build_runtime(
        _settings_dirs, {"name": "executor", "model": "openai:v1", "tools": []}
    )
    runtime.name = "executor#2"

    md = _settings_dirs / "agents" / "executor.md"
    _write_agent(md, {"name": "executor", "model": "openai:v2"}, body="Updated.")
    _bump_mtime(md)
    runtime._config_dirty = True

    runtime._refresh_agent_from_disk()

    assert runtime.agent.name == "executor#2"
    assert runtime.name == "executor#2"
    assert "Updated." in runtime.agent.system_prompt


def test_refresh_keeps_agent_on_parse_failure(_settings_dirs: Path) -> None:
    runtime = _build_runtime(
        _settings_dirs, {"name": "worker", "model": "openai:v1", "tools": []}
    )
    original = runtime.agent

    md = _settings_dirs / "agents" / "worker.md"
    md.write_text("not valid frontmatter")
    _bump_mtime(md)
    runtime._config_dirty = True

    runtime._refresh_agent_from_disk()

    assert runtime.agent is original
    assert runtime._config_dirty is False  # cleared to avoid loop


def test_refresh_does_not_inject_teammates_section(
    _settings_dirs: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Guard against the retired teammate roster reappearing in the prompt.

    ``_refresh_agent_from_disk`` rebuilds the system prompt from the ``.md``
    file, so a regression that re-added roster context would surface here.
    """
    import app.agent.loader as _loader

    monkeypatch.setattr(
        _loader,
        "build_provider",
        _provider_factory(),
    )

    worker = _build_runtime(_settings_dirs, {"name": "worker", "model": "openai:v1"})
    _build_runtime(_settings_dirs, {"name": "peer", "model": "openai:v1"})

    md = _settings_dirs / "agents" / "worker.md"
    _write_agent(md, {"name": "worker", "model": "openai:v2"}, body="New body.")
    _bump_mtime(md)
    worker._config_dirty = True

    worker._refresh_agent_from_disk()

    assert "## Teammates" not in worker.agent.system_prompt
    assert "**peer**" not in worker.agent.system_prompt


# ── Drift detection (end-of-turn flag) ───────────────────────────────────────


def test_detect_drift_flips_dirty_on_md_change(_settings_dirs: Path) -> None:
    runtime = _build_runtime(_settings_dirs, {"name": "worker", "model": "openai:v1"})
    md = _settings_dirs / "agents" / "worker.md"

    md.write_text(md.read_text() + "\nappended\n")
    _bump_mtime(md)

    runtime._detect_config_drift()
    assert runtime._config_dirty is True


def test_detect_drift_flips_dirty_on_mcp_json_change(_settings_dirs: Path) -> None:
    runtime = _build_runtime(_settings_dirs, {"name": "worker", "model": "openai:v1"})
    mcp = _settings_dirs / "mcp.json"

    mcp.write_text("{}")  # appearance counts as drift

    runtime._detect_config_drift()
    assert runtime._config_dirty is True


def test_detect_drift_noop_for_in_memory_agent() -> None:
    """Agent built without source_path has no stamp; drift check is a no-op."""
    agent = Agent(name="x", llm_provider=MagicMock())
    runtime = SessionRuntime(agent)

    runtime._detect_config_drift()

    assert runtime._config_dirty is False
