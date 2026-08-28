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
        thinking_level: low
    tools: [read, grep, patch]
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
    from app.agent.mode.team.runtime import SessionRuntime

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
    model: str | None = None  # e.g. "googlegenai:gemini-3.1-flash"
    thinking_level: str | None = None
    responses_api: bool | None = None

    @model_validator(mode="after")
    def _validate(self) -> "AgentConfig":
        # Allow the seed placeholder unchanged — the loader substitutes an
        # UnconfiguredProvider stub at build time so first-run installs
        # without a real model still load cleanly.
        from app.core.config import PROVIDER_MODEL_TOKEN

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
) -> str:
    # ``thinking_level`` is intentionally omitted: default agents use the
    # model's default thinking. Forcing a level injects ``reasoning_effort``
    # into Chat Completions requests, which some models reject alongside
    # function tools (HTTP 400 on /v1/chat/completions).
    frontmatter = {
        "name": name,
        "role": role,
        "description": description,
        "model": model,
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


def ensure_builtin_openagentd_lead(agents_dir: Path, *, mode: str) -> bool:
    """Restore the default lead only when an agent directory has none.

    Existing agent files, including a user-owned ``openagentd.md``, are never
    overwritten. A malformed file remains a validation error for the user to
    correct rather than being silently replaced.
    """
    for path in agents_dir.glob("*.md"):
        try:
            if parse_agent_md(path).role == "lead":
                return False
        except Exception:
            continue

    target = agents_dir / "openagentd.md"
    if target.exists():
        return False

    from app.agent.builtin_prompts import CODING_OPENAGENTD_DESCRIPTION
    from app.core.config import PROVIDER_MODEL_TOKEN

    _atomic_write_text(
        target,
        _builtin_agent_md(
            name="openagentd",
            role="lead",
            description=CODING_OPENAGENTD_DESCRIPTION,
            model=PROVIDER_MODEL_TOKEN,
        ),
    )
    logger.info("builtin_openagentd_lead_materialized mode={} path={}", mode, target)
    return True


def configure_unconfigured_agent_models(
    agents_dir: Path, provider_model: str
) -> list[str]:
    """Assign *provider_model* to agent files that still use the placeholder."""
    from app.core.config import PROVIDER_MODEL_TOKEN

    updated: list[str] = []
    for path in sorted(agents_dir.rglob("*.md")):
        text = path.read_text(encoding="utf-8")
        try:
            cfg = parse_agent_md(path)
        except Exception:
            continue
        if cfg.model != PROVIDER_MODEL_TOKEN:
            continue
        match = _FRONTMATTER_RE.match(text)
        if match is None:
            continue
        start, end = match.span(1)
        frontmatter = text[start:end].replace(PROVIDER_MODEL_TOKEN, provider_model, 1)
        path.write_text(f"{text[:start]}{frontmatter}{text[end:]}", encoding="utf-8")
        updated.append(str(path.relative_to(agents_dir)))
    return updated


# ---------------------------------------------------------------------------
# Built-in tool registry
# ---------------------------------------------------------------------------

# Tool names that are valid in an agent's ``tools:`` list but are never present
# in ``_default_tool_registry()``, because they are attached later from runtime
# context: ``skill``/``todo_manage``/``schedule_task`` are bound per agent in
# ``_build_agent``, while ``lsp`` and the team tools come from
# ``SessionRuntime._builtin_team_tools`` based on mode and role. They must be
# exempt from unknown-tool pruning or a valid name would be deleted from the
# user's file whenever the agent is loaded outside that context.
_CONTEXT_INJECTED_TOOLS = frozenset(
    {
        "skill",
        "todo_manage",
        "schedule_task",
        "lsp",
        "agent_spawn",
        "agent_send",
        "agent_list",
        "agent_stop",
        "agent_merge",
        "ask_user",
    }
)


def _default_tool_registry() -> dict[str, Tool]:
    from app.agent.mcp import mcp_manager
    from app.agent.tools.builtin import (
        glob_files,
        grep_files,
        load_skill,
        patch_file,
        read_file,
        schedule_task,
        shell_tool,
        todo_manage,
        web_fetch,
        web_search,
    )
    from app.agent.tools.multimodalities import generate_image, generate_video

    registry: dict[str, Tool] = {
        "web_search": web_search,
        "web_fetch": web_fetch,
        "read": read_file,
        "grep": grep_files,
        "glob": glob_files,
        "patch": patch_file,
        "shell": shell_tool,
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


def _prune_unknown_tools_from_file(path: Path, unknown: list[str]) -> None:
    """Strip *unknown* tool names from ``path``'s frontmatter ``tools:`` list.

    Called when an agent file names tools that no longer exist — typically a
    file written before a builtin tool was removed. Rewriting the file makes
    the config self-healing instead of warning on every single load.

    Only the ``tools`` key is touched. ``mcp`` entries are deliberately left
    alone: an MCP server can be disabled or mid-restart, so an unknown server
    name is frequently transient in a way a missing builtin tool is not.

    Best-effort — a failure here must never break agent load, so every error
    is logged and swallowed.
    """
    try:
        text = path.read_text(encoding="utf-8")
        match = _FRONTMATTER_RE.match(text)
        if not match:
            return
        meta = yaml.safe_load(match.group(1)) or {}
        listed = meta.get("tools")
        if not isinstance(listed, list):
            return

        dropped = set(unknown)
        kept = [t for t in listed if t not in dropped]
        if kept == listed:
            return

        if kept:
            meta["tools"] = kept
        else:
            meta.pop("tools", None)

        body = match.group(2)
        _atomic_write_text(
            path, f"---\n{yaml.safe_dump(meta, sort_keys=False)}---\n\n{body}"
        )
        logger.warning(
            "agent_tools_pruned agent={} file={} removed={}",
            meta.get("name", path.stem),
            path.name,
            sorted(dropped & set(listed)),
        )
    except Exception as exc:  # pragma: no cover - defensive
        logger.warning("agent_tools_prune_failed file={} error={}", path, exc)


def _build_agent(
    cfg: AgentConfig,
    tool_registry: dict[str, Tool],
    provider_factory: ProviderFactory,
    *,
    source_path: Path | None = None,
    mode: str = "coding",
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
    unknown_tools: list[str] = []
    for tool_name in cfg.tools:
        if tool_name in _CONTEXT_INJECTED_TOOLS:
            continue
        if tool_name not in tool_registry:
            # Soft-skip so this load still succeeds, then prune the name from
            # the file below so it stops recurring.
            unknown_tools.append(tool_name)
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

    if unknown_tools and source_path is not None:
        _prune_unknown_tools_from_file(source_path, unknown_tools)

    # MCP servers: each entry grants the agent access to *all* tools exposed
    # by that server. Unknown / not-ready servers are warn-and-skip so the
    # agent still loads when an MCP server is disabled, mid-restart, or
    # removed from mcp.json while still referenced by config.
    if cfg.mcp:
        from app.agent.mcp import mcp_manager

        for server_name in cfg.mcp:
            server_tools = mcp_manager.get_tools_for_server(server_name)
            if server_tools is None:
                logger.debug(
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
        mcp_servers=cfg.mcp,
    )

    # Stamp config dependencies for end-of-turn drift detection.
    if source_path is not None:
        from app.agent.mcp.config import config_path as _mcp_config_path

        agent.source_path = source_path
        agent.config_stamp = stamp_agent_files(
            agent_md_path=source_path,
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
    mode: str = "coding",
    workspace: str | None = None,
) -> "SessionRuntime | None":
    """Load the single lead SessionRuntime from a directory of ``.md`` files.

    Member files from legacy configurations are ignored. A fresh server start
    therefore resolves only the lead's tool, MCP, and skill configuration.

    Returns ``None`` if the directory does not exist or contains no ``.md`` files.
    """
    from app.agent.mode.team.runtime import SessionRuntime

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
            # Per-file scan detail: DEBUG, not INFO.  The aggregate
            # ``team_loaded`` below is the INFO-level summary of a load; one
            # line per discovered agent file is only useful when debugging
            # discovery itself.
            logger.debug(
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

    # Warn for any retired member files
    for cfg, path in agent_configs:
        if cfg.role == "member":
            logger.warning(
                "member_agent_ignored file={} name={} (multi-agent roster retired in favor of session-per-agent worktrees)",
                path.name,
                cfg.name,
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
    lead_agent = _build_agent(
        lead_cfg, tool_registry, provider_factory, source_path=lead_path, mode=mode
    )
    runtime = SessionRuntime(
        lead_agent,
        db_factory=db_factory,
        provider_factory=provider_factory,
        extra_tools=extra_tools,
        workspace=workspace,
    )
    logger.info("session_runtime_loaded agent={}", lead_cfg.name)
    return runtime


# ---------------------------------------------------------------------------
# Single-agent rebuild — used by ``SessionRuntime`` for in-place refresh
# ---------------------------------------------------------------------------


def rebuild_agent_from_disk(
    source_path: Path,
    *,
    provider_factory: ProviderFactory | None = None,
    extra_tools: dict[str, Tool] | None = None,
    mode: str = "coding",
) -> Agent:
    """Re-parse one agent ``.md`` and return a fresh :class:`Agent`.

    Called by :class:`SessionRuntime` when drift is detected.  Caller
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
