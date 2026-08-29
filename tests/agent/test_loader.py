"""Tests for app/agent/loader.py — single-agent loader."""

from __future__ import annotations

from pathlib import Path
from unittest.mock import MagicMock

import pytest
import yaml

from app.agent.loader import (
    AgentConfig,
    _build_agent,
    _default_tool_registry,
    load_agent_from_dir,
    parse_agent_md,
    rebuild_agent_from_disk,
)


def _make_provider_factory():
    mock_provider = MagicMock()
    mock_provider.stream = MagicMock()

    def factory(model_str: str | None, model_kwargs: dict | None = None):
        return mock_provider

    return factory, mock_provider


def _write_agent_md(
    path: Path, frontmatter: dict, body: str = "You are a bot."
) -> Path:
    fm = yaml.dump(frontmatter, default_flow_style=False).strip()
    path.write_text(f"---\n{fm}\n---\n\n{body}\n")
    return path


def _make_agents_dir(tmp_path: Path, agents: list[dict]) -> Path:
    d = tmp_path / "agents"
    d.mkdir(parents=True, exist_ok=True)
    for a in agents:
        body = a.pop("_body", "You are an agent.")
        name = a.get("name", "agent")
        _write_agent_md(d / f"{name}.md", a, body)
    return d


def test_agent_config_defaults():
    cfg = AgentConfig(name="bot")
    assert cfg.name == "bot"
    assert cfg.tools == []
    assert cfg.description is None
    assert cfg.model is None
    assert cfg.system_prompt == ""


def test_agent_config_model_format_validation():
    with pytest.raises(ValueError, match="invalid model"):
        AgentConfig(name="bot", model="gemini-3.1-flash")


def test_agent_config_valid_model():
    cfg = AgentConfig(name="bot", model="googlegenai:gemini-3.1-flash")
    assert cfg.model == "googlegenai:gemini-3.1-flash"


def test_parse_agent_md_basic(tmp_path):
    f = tmp_path / "openagentd.md"
    _write_agent_md(f, {"name": "openagentd", "model": "zai:glm-5-turbo"})
    cfg = parse_agent_md(f)
    assert cfg.name == "openagentd"
    assert cfg.model == "zai:glm-5-turbo"
    assert cfg.system_prompt == "You are a bot."


def test_parse_agent_md_missing_frontmatter_raises(tmp_path):
    f = tmp_path / "bad.md"
    f.write_text("Just raw text")
    with pytest.raises(ValueError, match="missing frontmatter"):
        parse_agent_md(f)


def test_build_agent_default_tools():
    factory, mock_provider = _make_provider_factory()
    cfg = AgentConfig(
        name="openagentd",
        model="zai:glm-5-turbo",
        tools=["read", "grep"],
    )
    tools = _default_tool_registry()
    agent = _build_agent(cfg, tools, factory)
    assert agent.name == "openagentd"
    tool_names = {t.name for t in agent._tools.values()}
    assert "read" in tool_names
    assert "grep" in tool_names
    assert "todo_manage" in tool_names
    assert "skill" in tool_names


def test_load_agent_from_dir(tmp_path):
    d = _make_agents_dir(
        tmp_path,
        [
            {
                "name": "code",
                "model": "zai:glm-5-turbo",
                "tools": ["read"],
            }
        ],
    )
    factory, _ = _make_provider_factory()
    session = load_agent_from_dir(d, provider_factory=factory)
    assert session is not None
    assert session.name == "code"
    assert "read" in session.agent._tools


def test_load_agent_from_dir_requires_canonical_code_profile(tmp_path):
    d = tmp_path / "agents"
    d.mkdir()
    _write_agent_md(d / "other.md", {"name": "other", "model": "zai:glm-5-turbo"})
    factory, _ = _make_provider_factory()
    assert load_agent_from_dir(d, provider_factory=factory) is None


def test_load_agent_from_dir_rejects_mismatched_code_profile_name(tmp_path):
    d = tmp_path / "agents"
    d.mkdir()
    _write_agent_md(d / "code.md", {"name": "other", "model": "zai:glm-5-turbo"})
    factory, _ = _make_provider_factory()
    with pytest.raises(ValueError, match="must declare name 'code'"):
        load_agent_from_dir(d, provider_factory=factory)


def test_load_agent_from_dir_requires_explicit_canonical_profile_name(tmp_path):
    d = tmp_path / "agents"
    d.mkdir()
    _write_agent_md(d / "code.md", {"model": "zai:glm-5-turbo"})
    factory, _ = _make_provider_factory()
    with pytest.raises(ValueError, match="must declare name 'code'"):
        load_agent_from_dir(d, provider_factory=factory)


def test_rebuild_agent_from_disk(tmp_path):
    f = _write_agent_md(
        tmp_path / "openagentd.md",
        {"name": "openagentd", "model": "zai:glm-5-turbo", "tools": ["patch"]},
    )
    factory, _ = _make_provider_factory()
    agent = rebuild_agent_from_disk(f, provider_factory=factory)
    assert agent.name == "openagentd"
    assert "patch" in agent._tools
