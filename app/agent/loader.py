"""Agent configuration loader.

Loads agent definitions from per-agent Markdown files with YAML frontmatter.

Configuration philosophy
------------------------

Each agent lives in its own ``.md`` file inside a directory (default
``{CONFIG_DIR}/agents/``).  YAML frontmatter carries all config fields; the
Markdown body is the system prompt.  A thin ``team.yaml`` (optional) in the
same directory holds team-level metadata (name, description).

File format
-----------

agents/
  orchestrator.md   ← role: lead (exactly one per directory)
  explorer.md
  executor.md

Each file::

    ---
    name: orchestrator
    role: lead
    description: Coordinates the team.
    model: googlegenai:gemini-3.1-pro-preview
    temperature: 0.2
    thinking_level: low
    tools: [date, read, ls]
    skills: [web-research]
    fallback_model: copilot:gpt-5-mini
    summarization:
      enabled: true
      token_threshold: 80000
      model: googlegenai:gemini-flash-lite
    ---

    You are the team orchestrator. Coordinate — do not do the work yourself.

Optional ``team.yaml`` in the same directory::

    name: task-force
    description: A versatile task force.

Usage
-----

.. code-block:: python

    from pathlib import Path
    from app.agent.loader import load_team_from_dir

    team = load_team_from_dir(Path(".openagentd/config/agents"))
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import TYPE_CHECKING, Any, Literal, cast

from app.agent.schemas.agent import (
    AgentContext,
    SummarizationConfig,
    SummarizationFileConfig,
    TitleGenerationFileConfig,
)

if TYPE_CHECKING:
    from app.agent.mode.team.team import AgentTeam

import yaml
from loguru import logger
from pydantic import BaseModel, model_validator

from app.agent.agent_loop import Agent
from app.agent.drift import ConfigStamp, detect_drift, stamp_agent_files
from app.agent.providers.factory import ProviderFactory, build_provider
from app.agent.tools.registry import Tool
from app.core.db import DbFactory, resolve_db_factory

# Re-exports for callers that historically imported these symbols from
# ``app.agent.loader``.
__all__ = [
    "ConfigStamp",
    "ProviderFactory",
    "detect_drift",
    "stamp_agent_files",
]


# ---------------------------------------------------------------------------
# Schema models
# ---------------------------------------------------------------------------

_FRONTMATTER_RE = re.compile(r"^\s*---\r?\n(.*?)\r?\n---\r?\n?(.*)", re.DOTALL)


class AgentConfig(BaseModel):
    """Schema for a single agent defined in a .md frontmatter block."""

    name: str
    role: Literal["lead", "member"] = "member"
    description: str | None = None
    system_prompt: str = ""  # populated from .md body by parse_agent_md
    tools: list[str] = []
    mcp: list[str] = []  # MCP server names; agent gets all tools from each
    skills: list[str] = []
    model: str | None = None  # e.g. "googlegenai:gemini-3.1-flash"
    fallback_model: str | None = None
    temperature: float | None = None
    thinking_level: str | None = None
    responses_api: bool | None = None
    summarization: SummarizationConfig | None = None

    @model_validator(mode="after")
    def _validate(self) -> "AgentConfig":
        if self.model and ":" not in self.model:
            raise ValueError(
                f"Agent '{self.name}': invalid model '{self.model}' "
                f"(expected 'provider:model', e.g. 'googlegenai:gemini-3.1-flash')."
            )
        return self


# ---------------------------------------------------------------------------
# Parser
# ---------------------------------------------------------------------------


def parse_agent_md(path: Path) -> AgentConfig:
    """Parse a single agent ``.md`` file — frontmatter config + body prompt.

    The file must have a YAML frontmatter block delimited by ``---``.
    The body (after the closing ``---``) becomes ``system_prompt``.
    """
    text = path.read_text(encoding="utf-8")
    m = _FRONTMATTER_RE.match(text)
    if not m:
        raise ValueError(
            f"Agent file '{path}' is missing YAML frontmatter. "
            "Expected '---\\n<yaml>\\n---\\n<system prompt>'."
        )
    raw_meta = yaml.safe_load(m.group(1)) or {}
    body = m.group(2).strip()

    # name defaults to filename stem if not provided
    if "name" not in raw_meta:
        raw_meta["name"] = path.stem

    raw_meta["system_prompt"] = body or "You are a helpful assistant."
    return AgentConfig.model_validate(raw_meta)


# ---------------------------------------------------------------------------
# Summarization file config loader
# ---------------------------------------------------------------------------

_SENTINEL = object()
_summarization_file_cfg_cache: SummarizationFileConfig | None | object = _SENTINEL


def load_summarization_file_config(
    path: str | Path | None = None,
) -> SummarizationFileConfig | None:
    """Load global summarization defaults from a ``.md`` file with YAML frontmatter.

    Returns ``None`` if the file does not exist.  Raises ``ValueError`` if the
    file exists but is malformed.

    The result is cached after the first successful load.  Pass an explicit
    *path* to bypass the cache (e.g. in tests).
    """
    global _summarization_file_cfg_cache  # noqa: PLW0603

    # Use cached result when no explicit path is given
    if path is None:
        if _summarization_file_cfg_cache is not _SENTINEL:
            return cast("SummarizationFileConfig | None", _summarization_file_cfg_cache)
        from app.agent.hooks.summarization import summarization_config_path

        resolved = summarization_config_path()
    else:
        resolved = Path(path)

    if not resolved.exists():
        if path is None:
            _summarization_file_cfg_cache = None
        return None

    text = resolved.read_text(encoding="utf-8")
    m = _FRONTMATTER_RE.match(text)
    if not m:
        raise ValueError(
            f"Summarization config '{resolved}' is missing YAML frontmatter. "
            "Expected '---\\n<yaml>\\n---\\n'."
        )
    raw = yaml.safe_load(m.group(1)) or {}
    # ``prompt`` is sourced from the file body, never from frontmatter, to
    # prevent YAML escaping gymnastics for multi-line prompts.
    raw.pop("prompt", None)
    body = m.group(2).strip()
    if body:
        raw["prompt"] = body
    result = SummarizationFileConfig.model_validate(raw)

    if path is None:
        _summarization_file_cfg_cache = result
        logger.info(
            "summarization_file_config_loaded path={} model={} token_threshold={} "
            "prompt_override={}",
            resolved,
            result.model or "(agent default)",
            result.token_threshold,
            result.prompt is not None,
        )
    return result


# ---------------------------------------------------------------------------
# Title generation file config loader
# ---------------------------------------------------------------------------

_title_generation_file_cfg_cache: TitleGenerationFileConfig | None | object = _SENTINEL


def load_title_generation_file_config(
    path: str | Path | None = None,
) -> TitleGenerationFileConfig | None:
    """Load global title-generation defaults from a ``.md`` file with YAML frontmatter.

    Returns ``None`` if the file does not exist.  Raises ``ValueError`` if
    the file exists but is malformed.

    The YAML frontmatter supplies ``model`` and ``wait_timeout_seconds``.
    The Markdown body (after the closing ``---``) becomes the
    title-generator system prompt when non-empty; if the body is empty the
    built-in prompt at ``app/agent/prompts/title.md`` is used.

    The result is cached after the first successful load.  Pass an explicit
    *path* to bypass the cache (e.g. in tests).
    """
    global _title_generation_file_cfg_cache  # noqa: PLW0603

    if path is None:
        if _title_generation_file_cfg_cache is not _SENTINEL:
            return cast(
                "TitleGenerationFileConfig | None", _title_generation_file_cfg_cache
            )
        from app.agent.hooks.title_generation import title_generation_config_path

        resolved = title_generation_config_path()
    else:
        resolved = Path(path)

    if not resolved.exists():
        if path is None:
            _title_generation_file_cfg_cache = None
        return None

    text = resolved.read_text(encoding="utf-8")
    m = _FRONTMATTER_RE.match(text)
    if not m:
        raise ValueError(
            f"Title generation config '{resolved}' is missing YAML frontmatter. "
            "Expected '---\\n<yaml>\\n---\\n'."
        )
    raw = yaml.safe_load(m.group(1)) or {}
    raw.pop("prompt", None)
    body = m.group(2).strip()
    if body:
        raw["prompt"] = body
    result = TitleGenerationFileConfig.model_validate(raw)

    if path is None:
        _title_generation_file_cfg_cache = result
        logger.info(
            "title_generation_file_config_loaded path={} model={} "
            "wait_timeout_seconds={} prompt_override={}",
            resolved,
            result.model or "(agent default)",
            result.wait_timeout_seconds,
            result.prompt is not None,
        )
    return result


# ---------------------------------------------------------------------------
# Built-in tool registry
# ---------------------------------------------------------------------------


def _default_tool_registry() -> dict[str, Tool]:
    from app.agent.mcp import mcp_manager
    from app.agent.tools.builtin import (
        background_process,
        edit_file,
        get_date,
        glob_files,
        grep_files,
        list_directory,
        load_skill,
        read_file,
        remove_path,
        schedule_task,
        shell_tool,
        todo_manage,
        web_fetch,
        web_search,
        write_file,
    )
    from app.agent.tools.builtin.note import note_tool
    from app.agent.tools.builtin.wiki_search import wiki_search
    from app.agent.tools.multimodalities import generate_image, generate_video

    registry: dict[str, Tool] = {
        "web_search": web_search,
        "web_fetch": web_fetch,
        "date": get_date,
        "read": read_file,
        "write": write_file,
        "edit": edit_file,
        "ls": list_directory,
        "grep": grep_files,
        "glob": glob_files,
        "rm": remove_path,
        "shell": shell_tool,
        "bg": background_process,
        "skill": load_skill,
        "schedule_task": schedule_task,
        "todo_manage": todo_manage,
        "wiki_search": wiki_search,
        "note": note_tool,
        "generate_image": generate_image,
        "generate_video": generate_video,
    }
    # Merge MCP tools from healthy servers. Names follow ``mcp_<server>_<tool>``
    # so they cannot collide with the builtins above.
    registry.update(mcp_manager.get_tools_dict())
    return registry


# ---------------------------------------------------------------------------
# Internal agent builder
# ---------------------------------------------------------------------------


def _build_skills_section(skill_names: list[str]) -> str:
    """Build a skills reference block for injection into the system prompt."""
    from app.agent.tools.builtin.skill import discover_skills

    if not skill_names:
        return ""

    available = discover_skills()
    lines = ["\n## Available skills", ""]
    for name in skill_names:
        info = available.get(name)
        if info is None:
            logger.warning("skill_not_found name={}", name)
            continue
        desc = info.get("description", "No description.")
        lines.append(f"- **{name}**: {desc}")
    lines += [
        "",
        "Call `skill` with the skill name to load its full instructions.",
    ]
    return "\n".join(lines)


def _build_agent(
    cfg: AgentConfig,
    tool_registry: dict[str, Tool],
    provider_factory: ProviderFactory,
    *,
    source_path: Path | None = None,
) -> Agent:
    """Construct one Agent.  ``source_path`` enables drift detection."""
    system_prompt = cfg.system_prompt

    if cfg.skills:
        system_prompt += _build_skills_section(cfg.skills)

    from app.agent.tools.builtin.schedule import schedule_task as _schedule_task_tool
    from app.agent.tools.builtin.skill import load_skill as _load_skill_tool
    from app.agent.tools.builtin.todo import todo_manage

    _load_skill = tool_registry.get("skill", _load_skill_tool)
    tools: list[Tool] = [_load_skill]

    # These tools are always available to the lead agent — not listed in frontmatter.
    if cfg.role == "lead":
        from app.agent.tools.builtin.note import note_tool as _note_tool

        _todo_manage = tool_registry.get("todo_manage", todo_manage)
        _schedule_task = tool_registry.get("schedule_task", _schedule_task_tool)
        _note = tool_registry.get("note", _note_tool)
        tools += [_todo_manage, _schedule_task, _note]

    seen: set[str] = {t.name for t in tools}
    for tool_name in cfg.tools:
        if tool_name in ("skill", "todo_manage", "schedule_task", "note"):
            continue
        if tool_name not in tool_registry:
            # Soft-skip: dynamic capability management (team_manage) and
            # disabled-then-rebuild flows can leave a name in frontmatter
            # that no longer resolves. Log and continue so the agent still
            # loads; team_manage validates up-front to prevent typos.
            logger.warning(
                "agent_unknown_tool agent={} tool={} available={}",
                cfg.name,
                tool_name,
                sorted(tool_registry.keys()),
            )
            continue
        if tool_name in seen:
            continue
        seen.add(tool_name)
        tools.append(tool_registry[tool_name])

    # MCP servers: each entry grants the agent access to *all* tools exposed
    # by that server. Unknown / not-ready servers are warn-and-skip so the
    # agent still loads when an MCP server is disabled, mid-restart, or
    # removed from mcp.json after being granted via team_manage.
    if cfg.mcp:
        from app.agent.mcp import mcp_manager

        for server_name in cfg.mcp:
            server_tools = mcp_manager.get_tools_for_server(server_name)
            if server_tools is None:
                logger.warning(
                    "agent_unknown_mcp_server agent={} server={} configured={}",
                    cfg.name,
                    server_name,
                    sorted(mcp_manager.server_names()),
                )
                continue
            for tool in server_tools:
                if tool.name in seen:
                    continue
                seen.add(tool.name)
                tools.append(tool)

    model_kwargs: dict[str, Any] = {}
    if cfg.temperature is not None:
        model_kwargs["temperature"] = cfg.temperature
    if cfg.thinking_level is not None:
        model_kwargs["thinking_level"] = cfg.thinking_level
    if cfg.responses_api is not None:
        model_kwargs["responses_api"] = cfg.responses_api

    provider = provider_factory(cfg.model, model_kwargs=model_kwargs)

    fallback_provider = None
    if cfg.fallback_model:
        fallback_provider = provider_factory(
            cfg.fallback_model, model_kwargs=model_kwargs
        )

    agent = Agent[AgentContext](
        name=cfg.name,
        description=cfg.description,
        llm_provider=provider,
        model_id=cfg.model,
        system_prompt=system_prompt,
        tools=tools,
        skills=cfg.skills,
        mcp_servers=cfg.mcp,
        fallback_provider=fallback_provider,
        fallback_model_id=cfg.fallback_model,
        summarization_config=cfg.summarization,
    )

    # Stamp config dependencies for end-of-turn drift detection.
    if source_path is not None:
        from app.agent.mcp.config import config_path as _mcp_config_path
        from app.core.config import settings as _settings

        skills_root = Path(_settings.SKILLS_DIR)
        agent.source_path = source_path
        agent.config_stamp = stamp_agent_files(
            agent_md_path=source_path,
            skill_names=cfg.skills,
            skills_dir=skills_root,
            mcp_config_path=_mcp_config_path(),
        )

    return agent


# ---------------------------------------------------------------------------
# Team loader — main public API
# ---------------------------------------------------------------------------


def load_team_from_dir(
    agents_dir: str | Path,
    *,
    provider_factory: ProviderFactory | None = None,
    extra_tools: dict[str, Tool] | None = None,
    db_factory: DbFactory | None = None,
) -> "AgentTeam | None":
    """Load an AgentTeam from a directory of per-agent ``.md`` files.

    The directory may also contain an optional ``team.yaml`` for team-level
    metadata (name, description).

    Returns ``None`` if the directory does not exist or contains no ``.md`` files.
    """
    from app.agent.mode.team.member import TeamLead, TeamMember
    from app.agent.mode.team.team import AgentTeam

    agents_dir = Path(agents_dir).resolve()
    if not agents_dir.exists():
        return None

    md_files = sorted(agents_dir.glob("*.md"))
    if not md_files:
        return None

    # Carry source path so _build_agent can stamp config dependencies.
    agent_configs: list[tuple[AgentConfig, Path]] = []
    parse_errors: list[str] = []
    for md_path in md_files:
        try:
            cfg = parse_agent_md(md_path)
            agent_configs.append((cfg, md_path))
            logger.info(
                "agent_discovered file={} name={} role={} model={}",
                md_path.name,
                cfg.name,
                cfg.role,
                cfg.model or "(none)",
            )
        except Exception as exc:
            parse_errors.append(f"  {md_path.name}: {exc}")

    if parse_errors:
        raise ValueError(
            f"Failed to parse {len(parse_errors)} agent file(s) in '{agents_dir}':\n"
            + "\n".join(parse_errors)
        )

    # Validate: exactly one lead
    leads = [(c, p) for (c, p) in agent_configs if c.role == "lead"]
    if not leads:
        raise ValueError(
            f"No agent with 'role: lead' found in '{agents_dir}'. "
            "Exactly one agent must have 'role: lead'."
        )
    if len(leads) > 1:
        names = [c.name for (c, _) in leads]
        raise ValueError(
            f"Multiple agents with 'role: lead' found in '{agents_dir}': {names}. "
            "Exactly one agent must have 'role: lead'."
        )

    lead_cfg, lead_path = leads[0]
    member_entries = [(c, p) for (c, p) in agent_configs if c.role == "member"]

    tool_registry = _default_tool_registry()
    if extra_tools:
        tool_registry.update(extra_tools)

    if provider_factory is None:
        provider_factory = build_provider

    db_factory = resolve_db_factory(db_factory)

    # Unknown tools / MCP servers in frontmatter are warn-and-skipped by
    # ``_build_agent`` so dynamic capability changes (team_manage, mcp.json
    # edits) never break agent load. ``team_manage`` validates names
    # up-front to prevent typos from being persisted in the first place.

    # Build agents
    lead_agent = _build_agent(
        lead_cfg, tool_registry, provider_factory, source_path=lead_path
    )
    lead_member = TeamLead(lead_agent, db_factory=db_factory)

    members: dict[str, TeamMember] = {}
    for cfg, path in member_entries:
        agent = _build_agent(cfg, tool_registry, provider_factory, source_path=path)
        members[cfg.name] = TeamMember(agent, db_factory=db_factory)

    # Inject teammates section into each agent's system prompt
    all_members: dict[str, tuple[TeamLead | TeamMember, str]] = {
        lead_cfg.name: (lead_member, lead_cfg.description or "team lead"),
    }
    for cfg, _ in member_entries:
        all_members[cfg.name] = (members[cfg.name], cfg.description or cfg.name)

    for agent_name, (member, _) in all_members.items():
        injected = "\n## Teammates\n"
        for other_name, (_, other_desc) in all_members.items():
            if other_name == agent_name:
                continue
            role_label = "lead" if other_name == lead_cfg.name else "member"
            injected += f"- **{other_name}** ({role_label}): {other_desc}\n"
        member.agent.system_prompt += injected

    team = AgentTeam(
        lead=lead_member,
        members=members,
    )
    logger.info(
        "team_loaded lead={} members={}",
        lead_cfg.name,
        [c.name for (c, _) in member_entries],
    )
    return team


# ---------------------------------------------------------------------------
# Single-agent rebuild — used by ``TeamMemberBase`` for in-place refresh
# ---------------------------------------------------------------------------


def rebuild_agent_from_disk(
    source_path: Path,
    *,
    provider_factory: ProviderFactory | None = None,
    extra_tools: dict[str, Tool] | None = None,
) -> Agent:
    """Re-parse one agent ``.md`` and return a fresh :class:`Agent`.

    Called by :class:`TeamMemberBase` when drift is detected.  Caller
    swaps the new agent in place; ``ValueError`` on parse/registry failure.
    """
    cfg = parse_agent_md(source_path)

    tool_registry = _default_tool_registry()
    if extra_tools:
        tool_registry.update(extra_tools)

    if provider_factory is None:
        provider_factory = build_provider

    return _build_agent(cfg, tool_registry, provider_factory, source_path=source_path)
