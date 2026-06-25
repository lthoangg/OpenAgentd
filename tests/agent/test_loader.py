"""Tests for app/agent/loader.py — flat per-agent .md format."""

from __future__ import annotations

from pathlib import Path
from unittest.mock import MagicMock

import pytest
import yaml

from app.agent.agent_loop import Agent
from app.agent.loader import (
    AgentConfig,
    _build_agent,
    _default_tool_registry,
    parse_agent_md,
)


# ---------------------------------------------------------------------------
# Helpers / fixtures
# ---------------------------------------------------------------------------


def _make_provider_factory():
    """Return a dummy provider factory that creates a MagicMock provider."""
    mock_provider = MagicMock()
    mock_provider.stream = MagicMock()

    def factory(model_str: str | None, model_kwargs: dict | None = None):
        return mock_provider

    return factory, mock_provider


def _write_agent_md(
    path: Path, frontmatter: dict, body: str = "You are a bot."
) -> Path:
    """Write a single agent .md file with frontmatter + body."""
    fm = yaml.dump(frontmatter, default_flow_style=False).strip()
    path.write_text(f"---\n{fm}\n---\n\n{body}\n")
    return path


def _make_agents_dir(
    tmp_path: Path, agents: list[dict], team_meta: dict | None = None
) -> Path:
    """Create an agents/ directory with .md files and optional team.yaml."""
    d = tmp_path / "agents"
    d.mkdir()
    for a in agents:
        body = a.pop("_body", "You are an agent.")
        name = a.get("name", "agent")
        _write_agent_md(d / f"{name}.md", a, body)
    if team_meta is not None:
        (d / "team.yaml").write_text(yaml.dump(team_meta))
    return d


# ---------------------------------------------------------------------------
# AgentConfig schema
# ---------------------------------------------------------------------------


def test_agent_config_defaults():
    cfg = AgentConfig(name="bot")
    assert cfg.role == "member"
    assert cfg.tools == []
    assert cfg.description is None
    assert cfg.model is None
    assert cfg.system_prompt == ""


def test_agent_config_role_lead():
    cfg = AgentConfig(name="lead", role="lead")
    assert cfg.role == "lead"


def test_agent_config_invalid_role_raises():
    with pytest.raises(Exception):
        AgentConfig(name="bot", role="coordinator")  # type: ignore[arg-type]


def test_agent_config_model_format_validation():
    with pytest.raises(ValueError, match="invalid model"):
        AgentConfig(name="bot", model="gemini-3.1-flash")  # missing provider prefix


def test_agent_config_valid_model():
    cfg = AgentConfig(name="bot", model="googlegenai:gemini-3.1-flash")
    assert cfg.model == "googlegenai:gemini-3.1-flash"


def test_agent_config_fallback_model_defaults_to_none():
    cfg = AgentConfig(name="bot")
    assert cfg.fallback_model is None


# ---------------------------------------------------------------------------
# parse_agent_md
# ---------------------------------------------------------------------------


def test_parse_agent_md_basic(tmp_path):
    f = tmp_path / "bot.md"
    _write_agent_md(f, {"name": "bot", "role": "member", "model": "zai:glm-5-turbo"})
    cfg = parse_agent_md(f)
    assert cfg.name == "bot"
    assert cfg.role == "member"
    assert cfg.model == "zai:glm-5-turbo"
    assert cfg.system_prompt == "You are a bot."


def test_parse_agent_md_lead_role(tmp_path):
    f = tmp_path / "lead.md"
    _write_agent_md(
        f,
        {"name": "lead", "role": "lead", "model": "googlegenai:gemini-pro"},
        "Lead prompt.",
    )
    cfg = parse_agent_md(f)
    assert cfg.role == "lead"
    assert cfg.system_prompt == "Lead prompt."


def test_parse_agent_md_name_defaults_to_stem(tmp_path):
    f = tmp_path / "myagent.md"
    _write_agent_md(f, {"role": "member", "model": "zai:glm-5-turbo"})
    cfg = parse_agent_md(f)
    assert cfg.name == "myagent"


def test_parse_agent_md_missing_frontmatter_raises(tmp_path):
    f = tmp_path / "bad.md"
    f.write_text("No frontmatter here.")
    with pytest.raises(ValueError, match="missing YAML frontmatter"):
        parse_agent_md(f)


def test_parse_agent_md_empty_body_gets_default_prompt(tmp_path):
    f = tmp_path / "bot.md"
    f.write_text("---\nname: bot\n---\n")
    cfg = parse_agent_md(f)
    assert cfg.system_prompt == "You are a helpful assistant."


def test_parse_agent_md_full_frontmatter(tmp_path):
    f = tmp_path / "agent.md"
    _write_agent_md(
        f,
        {
            "name": "agent",
            "role": "member",
            "model": "openai:gpt-4o",
            "temperature": 0.3,
            "thinking_level": "low",
            "tools": ["read", "shell"],
            "skills": ["example-skill"],
            "description": "Does things.",
        },
        "Custom prompt.",
    )
    cfg = parse_agent_md(f)
    assert cfg.temperature == 0.3
    assert cfg.thinking_level == "low"
    assert cfg.tools == ["read", "shell"]
    assert cfg.skills == ["example-skill"]
    assert cfg.description == "Does things."
    assert cfg.system_prompt == "Custom prompt."


# ---------------------------------------------------------------------------
# _default_tool_registry
# ---------------------------------------------------------------------------


def test_default_tool_registry_keys():
    registry = _default_tool_registry()
    expected = {
        "web_search",
        "web_fetch",
        "date",
        "read",
        "write",
        "ls",
        "glob",
        "shell",
        "skill",
        "todo_manage",
    }
    assert expected.issubset(registry.keys())


def test_builtin_openagentd_tools_exist_in_default_registry():
    from app.agent.builtin_prompts import openagentd_tools_for_mode

    registry = _default_tool_registry()

    for mode in ("normal", "coding"):
        missing = set(openagentd_tools_for_mode(mode)) - set(registry)
        assert missing == set()


# ---------------------------------------------------------------------------
# _build_agent
# ---------------------------------------------------------------------------


def test_build_agent_basic(tmp_path):
    factory, _ = _make_provider_factory()
    cfg = AgentConfig(name="bot", system_prompt="Hello agent")
    agent = _build_agent(cfg, {}, factory)
    assert isinstance(agent, Agent)
    assert agent.name == "bot"
    assert agent.system_prompt == "Hello agent"


def test_build_agent_with_tool(tmp_path):
    from app.agent.tools.registry import Tool

    def my_fn(x: int) -> int:
        """A tool."""
        return x

    factory, _ = _make_provider_factory()
    real_tool = Tool(my_fn, name="my_tool", description="A tool")
    cfg = AgentConfig(name="bot", tools=["my_tool"])
    agent = _build_agent(cfg, {"my_tool": real_tool}, factory)
    assert "my_tool" in agent._tools


def test_build_agent_unknown_tool_is_skipped():
    """Unknown tool name is logged and skipped — agent still loads.

    Soft-skip lets dynamic capability changes (team_manage, mcp.json edits)
    leave stale names in frontmatter without breaking agent rebuild.
    """
    factory, _ = _make_provider_factory()
    cfg = AgentConfig(name="bot", tools=["nonexistent_tool"])
    agent = _build_agent(cfg, {}, factory)
    assert "nonexistent_tool" not in agent._tools


def _make_tool(name: str):
    from app.agent.tools.registry import Tool

    def fn() -> str:
        """Stub."""
        return name

    return Tool(fn, name=name, description=name)


def test_build_agent_mcp_servers_inject_tools(monkeypatch):
    factory, _ = _make_provider_factory()
    fs_read = _make_tool("mcp_filesystem_read_file")
    fs_write = _make_tool("mcp_filesystem_write_file")
    gh_list = _make_tool("mcp_github_list_repos")

    from app.agent.mcp import mcp_manager

    def fake_get(server: str):
        return {
            "filesystem": [fs_read, fs_write],
            "github": [gh_list],
        }.get(server)

    monkeypatch.setattr(mcp_manager, "get_tools_for_server", fake_get)
    monkeypatch.setattr(mcp_manager, "server_names", lambda: ["filesystem", "github"])

    cfg = AgentConfig(name="bot", mcp=["filesystem"])
    agent = _build_agent(cfg, {}, factory)
    assert "mcp_filesystem_read_file" in agent._tools
    assert "mcp_filesystem_write_file" in agent._tools
    assert "mcp_github_list_repos" not in agent._tools


def test_build_agent_mcp_unknown_server_is_skipped(monkeypatch):
    """Unknown MCP server is logged and skipped — agent still loads.

    Same rationale as ``test_build_agent_unknown_tool_is_skipped``: an MCP
    server may be removed from ``mcp.json`` after a member's frontmatter
    references it, and we want the next drift-rebuild to succeed.
    """
    factory, _ = _make_provider_factory()
    from app.agent.mcp import mcp_manager

    monkeypatch.setattr(mcp_manager, "get_tools_for_server", lambda _: None)
    monkeypatch.setattr(mcp_manager, "server_names", list)

    cfg = AgentConfig(name="bot", mcp=["does_not_exist"])
    agent = _build_agent(cfg, {}, factory)
    # No tools from the unknown server; only the always-on ``skill`` tool.
    assert "skill" in agent._tools
    assert len(agent._tools) == 1


def test_build_agent_mcp_combines_with_tools(monkeypatch):
    factory, _ = _make_provider_factory()
    fs_read = _make_tool("mcp_filesystem_read_file")
    web = _make_tool("web_search")

    from app.agent.mcp import mcp_manager

    monkeypatch.setattr(
        mcp_manager,
        "get_tools_for_server",
        lambda s: [fs_read] if s == "filesystem" else None,
    )
    monkeypatch.setattr(mcp_manager, "server_names", lambda: ["filesystem"])

    cfg = AgentConfig(name="bot", tools=["web_search"], mcp=["filesystem"])
    agent = _build_agent(cfg, {"web_search": web}, factory)
    assert "web_search" in agent._tools
    assert "mcp_filesystem_read_file" in agent._tools


def test_build_agent_mcp_not_ready_yields_no_tools(monkeypatch):
    """A configured-but-not-ready server is graceful: agent loads with no MCP tools."""
    factory, _ = _make_provider_factory()
    from app.agent.mcp import mcp_manager

    # Empty list (not None) signals "configured but not ready".
    monkeypatch.setattr(mcp_manager, "get_tools_for_server", lambda _: [])
    monkeypatch.setattr(mcp_manager, "server_names", lambda: ["filesystem"])

    cfg = AgentConfig(name="bot", mcp=["filesystem"])
    agent = _build_agent(cfg, {}, factory)
    # Only the auto-injected `skill` tool is present.
    assert "skill" in agent._tools


def test_build_agent_description():
    factory, _ = _make_provider_factory()
    cfg = AgentConfig(name="bot", description="I am a bot")
    agent = _build_agent(cfg, {}, factory)
    assert agent.description == "I am a bot"


def test_build_agent_passes_temperature_and_thinking_level():
    received: dict = {}

    def capturing_factory(model_str, model_kwargs=None):
        received.update(model_kwargs or {})
        return MagicMock()

    cfg = AgentConfig(
        name="bot", system_prompt="hello", temperature=0.5, thinking_level="high"
    )
    _build_agent(cfg, _default_tool_registry(), capturing_factory)
    assert received.get("temperature") == 0.5
    assert received.get("thinking_level") == "high"


def test_build_agent_no_model_kwargs_when_unset():
    received: dict = {}

    def capturing_factory(model_str, model_kwargs=None):
        received.update(model_kwargs or {})
        return MagicMock()

    cfg = AgentConfig(name="bot", system_prompt="hello")
    _build_agent(cfg, _default_tool_registry(), capturing_factory)
    assert received == {}


def test_build_agent_passes_responses_api():
    received: dict = {}

    def capturing_factory(model_str, model_kwargs=None):
        received.update(model_kwargs or {})
        return MagicMock()

    cfg = AgentConfig(name="bot", system_prompt="hello", responses_api=True)
    _build_agent(cfg, _default_tool_registry(), capturing_factory)
    assert received.get("responses_api") is True


def test_build_agent_fallback_provider_created():
    received_models: list = []

    def capturing_factory(model_str, model_kwargs=None):
        received_models.append(model_str)
        return MagicMock()

    cfg = AgentConfig(
        name="bot",
        system_prompt="Hi",
        model="primary:model",
        fallback_model="fallback:model",
    )
    agent = _build_agent(cfg, {}, capturing_factory)
    assert agent.fallback_provider is not None
    assert agent.fallback_model_id == "fallback:model"
    assert received_models == ["primary:model", "fallback:model"]


def test_build_agent_no_fallback_when_not_configured():
    factory, _ = _make_provider_factory()
    cfg = AgentConfig(name="bot", system_prompt="Hi")
    agent = _build_agent(cfg, {}, factory)
    assert agent.fallback_provider is None
    assert agent.fallback_model_id is None


def test_build_agent_skill_tool_deduped():
    factory, _ = _make_provider_factory()
    cfg = AgentConfig(name="bot", system_prompt="Hi", tools=["skill"])
    agent = _build_agent(cfg, {}, factory)
    assert list(agent._tools.keys()).count("skill") == 1


# ---------------------------------------------------------------------------
# Skill prompt handling
# ---------------------------------------------------------------------------


def test_build_agent_skills_do_not_inject_prompt_descriptions(tmp_path, monkeypatch):
    d = tmp_path / "myskill"
    d.mkdir()
    (d / "SKILL.md").write_text(
        "---\nname: myskill\ndescription: A great skill\n---\nInstructions."
    )
    monkeypatch.setattr("app.agent.tools.builtin.skill._SKILLS_DIR", tmp_path)
    factory, _ = _make_provider_factory()
    cfg = AgentConfig(name="bot", system_prompt="Base prompt", skills=["myskill"])
    agent = _build_agent(cfg, {}, factory)
    assert agent.system_prompt == "Base prompt"
    assert agent.skills == ["myskill"]


# ---------------------------------------------------------------------------
# load_team_from_dir
# ---------------------------------------------------------------------------


def test_load_team_from_dir_missing_returns_none(tmp_path):
    from app.agent.loader import load_team_from_dir

    result = load_team_from_dir(tmp_path / "nonexistent")
    assert result is None


def test_load_team_from_dir_empty_dir_returns_none(tmp_path):
    from app.agent.loader import load_team_from_dir

    d = tmp_path / "agents"
    d.mkdir()
    result = load_team_from_dir(d)
    assert result is None


def test_load_team_from_dir_no_lead_raises(tmp_path):
    from app.agent.loader import load_team_from_dir

    d = _make_agents_dir(
        tmp_path,
        [
            {"name": "worker", "role": "member", "model": "zai:glm-5-turbo"},
        ],
    )
    factory, _ = _make_provider_factory()
    with pytest.raises(ValueError, match="role: lead"):
        load_team_from_dir(d, provider_factory=factory)


def test_load_team_from_dir_multiple_leads_raises(tmp_path):
    from app.agent.loader import load_team_from_dir

    d = _make_agents_dir(
        tmp_path,
        [
            {"name": "lead1", "role": "lead", "model": "zai:glm-5-turbo"},
            {"name": "lead2", "role": "lead", "model": "zai:glm-5-turbo"},
        ],
    )
    factory, _ = _make_provider_factory()
    with pytest.raises(ValueError, match="Multiple agents with 'role: lead'"):
        load_team_from_dir(d, provider_factory=factory)


def test_load_team_from_dir_valid_minimal(tmp_path):
    from app.agent.loader import load_team_from_dir

    d = _make_agents_dir(
        tmp_path,
        [
            {"name": "lead", "role": "lead", "model": "zai:glm-5-turbo"},
        ],
    )
    factory, _ = _make_provider_factory()
    team = load_team_from_dir(d, provider_factory=factory)
    assert team is not None
    assert team.lead.name == "lead"
    assert set(team.blueprints) == {"executor", "explorer"}
    assert team.members == {}


def test_load_team_from_dir_materializes_coding_builtin_members(tmp_path):
    from app.agent.builtin_prompts import BUILTIN_MEMBER_PROFILES
    from app.agent.loader import load_team_from_dir

    d = _make_agents_dir(
        tmp_path,
        [
            {"name": "openagentd", "role": "lead", "model": "zai:glm-5-turbo"},
        ],
    )
    factory, _ = _make_provider_factory()
    team = load_team_from_dir(d, provider_factory=factory, mode="coding")
    assert team is not None
    assert set(team.blueprints) == {"coder", "explorer"}
    assert (d / "coder.md").is_file()
    assert (d / "explorer.md").is_file()
    assert "model: zai:glm-5-turbo" in (d / "explorer.md").read_text(encoding="utf-8")
    assert (
        team.blueprints["explorer"].description
        == BUILTIN_MEMBER_PROFILES["coding"]["explorer"]["description"]
    )


def test_load_team_from_dir_does_not_overwrite_existing_builtin_member(tmp_path):
    from app.agent.loader import load_team_from_dir

    d = _make_agents_dir(
        tmp_path,
        [
            {"name": "openagentd", "role": "lead", "model": "zai:glm-5-turbo"},
            {
                "name": "explorer",
                "role": "member",
                "description": "Custom explorer.",
                "model": "zai:glm-5-turbo",
                "_body": "Keep this prompt.",
            },
        ],
    )
    before = (d / "explorer.md").read_text(encoding="utf-8")
    factory, _ = _make_provider_factory()
    team = load_team_from_dir(d, provider_factory=factory, mode="coding")
    assert team is not None
    assert set(team.blueprints) == {"coder", "explorer"}
    assert (d / "explorer.md").read_text(encoding="utf-8") == before
    assert team.blueprints["explorer"].description == "Custom explorer."


def test_coding_mode_hides_retired_executor_member(tmp_path):
    from app.agent.loader import load_team_from_dir

    d = _make_agents_dir(
        tmp_path,
        [
            {"name": "openagentd", "role": "lead", "model": "zai:glm-5-turbo"},
            {"name": "executor", "role": "member", "model": "zai:glm-5-turbo"},
        ],
    )
    factory, _ = _make_provider_factory()
    team = load_team_from_dir(d, provider_factory=factory, mode="coding")
    assert team is not None
    assert set(team.blueprints) == {"coder", "explorer"}


def test_openagentd_lead_uses_builtin_prompt_with_extra(tmp_path):
    from app.agent.builtin_prompts import NORMAL_OPENAGENTD_PROMPT
    from app.agent.loader import load_team_from_dir

    d = _make_agents_dir(
        tmp_path,
        [
            {
                "name": "openagentd",
                "role": "lead",
                "model": "zai:glm-5-turbo",
                "_body": "Prefer concise answers.",
            },
        ],
    )
    factory, _ = _make_provider_factory()
    team = load_team_from_dir(d, provider_factory=factory)
    assert team is not None
    assert team.lead.agent.system_prompt.startswith(NORMAL_OPENAGENTD_PROMPT)
    assert "## User extra prompt" in team.lead.agent.system_prompt
    assert "Prefer concise answers." in team.lead.agent.system_prompt
    assert team.lead.agent.description is not None
    assert "personal on-machine AI assistant" in team.lead.agent.description
    assert "shell" in team.lead.agent._tools
    assert "generate_image" in team.lead.agent._tools
    assert team.lead.agent.skills == []


def test_openagentd_seed_comment_is_not_injected_as_extra_prompt(tmp_path):
    from app.agent.builtin_prompts import NORMAL_OPENAGENTD_PROMPT
    from app.agent.loader import load_team_from_dir

    d = _make_agents_dir(
        tmp_path,
        [
            {
                "name": "openagentd",
                "role": "lead",
                "model": "zai:glm-5-turbo",
                "_body": "<!-- Add extra prompt text below. -->",
            },
        ],
    )
    factory, _ = _make_provider_factory()
    team = load_team_from_dir(d, provider_factory=factory)
    assert team is not None
    assert team.lead.agent.system_prompt.startswith(NORMAL_OPENAGENTD_PROMPT)
    assert "## User extra prompt" not in team.lead.agent.system_prompt
    assert "Add extra prompt text below" not in team.lead.agent.system_prompt


def test_openagentd_file_can_add_tools_and_skills(tmp_path):
    from app.agent.loader import load_team_from_dir

    d = _make_agents_dir(
        tmp_path,
        [
            {
                "name": "openagentd",
                "role": "lead",
                "model": "zai:glm-5-turbo",
                "tools": ["generate_image"],
                "skills": ["custom-skill"],
            },
        ],
    )
    factory, _ = _make_provider_factory()
    team = load_team_from_dir(d, provider_factory=factory)
    assert team is not None
    assert "generate_image" in team.lead.agent._tools
    assert "shell" in team.lead.agent._tools
    assert team.lead.agent.skills == ["custom-skill"]


def test_openagentd_builtin_and_user_capabilities_are_deduped(tmp_path):
    """User overrides are deduped without injecting built-in skills."""
    from app.agent.loader import load_team_from_dir

    d = _make_agents_dir(
        tmp_path,
        [
            {
                "name": "openagentd",
                "role": "lead",
                "model": "zai:glm-5-turbo",
                "tools": ["shell", "generate_image"],
                "skills": ["self-healing", "custom-skill"],
            },
        ],
    )
    factory, _ = _make_provider_factory()
    team = load_team_from_dir(d, provider_factory=factory)
    assert team is not None
    assert list(team.lead.agent._tools).count("shell") == 1
    assert list(team.lead.agent._tools).count("generate_image") == 1
    assert team.lead.agent.skills.count("self-healing") == 1
    assert team.lead.agent.skills.count("custom-skill") == 1


def test_openagentd_user_description_overrides_builtin_description(tmp_path):
    """The code-owned description is only the fallback for first-party profiles."""
    from app.agent.loader import load_team_from_dir

    d = _make_agents_dir(
        tmp_path,
        [
            {
                "name": "openagentd",
                "role": "lead",
                "model": "zai:glm-5-turbo",
                "description": "My local lead.",
            },
        ],
    )
    factory, _ = _make_provider_factory()
    team = load_team_from_dir(d, provider_factory=factory)
    assert team is not None
    assert team.lead.agent.description == "My local lead."


def test_builtin_member_profile_uses_code_defaults_with_extra(tmp_path):
    from app.agent.builtin_prompts import BUILTIN_MEMBER_PROFILES
    from app.agent.loader import rebuild_agent_from_disk

    f = _write_agent_md(
        tmp_path / "executor.md",
        {
            "name": "executor",
            "role": "member",
            "model": "zai:glm-5-turbo",
            "tools": ["generate_image"],
        },
        "Prefer Markdown deliverables.",
    )
    factory, _ = _make_provider_factory()
    agent = rebuild_agent_from_disk(f, provider_factory=factory)
    profile = BUILTIN_MEMBER_PROFILES["normal"]["executor"]
    assert agent.description == profile["description"]
    assert agent.system_prompt.startswith(str(profile["prompt"]))
    assert "## User extra prompt" in agent.system_prompt
    assert "Prefer Markdown deliverables." in agent.system_prompt
    assert "shell" in agent._tools
    assert "generate_image" in agent._tools


def test_builtin_member_profiles_are_curated_to_default_agents():
    from app.agent.builtin_prompts import BUILTIN_MEMBER_PROFILES

    assert set(BUILTIN_MEMBER_PROFILES["normal"]) == {"executor", "explorer"}
    assert set(BUILTIN_MEMBER_PROFILES["coding"]) == {"coder", "explorer"}


def test_builtin_member_user_description_overrides_code_default(tmp_path):
    from app.agent.loader import rebuild_agent_from_disk

    f = _write_agent_md(
        tmp_path / "executor.md",
        {
            "name": "executor",
            "role": "member",
            "model": "zai:glm-5-turbo",
            "description": "Project-specific executor.",
        },
        "Extra execution rule.",
    )
    factory, _ = _make_provider_factory()
    agent = rebuild_agent_from_disk(f, provider_factory=factory)
    assert agent.description == "Project-specific executor."
    assert "Extra execution rule." in agent.system_prompt


def test_coding_builtin_member_profile_is_mode_scoped(tmp_path):
    from app.agent.builtin_prompts import BUILTIN_MEMBER_PROFILES
    from app.agent.loader import rebuild_agent_from_disk

    f = _write_agent_md(
        tmp_path / "coder.md",
        {"name": "coder", "role": "member", "model": "zai:glm-5-turbo"},
        "<!-- Add extra prompt text below. -->",
    )
    factory, _ = _make_provider_factory()
    normal_agent = rebuild_agent_from_disk(f, provider_factory=factory)
    coding_agent = rebuild_agent_from_disk(f, provider_factory=factory, mode="coding")
    profile = BUILTIN_MEMBER_PROFILES["coding"]["coder"]
    assert normal_agent.system_prompt == "<!-- Add extra prompt text below. -->"
    assert coding_agent.description == profile["description"]
    assert coding_agent.system_prompt == profile["prompt"]
    assert "shell" in coding_agent._tools


def test_coding_explorer_builtin_member_profile_checks_codebase(tmp_path):
    from app.agent.builtin_prompts import BUILTIN_MEMBER_PROFILES
    from app.agent.loader import rebuild_agent_from_disk

    f = _write_agent_md(
        tmp_path / "explorer.md",
        {"name": "explorer", "role": "member", "model": "zai:glm-5-turbo"},
        "<!-- Add extra prompt text below. -->",
    )
    factory, _ = _make_provider_factory()
    coding_agent = rebuild_agent_from_disk(f, provider_factory=factory, mode="coding")
    profile = BUILTIN_MEMBER_PROFILES["coding"]["explorer"]
    assert coding_agent.description == profile["description"]
    assert coding_agent.system_prompt == profile["prompt"]
    assert "current codebase" in coding_agent.system_prompt
    assert "grep" in coding_agent._tools
    assert "write" not in coding_agent._tools


def test_openagentd_coding_lead_uses_coding_builtin_prompt(tmp_path):
    from app.agent.builtin_prompts import CODING_OPENAGENTD_PROMPT
    from app.agent.loader import load_team_from_dir

    d = _make_agents_dir(
        tmp_path,
        [
            {
                "name": "openagentd",
                "role": "lead",
                "model": "zai:glm-5-turbo",
                "_body": "Prefer patch files.",
            },
        ],
    )
    factory, _ = _make_provider_factory()
    team = load_team_from_dir(d, provider_factory=factory, mode="coding")
    assert team is not None
    assert team.lead.agent.system_prompt.startswith(CODING_OPENAGENTD_PROMPT)
    assert "Prefer patch files." in team.lead.agent.system_prompt
    assert team.lead.agent.description is not None
    assert "Lead coding agent" in team.lead.agent.description
    assert "shell" in team.lead.agent._tools
    assert "generate_image" not in team.lead.agent._tools


def test_openagentd_legacy_seed_prompt_is_not_appended(tmp_path):
    from app.agent.builtin_prompts import NORMAL_OPENAGENTD_PROMPT
    from app.agent.loader import load_team_from_dir

    legacy_body = """You are **OpenAgentd** — a personal AI assistant running on the user's own machine.

Old shipped prompt body that should be replaced by the code-owned base prompt.
"""
    d = _make_agents_dir(
        tmp_path,
        [
            {
                "name": "openagentd",
                "role": "lead",
                "model": "zai:glm-5-turbo",
                "_body": legacy_body,
            },
        ],
    )
    factory, _ = _make_provider_factory()
    team = load_team_from_dir(d, provider_factory=factory)
    assert team is not None
    assert team.lead.agent.system_prompt.startswith(NORMAL_OPENAGENTD_PROMPT)
    assert "## User extra prompt" not in team.lead.agent.system_prompt
    assert "Old shipped prompt body" not in team.lead.agent.system_prompt


def test_builtin_member_legacy_seed_prompt_is_not_appended(tmp_path):
    from app.agent.builtin_prompts import BUILTIN_MEMBER_PROFILES
    from app.agent.loader import rebuild_agent_from_disk

    f = _write_agent_md(
        tmp_path / "executor.md",
        {"name": "executor", "role": "member", "model": "zai:glm-5-turbo"},
        'You are "executor".\n\nOld shipped executor prompt body.',
    )
    factory, _ = _make_provider_factory()
    agent = rebuild_agent_from_disk(f, provider_factory=factory)
    assert (
        agent.system_prompt == BUILTIN_MEMBER_PROFILES["normal"]["executor"]["prompt"]
    )


def test_load_team_from_dir_degrades_when_lead_provider_missing_key(tmp_path):
    from app.agent.loader import load_team_from_dir
    from app.agent.providers.unconfigured import UnconfiguredProvider

    d = _make_agents_dir(
        tmp_path,
        [
            {"name": "lead", "role": "lead", "model": "anthropic:claude-sonnet-4"},
        ],
    )

    def factory(model_str: str | None, model_kwargs: dict | None = None):
        raise ValueError("Anthropic API key is required. Set ANTHROPIC_API_KEY.")

    team = load_team_from_dir(d, provider_factory=factory)
    assert team is not None
    assert team.lead.name == "lead"
    assert isinstance(team.lead.agent.llm_provider, UnconfiguredProvider)


def test_load_team_from_dir_skips_unavailable_fallback_provider(tmp_path):
    from app.agent.loader import load_team_from_dir

    d = _make_agents_dir(
        tmp_path,
        [
            {
                "name": "lead",
                "role": "lead",
                "model": "openai:gpt-5.4",
                "fallback_model": "anthropic:claude-sonnet-4",
            },
        ],
    )
    mock_provider = MagicMock()

    def factory(model_str: str | None, model_kwargs: dict | None = None):
        if model_str == "anthropic:claude-sonnet-4":
            raise ValueError("Anthropic API key is required. Set ANTHROPIC_API_KEY.")
        return mock_provider

    team = load_team_from_dir(d, provider_factory=factory)
    assert team is not None
    assert team.lead.agent.llm_provider is mock_provider
    assert team.lead.agent.fallback_provider is None


def test_load_team_from_dir_with_members(tmp_path):
    from app.agent.loader import load_team_from_dir

    d = _make_agents_dir(
        tmp_path,
        [
            {"name": "orchestrator", "role": "lead", "model": "zai:glm-5-turbo"},
            {"name": "worker", "role": "member", "model": "zai:glm-5-turbo"},
        ],
    )
    factory, _ = _make_provider_factory()
    team = load_team_from_dir(d, provider_factory=factory)
    assert team is not None
    # Members are now lazy: they exist as blueprints on the team and are
    # only materialised in ``team.members`` after ``team.spawn(...)``.
    assert "worker" in team.blueprints
    assert team.members == {}


def test_todo_tools_injected_into_lead_only(tmp_path):
    """todo_manage is always present on the lead, never on members."""
    from app.agent.loader import load_team_from_dir, rebuild_agent_from_disk

    d = _make_agents_dir(
        tmp_path,
        [
            {"name": "lead", "role": "lead", "model": "zai:glm-5-turbo"},
            {"name": "worker", "role": "member", "model": "zai:glm-5-turbo"},
        ],
    )
    factory, _ = _make_provider_factory()
    team = load_team_from_dir(d, provider_factory=factory)
    assert team is not None

    lead_tool_names = {t.name for t in team.lead.agent._tools.values()}
    # Members are lazy — build the worker agent from its blueprint to
    # verify what tools it would have when spawned.
    worker_agent = rebuild_agent_from_disk(
        team.blueprints["worker"].source_path, provider_factory=factory
    )
    worker_tool_names = {t.name for t in worker_agent._tools.values()}

    assert "todo_manage" in lead_tool_names
    assert "todo_manage" not in worker_tool_names


def test_load_team_injects_teammates(tmp_path):
    from app.agent.loader import load_team_from_dir

    d = _make_agents_dir(
        tmp_path,
        [
            {
                "name": "lead",
                "role": "lead",
                "model": "zai:glm-5-turbo",
                "description": "The lead",
                "_body": "Base lead",
            },
            {
                "name": "a",
                "role": "member",
                "model": "zai:glm-5-turbo",
                "description": "Worker A",
                "_body": "Base a",
            },
            {
                "name": "b",
                "role": "member",
                "model": "zai:glm-5-turbo",
                "description": "Worker B",
                "_body": "Base b",
            },
        ],
    )
    factory, _ = _make_provider_factory()
    team = load_team_from_dir(d, provider_factory=factory)
    assert team is not None

    # The lead system prompt stays static for prompt caching: the dynamic
    # blueprint/member roster is never injected into it.
    lead_prompt = team.lead.build_protocol(team.lead.agent.system_prompt, team)
    assert "\n## Spawnable blueprints" not in lead_prompt
    assert "Worker A" not in lead_prompt
    assert "Worker B" not in lead_prompt
    # Member protocols are only relevant for live instances; spawning
    # touches the DB, so only verify that the blueprints are registered
    # with the expected descriptions.
    assert team.blueprints["a"].description == "Worker A"
    assert team.blueprints["b"].description == "Worker B"


def test_load_team_skips_unknown_tool(tmp_path):
    """Unknown tool in frontmatter is skipped — team still loads."""
    from app.agent.loader import load_team_from_dir

    d = _make_agents_dir(
        tmp_path,
        [
            {
                "name": "lead",
                "role": "lead",
                "model": "zai:glm-5-turbo",
                "tools": ["nonexistent_tool"],
            },
        ],
    )
    factory, _ = _make_provider_factory()
    team = load_team_from_dir(d, provider_factory=factory)
    assert team is not None
    assert "nonexistent_tool" not in team.lead.agent._tools


def test_load_team_with_extra_tools(tmp_path):
    from app.agent.loader import load_team_from_dir
    from app.agent.tools.registry import Tool

    def custom_fn(x: int) -> int:
        """custom tool."""
        return x

    custom_tool = Tool(custom_fn, name="custom_tool", description="custom")
    d = _make_agents_dir(
        tmp_path,
        [
            {
                "name": "lead",
                "role": "lead",
                "model": "zai:glm-5-turbo",
                "tools": ["custom_tool"],
            },
        ],
    )
    factory, _ = _make_provider_factory()
    team = load_team_from_dir(
        d, provider_factory=factory, extra_tools={"custom_tool": custom_tool}
    )
    assert team is not None
    assert "custom_tool" in team.lead.agent._tools


def test_load_team_discovers_all_agents(tmp_path):
    """All .md files in the directory are parsed and loaded into the team."""
    from app.agent.loader import load_team_from_dir

    d = _make_agents_dir(
        tmp_path,
        [
            {"name": "lead", "role": "lead", "model": "zai:glm-5-turbo"},
            {"name": "worker", "role": "member", "model": "zai:glm-5-turbo"},
            {"name": "helper", "role": "member", "model": "zai:glm-5-turbo"},
        ],
    )
    factory, _ = _make_provider_factory()
    team = load_team_from_dir(d, provider_factory=factory)
    assert team is not None
    assert team.lead.name == "lead"
    # Members are lazy blueprints; nothing is live until spawned.
    assert set(team.blueprints.keys()) == {"executor", "explorer", "worker", "helper"}
    assert team.members == {}


def test_load_team_skips_unconfigured_members(tmp_path):
    """Seed placeholders and blank models should not become spawnable members."""
    from app.agent.loader import load_team_from_dir
    from app.cli.seed import PROVIDER_MODEL_TOKEN

    d = _make_agents_dir(
        tmp_path,
        [
            {"name": "lead", "role": "lead", "model": "zai:glm-5-turbo"},
            {"name": "placeholder", "role": "member", "model": PROVIDER_MODEL_TOKEN},
            {"name": "blank", "role": "member", "model": ""},
            {"name": "missing", "role": "member"},
            {"name": "worker", "role": "member", "model": "zai:glm-5-turbo"},
        ],
    )
    factory, _ = _make_provider_factory()
    team = load_team_from_dir(d, provider_factory=factory)
    assert team is not None
    assert set(team.blueprints.keys()) == {"executor", "explorer", "worker"}


def test_load_team_parse_error_raises(tmp_path):
    from app.agent.loader import load_team_from_dir

    d = tmp_path / "agents"
    d.mkdir()
    (d / "bad.md").write_text("No frontmatter here.")
    factory, _ = _make_provider_factory()
    with pytest.raises(ValueError, match="Failed to parse"):
        load_team_from_dir(d, provider_factory=factory)


# Per-agent summarization config has been removed — see
# app/agent/hooks/summarization.py for the module-level defaults that now
# apply uniformly to all agents.


# ---------------------------------------------------------------------------
# _make_default_provider_factory
# ---------------------------------------------------------------------------


def test_make_default_provider_factory_none_model_raises():
    from unittest.mock import patch
    from app.agent.providers.factory import build_provider

    with patch("app.core.config.settings"):
        with pytest.raises(ValueError, match="No model specified"):
            build_provider(None)


def test_make_default_provider_factory_no_prefix_raises():
    from unittest.mock import patch
    from app.agent.providers.factory import build_provider

    with patch("app.core.config.settings"):
        with pytest.raises(ValueError, match="Invalid model format"):
            build_provider("gemini-3.1-flash")


def test_make_default_provider_factory_unknown_provider_raises():
    from unittest.mock import patch
    from app.agent.providers.factory import build_provider

    with patch("app.core.config.settings"):
        with pytest.raises(ValueError, match="Unsupported provider 'unknown'"):
            build_provider("unknown:some-model")


def test_make_default_provider_factory_zai_model(monkeypatch):
    from unittest.mock import MagicMock, patch
    from app.agent.providers.factory import build_provider

    monkeypatch.setenv("ZAI_API_KEY", "test-key")
    mock_provider = MagicMock()
    with patch(
        "app.agent.providers.factory.ZAIProvider", return_value=mock_provider
    ) as MockZAI:
        build_provider("zai:glm-5-turbo")
        MockZAI.assert_called_once()
        assert MockZAI.call_args.kwargs.get("model") == "glm-5-turbo"


def test_make_default_provider_factory_googlegenai_model(monkeypatch):
    from unittest.mock import MagicMock, patch
    from app.agent.providers.factory import build_provider

    monkeypatch.setenv("GOOGLE_API_KEY", "test-api-key")
    mock_provider = MagicMock()
    with patch(
        "app.agent.providers.factory.GoogleGenAIProvider",
        return_value=mock_provider,
    ) as MockG:
        build_provider("googlegenai:gemini-3.1-flash")
        MockG.assert_called_once()
        assert MockG.call_args.kwargs.get("model") == "gemini-3.1-flash"


def test_make_default_provider_factory_geminicli_removed():
    from unittest.mock import patch
    from app.agent.providers.factory import build_provider

    with patch("app.core.config.settings"):
        with pytest.raises(ValueError, match="Unsupported provider 'geminicli'"):
            build_provider("geminicli:gemini-2.0-flash")


def test_make_default_provider_factory_openai_model(monkeypatch):
    from unittest.mock import MagicMock, patch
    from app.agent.providers.factory import build_provider

    mock_provider = MagicMock()
    with patch(
        "app.agent.providers.factory.OpenAIProvider", return_value=mock_provider
    ) as MockOAI:
        with patch("app.core.config.settings") as mock_settings:
            mock_settings.OPENAI_API_KEY = MagicMock()
            mock_settings.OPENAI_API_KEY.get_secret_value.return_value = "sk-test"
            build_provider("openai:gpt-4o")
            MockOAI.assert_called_once()
            assert MockOAI.call_args.kwargs.get("model") == "gpt-4o"


def test_make_default_provider_factory_openai_env_key_fallback(monkeypatch):
    from unittest.mock import MagicMock, patch
    from app.agent.providers.factory import build_provider

    monkeypatch.setenv("OPENAI_API_KEY", "sk-from-env")
    mock_provider = MagicMock()
    with patch(
        "app.agent.providers.factory.OpenAIProvider", return_value=mock_provider
    ) as MockOAI:
        with patch("app.core.config.settings") as mock_settings:
            mock_settings.OPENAI_API_KEY = None
            build_provider("openai:gpt-4o-mini")
            MockOAI.assert_called_once()
            assert MockOAI.call_args.kwargs.get("api_key") == "sk-from-env"


def test_make_default_provider_factory_vertexai_model():
    from unittest.mock import MagicMock, patch
    from app.agent.providers.factory import build_provider

    mock_provider = MagicMock()
    with patch(
        "app.agent.providers.factory.VertexAIProvider",
        return_value=mock_provider,
    ) as MockV:
        with patch("app.core.config.settings") as mock_settings:
            mock_settings.VERTEXAI_API_KEY = MagicMock()
            mock_settings.VERTEXAI_API_KEY.get_secret_value.return_value = "v-key"
            mock_settings.GOOGLE_CLOUD_PROJECT = "my-project"
            mock_settings.GOOGLE_CLOUD_LOCATION = "us-central1"
            build_provider("vertexai:gemini-3.1-flash")
            MockV.assert_called_once()


def test_make_default_provider_factory_openrouter_model(monkeypatch):
    from unittest.mock import MagicMock, patch
    from app.agent.providers.factory import build_provider

    mock_provider = MagicMock()
    with patch(
        "app.agent.providers.factory.ChatCompletionsOnlyProvider",
        return_value=mock_provider,
    ) as MockCompatible:
        with patch("app.core.config.settings") as mock_settings:
            mock_settings.OPENROUTER_API_KEY = MagicMock()
            mock_settings.OPENROUTER_API_KEY.get_secret_value.return_value = "or-key"
            build_provider("openrouter:qwen3")
            MockCompatible.assert_called_once()
            assert "openrouter" in MockCompatible.call_args.kwargs.get("base_url", "")


def test_make_default_provider_factory_nvidia_model():
    from unittest.mock import MagicMock, patch
    from app.agent.providers.factory import build_provider

    mock_provider = MagicMock()
    with patch(
        "app.agent.providers.factory.ChatCompletionsOnlyProvider",
        return_value=mock_provider,
    ) as MockCompatible:
        with patch("app.core.config.settings") as mock_settings:
            mock_settings.NVIDIA_API_KEY = MagicMock()
            mock_settings.NVIDIA_API_KEY.get_secret_value.return_value = "nvapi-key"
            build_provider("nvidia:stepfun-ai/step-3.5-flash")
            MockCompatible.assert_called_once()
            assert (
                MockCompatible.call_args.kwargs.get("base_url")
                == "https://integrate.api.nvidia.com/v1"
            )
            assert (
                MockCompatible.call_args.kwargs.get("model")
                == "stepfun-ai/step-3.5-flash"
            )


# ---------------------------------------------------------------------------
# Missing API key — fast-fail for all keyed providers
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "model_str, settings_attr, env_var, match",
    [
        ("openai:gpt-4o", "OPENAI_API_KEY", "OPENAI_API_KEY", "OPENAI_API_KEY"),
        (
            "googlegenai:gemini-3.1-flash",
            "GOOGLE_API_KEY",
            "GOOGLE_API_KEY",
            "GOOGLE_API_KEY",
        ),
        ("zai:glm-5-turbo", "ZAI_API_KEY", "ZAI_API_KEY", "ZAI_API_KEY"),
        (
            "vertexai:gemini-3.1-flash",
            "VERTEXAI_API_KEY",
            "VERTEXAI_API_KEY",
            "VERTEXAI_API_KEY",
        ),
        (
            "openrouter:qwen3",
            "OPENROUTER_API_KEY",
            "OPENROUTER_API_KEY",
            "OPENROUTER_API_KEY",
        ),
        (
            "nvidia:stepfun-ai/step-3.5-flash",
            "NVIDIA_API_KEY",
            "NVIDIA_API_KEY",
            "NVIDIA_API_KEY",
        ),
        ("xai:grok-4", "XAI_API_KEY", "XAI_API_KEY", "XAI_API_KEY"),
    ],
)
def test_factory_raises_clear_error_when_api_key_missing(
    monkeypatch, model_str, settings_attr, env_var, match
):
    """Each keyed provider raises ValueError mentioning its env var when key is absent."""
    from unittest.mock import patch
    from app.agent.providers.factory import build_provider

    monkeypatch.delenv(env_var, raising=False)
    with patch("app.core.config.settings") as mock_settings:
        setattr(mock_settings, settings_attr, None)
        # also null out unrelated keys so other branches don't accidentally fire
        for attr in [
            "OPENAI_API_KEY",
            "GOOGLE_API_KEY",
            "ZAI_API_KEY",
            "VERTEXAI_API_KEY",
            "OPENROUTER_API_KEY",
            "NVIDIA_API_KEY",
            "XAI_API_KEY",
        ]:
            if attr != settings_attr:
                setattr(mock_settings, attr, None)
        mock_settings.GOOGLE_CLOUD_PROJECT = None
        mock_settings.GOOGLE_CLOUD_LOCATION = "global"

        with pytest.raises(ValueError, match=match):
            build_provider(model_str)


def test_todo_and_schedule_injected_into_lead():
    """todo_manage and schedule_task are injected into lead agents."""
    factory, _ = _make_provider_factory()
    cfg = AgentConfig(name="lead", role="lead", system_prompt="Lead")
    agent = _build_agent(cfg, {}, factory)
    assert "todo_manage" in agent._tools
    assert "schedule_task" in agent._tools
