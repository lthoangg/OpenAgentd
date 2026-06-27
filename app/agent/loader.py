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
    skills: [mcp-installer]
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
import tempfile
from pathlib import Path
from typing import TYPE_CHECKING, Any, Literal

import yaml

from app.agent.schemas.agent import AgentContext

if TYPE_CHECKING:
    from app.agent.mode.team.team import AgentTeam

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


def member_model_is_configured(model: str | None) -> bool:
    """Return whether a member model is configured enough to join a team."""
    from app.cli.seed import PROVIDER_MODEL_TOKEN

    return bool(model and model.strip() and model.strip() != PROVIDER_MODEL_TOKEN)


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
    temperature: float | None = None
    thinking_level: str | None = None
    responses_api: bool | None = None

    @model_validator(mode="after")
    def _validate(self) -> "AgentConfig":
        # Allow the seed placeholder unchanged — the loader substitutes an
        # UnconfiguredProvider stub at build time so first-run installs
        # without a real model still load cleanly.
        from app.cli.seed import PROVIDER_MODEL_TOKEN

        if self.model and self.model != PROVIDER_MODEL_TOKEN and ":" not in self.model:
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


def _builtin_agent_md(
    *,
    name: str,
    role: str,
    description: str,
    model: str | None,
    temperature: float,
    thinking_level: str,
) -> str:
    frontmatter = {
        "name": name,
        "role": role,
        "description": description,
        "model": model,
        "temperature": temperature,
        "thinking_level": thinking_level,
    }
    return f"---\n{yaml.safe_dump(frontmatter, sort_keys=False)}---\n\n"


def _atomic_write_text(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(
        mode="w",
        encoding="utf-8",
        dir=path.parent,
        prefix=f".{path.name}.",
        suffix=".tmp",
        delete=False,
    ) as tmp:
        tmp.write(content)
        tmp_path = Path(tmp.name)
    tmp_path.replace(path)


def ensure_builtin_agent_blueprints(agents_dir: Path, *, mode: str) -> list[str]:
    """Materialise missing first-party member ``.md`` files for *mode*.

    Built-in prompt/tool definitions live in code, so this does not depend on
    the source ``seed/`` tree being bundled in production. User-owned files win:
    existing ``.md`` files are never overwritten.
    """
    from app.agent.builtin_prompts import BUILTIN_AGENT_BLUEPRINTS
    from app.cli.seed import PROVIDER_MODEL_TOKEN

    agents_dir.mkdir(parents=True, exist_ok=True)
    model = _lead_model_for_dir(agents_dir) or PROVIDER_MODEL_TOKEN
    written: list[str] = []
    for name, blueprint in BUILTIN_AGENT_BLUEPRINTS.get(mode, {}).items():
        target = agents_dir / f"{name}.md"
        if target.exists():
            continue
        _atomic_write_text(
            target,
            _builtin_agent_md(
                name=blueprint["name"],
                role=blueprint["role"],
                description=blueprint["description"],
                model=model,
                temperature=blueprint["temperature"],
                thinking_level=blueprint["thinking_level"],
            ),
        )
        written.append(target.name)
    if written:
        logger.info(
            "builtin_agent_blueprints_materialized mode={} dir={} files={}",
            mode,
            agents_dir,
            written,
        )
    return written


def _lead_model_for_dir(agents_dir: Path) -> str | None:
    if not agents_dir.exists():
        return None
    for path in sorted(agents_dir.glob("*.md")):
        try:
            cfg = parse_agent_md(path)
        except Exception:
            continue
        if cfg.role == "lead" and member_model_is_configured(cfg.model):
            return cfg.model
    return None


def _is_retired_builtin_member(mode: str, name: str) -> bool:
    """Return whether a first-party member should be hidden for *mode*.

    This lets newer curated builtin sets stop exposing old generated/shipped
    files without deleting user config. A custom file with the same name still
    stays on disk; it is just not a spawnable first-party blueprint in that mode.
    """
    if mode != "coding":
        return False
    return name == "executor"


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
        patch_file,
        read_file,
        remove_path,
        schedule_task,
        shell_tool,
        todo_manage,
        web_fetch,
        web_search,
        write_file,
    )
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
        "patch": patch_file,
        "rm": remove_path,
        "shell": shell_tool,
        "bg": background_process,
        "skill": load_skill,
        "schedule_task": schedule_task,
        "todo_manage": todo_manage,
        "generate_image": generate_image,
        "generate_video": generate_video,
    }
    # Merge MCP tools from healthy servers. Names follow ``<server>_<tool>``
    # so they cannot collide with the builtins above.
    registry.update(mcp_manager.get_tools_dict())
    return registry


# ---------------------------------------------------------------------------
# Internal agent builder
# ---------------------------------------------------------------------------


def _build_agent(
    cfg: AgentConfig,
    tool_registry: dict[str, Tool],
    provider_factory: ProviderFactory,
    *,
    source_path: Path | None = None,
    mode: str = "normal",
) -> Agent:
    """Construct one Agent.  ``source_path`` enables drift detection."""
    system_prompt = cfg.system_prompt
    if cfg.role == "lead" and cfg.name == "openagentd":
        from app.agent.builtin_prompts import (
            apply_openagentd_extra_prompt,
            openagentd_description_for_mode,
            openagentd_tools_for_mode,
        )

        cfg.description = cfg.description or openagentd_description_for_mode(mode)
        cfg.tools = [*openagentd_tools_for_mode(mode), *cfg.tools]
        system_prompt = apply_openagentd_extra_prompt(mode, cfg.system_prompt)
    elif cfg.role == "member":
        from app.agent.builtin_prompts import (
            apply_member_extra_prompt,
            builtin_member_profile,
        )

        profile = builtin_member_profile(mode, cfg.name)
        if profile is not None:
            built_in_prompt = profile["prompt"]
            cfg.description = cfg.description or profile["description"]
            cfg.tools = [*profile["tools"], *cfg.tools]
            cfg.skills = [*profile["skills"], *cfg.skills]
            cfg.mcp = [*profile["mcp"], *cfg.mcp]
            system_prompt = apply_member_extra_prompt(
                cfg.name, built_in_prompt, cfg.system_prompt
            )

    if cfg.skills:
        cfg.skills = list(dict.fromkeys(cfg.skills))

    from app.agent.tools.builtin.schedule import schedule_task as _schedule_task_tool
    from app.agent.tools.builtin.skill import load_skill as _load_skill_tool
    from app.agent.tools.builtin.todo import todo_manage

    _load_skill = tool_registry.get("skill", _load_skill_tool)
    tools: list[Tool] = [_load_skill]

    # These tools are always available to the lead agent — not listed in frontmatter.
    if cfg.role == "lead":
        _todo_manage = tool_registry.get("todo_manage", todo_manage)
        _schedule_task = tool_registry.get("schedule_task", _schedule_task_tool)
        tools += [_todo_manage, _schedule_task]

    seen: set[str] = {t.name for t in tools}
    cfg.tools = list(dict.fromkeys(cfg.tools))
    cfg.mcp = list(dict.fromkeys(cfg.mcp))
    for tool_name in cfg.tools:
        if tool_name in ("skill", "todo_manage", "schedule_task"):
            continue
        if tool_name not in tool_registry:
            # Soft-skip: settings/self-healing edits and disabled-then-rebuild
            # flows can leave a name in frontmatter briefly after the
            # underlying tool/MCP server disappears between loads.

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
    # removed from mcp.json while still referenced by config.
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

    # Agents seeded with the ``__PROVIDER_MODEL__`` placeholder load with
    # an :class:`UnconfiguredProvider` stub so the team manager survives
    # first-run before the user picks a provider. The stub raises
    # :class:`UnconfiguredProviderError` on first LLM call, which the
    # turn-runner translates into a typed
    # :class:`AgentNotConfiguredEvent` SSE message.
    from app.agent.providers.unconfigured import (
        UnconfiguredProvider,
        UnconfiguredProviderError,
    )

    try:
        provider = provider_factory(cfg.model, model_kwargs=model_kwargs)
    except Exception as exc:
        if not isinstance(exc, UnconfiguredProviderError):
            logger.warning(
                "agent_provider_unavailable agent={} model={} error={}",
                cfg.name,
                cfg.model,
                exc,
            )
        else:
            logger.warning(
                "agent_unconfigured_provider agent={} model={}", cfg.name, cfg.model
            )
        provider = UnconfiguredProvider(agent_name=cfg.name)

    agent = Agent[AgentContext](
        name=cfg.name,
        description=cfg.description,
        llm_provider=provider,
        model_id=cfg.model,
        system_prompt=system_prompt,
        tools=tools,
        skills=cfg.skills,
        mcp_servers=cfg.mcp,
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
    mode: str = "normal",
    workspace: str | None = None,
) -> "AgentTeam | None":
    """Load an AgentTeam from a directory of per-agent ``.md`` files.

    The lead is built eagerly; member ``.md`` files are kept as **blueprints**
    on the team and only constructed when the lead calls ``team_manage``.
    This
    means a fresh server start touches only the lead's tool/MCP/skill
    resolution — members impose zero startup cost until first use.

    Returns ``None`` if the directory does not exist or contains no ``.md`` files.
    """
    from app.agent.mode.team.member import TeamLead
    from app.agent.mode.team.team import AgentTeam, MemberBlueprint

    agents_dir = Path(agents_dir).resolve()
    if not agents_dir.exists():
        return None

    md_files = sorted(agents_dir.glob("*.md"))
    if not md_files:
        return None

    if mode in ("normal", "coding"):
        ensure_builtin_agent_blueprints(agents_dir, mode=mode)
        md_files = sorted(agents_dir.glob("*.md"))

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
    member_entries = [
        (c, p)
        for (c, p) in agent_configs
        if c.role == "member"
        and member_model_is_configured(c.model)
        and not _is_retired_builtin_member(mode, c.name)
    ]

    # Validate: blueprint names must be unique and must not collide with the
    # lead.  Also reject ``#`` in blueprint names since we use ``blueprint#N``
    # as the runtime instance handle (see AgentTeam.spawn).
    blueprints: dict[str, MemberBlueprint] = {}
    for cfg, path in member_entries:
        if "#" in cfg.name:
            raise ValueError(
                f"Member blueprint '{cfg.name}' in '{path.name}' contains '#'. "
                "Reserved character — instances are named 'blueprint#N'."
            )
        if cfg.name == lead_cfg.name:
            raise ValueError(
                f"Member '{cfg.name}' in '{path.name}' shares the lead's name."
            )
        if cfg.name in blueprints:
            raise ValueError(f"Duplicate member name '{cfg.name}' in '{path.name}'.")
        description = cfg.description
        if description is None:
            from app.agent.builtin_prompts import builtin_member_profile

            profile = builtin_member_profile(mode, cfg.name)
            description = profile["description"] if profile is not None else cfg.name
        blueprints[cfg.name] = MemberBlueprint(
            name=cfg.name,
            description=description,
            source_path=path,
        )

    tool_registry = _default_tool_registry()
    if extra_tools:
        tool_registry.update(extra_tools)

    if provider_factory is None:
        provider_factory = build_provider

    db_factory = resolve_db_factory(db_factory)

    # Unknown tools / MCP servers in frontmatter are warn-and-skipped by
    # ``_build_agent`` so stale config entries or mcp.json edits never break
    # agent load.

    # Build the lead.  Members are NOT built — they are described by their
    # blueprints on the team and built on demand by ``AgentTeam.spawn``.
    lead_agent = _build_agent(
        lead_cfg, tool_registry, provider_factory, source_path=lead_path, mode=mode
    )
    lead_member = TeamLead(lead_agent, db_factory=db_factory)

    team = AgentTeam(
        lead=lead_member,
        blueprints=blueprints,
        provider_factory=provider_factory,
        extra_tools=extra_tools,
        db_factory=db_factory,
        mode=mode,
        workspace=workspace,
    )
    logger.info(
        "team_loaded lead={} blueprints={}",
        lead_cfg.name,
        sorted(blueprints.keys()),
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
    mode: str = "normal",
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

    return _build_agent(
        cfg, tool_registry, provider_factory, source_path=source_path, mode=mode
    )
