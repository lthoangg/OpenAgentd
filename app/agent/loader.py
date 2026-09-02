"""Agent configuration loader.

Loads agent definitions from per-agent Markdown files with YAML frontmatter.
"""

from __future__ import annotations

import re
import tempfile
from pathlib import Path
from typing import Literal

import yaml
from loguru import logger
from pydantic import BaseModel, model_validator

from app.agent.agent_loop import Agent
from app.agent.builtin_prompts import (
    apply_openagentd_extra_prompt,
    openagentd_description_for_mode,
    openagentd_tools_for_mode,
)
from app.agent.drift import ConfigStamp, detect_drift, stamp_agent_files
from app.agent.providers.factory import ProviderFactory, build_provider
from app.agent.session import AgentSession
from app.agent.tools.registry import Tool
from app.agent.providers.unconfigured import UnconfiguredProviderError
from app.core.db import DbFactory, resolve_db_factory

__all__ = [
    "AgentConfig",
    "ConfigStamp",
    "ProviderFactory",
    "detect_drift",
    "load_agent_from_dir",
    "parse_agent_md",
    "rebuild_agent_from_disk",
    "stamp_agent_files",
]

_FRONTMATTER_RE = re.compile(r"^\s*---\r?\n(.*?)\r?\n---\r?\n?(.*)", re.DOTALL)


def member_model_is_configured(model: str | None) -> bool:
    """Return whether a model is configured."""
    from app.core.config import PROVIDER_MODEL_TOKEN

    return bool(model and model.strip() and model.strip() != PROVIDER_MODEL_TOKEN)


class AgentConfig(BaseModel):
    """Schema for a single agent defined in a .md frontmatter block."""

    name: str
    role: Literal["lead", "member"] = "lead"
    description: str | None = None
    system_prompt: str = ""
    tools: list[str] = []
    mcp: list[str] = []
    model: str | None = None
    thinking_level: str | None = None
    responses_api: bool | None = None

    @model_validator(mode="after")
    def _validate(self) -> "AgentConfig":
        from app.core.config import PROVIDER_MODEL_TOKEN

        if self.model and self.model != PROVIDER_MODEL_TOKEN and ":" not in self.model:
            raise ValueError(
                f"Agent '{self.name}': invalid model '{self.model}' "
                "(expected format: 'provider:model', e.g. 'googlegenai:gemini-3.1-flash')"
            )
        return self


def parse_agent_md(path: Path) -> AgentConfig:
    """Parse an agent Markdown file with YAML frontmatter."""
    text = path.read_text(encoding="utf-8")
    match = _FRONTMATTER_RE.match(text)
    if not match:
        raise ValueError(
            f"Agent file '{path.name}' is missing frontmatter block (---\\n...\\n---)"
        )

    raw_meta = yaml.safe_load(match.group(1))
    if not isinstance(raw_meta, dict):
        raise ValueError(f"Agent file '{path.name}' frontmatter must be a YAML mapping")

    if "name" not in raw_meta or not str(raw_meta.get("name", "")).strip():
        raw_meta["name"] = path.stem

    body = match.group(2).strip()
    cfg = AgentConfig.model_validate(raw_meta)
    cfg.system_prompt = body
    return cfg


def validate_canonical_code_profile(path: Path) -> AgentConfig:
    """Parse the canonical profile and require an explicit ``name: code``."""
    cfg = parse_agent_md(path)
    text = path.read_text(encoding="utf-8")
    match = _FRONTMATTER_RE.match(text)
    raw_meta = yaml.safe_load(match.group(1)) if match else None
    if (
        not isinstance(raw_meta, dict)
        or raw_meta.get("name") != "code"
        or cfg.name != "code"
    ):
        raise ValueError("Canonical agent profile 'code.md' must declare name 'code'")
    return cfg


def _atomic_write_text(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(
        "w",
        dir=path.parent,
        delete=False,
        encoding="utf-8",
    ) as tmp:
        tmp.write(content)
        tmp_path = Path(tmp.name)
    tmp_path.replace(path)


def _builtin_agent_md(
    *,
    name: str,
    role: str = "lead",
    description: str,
    model: str,
) -> str:
    return f"""---
name: {name}
role: {role}
description: {description}
model: {model}
---
"""


def ensure_builtin_code_agent(agents_dir: Path, *, mode: str = "coding") -> bool:
    """Restore the default agent config only when missing."""
    target = agents_dir / "code.md"
    if target.exists():
        return False

    from app.core.config import DEFAULT_NEW_USER_MODEL

    _atomic_write_text(
        target,
        _builtin_agent_md(
            name="code",
            role="lead",
            description=openagentd_description_for_mode(mode),
            model=DEFAULT_NEW_USER_MODEL,
        ),
    )
    logger.info("builtin_code_agent_materialized mode={} path={}", mode, target)
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


_CONTEXT_INJECTED_TOOLS = frozenset(
    {
        "skill",
        "todo_manage",
        "schedule_task",
        "lsp",
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
    registry.update(mcp_manager.get_tools_dict())
    return registry


def _prune_unknown_tools_from_file(path: Path, unknown: list[str]) -> None:
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
    except Exception as exc:
        logger.warning("agent_tools_prune_failed file={} error={}", path, exc)


def _build_agent(
    cfg: AgentConfig,
    tool_registry: dict[str, Tool],
    provider_factory: ProviderFactory,
    *,
    source_path: Path | None = None,
    mode: str = "coding",
) -> Agent:
    system_prompt = cfg.system_prompt
    if cfg.name == "code":
        cfg.description = cfg.description or openagentd_description_for_mode(mode)
        cfg.tools = [*openagentd_tools_for_mode(mode), *cfg.tools]
        system_prompt = apply_openagentd_extra_prompt(mode, cfg.system_prompt)

    from app.agent.tools.builtin.schedule import schedule_task as _schedule_task_tool
    from app.agent.tools.builtin.skill import load_skill as _load_skill_tool
    from app.agent.tools.builtin.todo import todo_manage

    _load_skill = tool_registry.get("skill", _load_skill_tool)
    _todo_manage = tool_registry.get("todo_manage", todo_manage)
    _schedule_task = tool_registry.get("schedule_task", _schedule_task_tool)
    tools: list[Tool] = [_load_skill, _todo_manage, _schedule_task]

    seen: set[str] = {t.name for t in tools}
    cfg.tools = list(dict.fromkeys(cfg.tools))
    cfg.mcp = list(dict.fromkeys(cfg.mcp))
    unknown_tools: list[str] = []
    for tool_name in cfg.tools:
        if tool_name in _CONTEXT_INJECTED_TOOLS:
            continue
        if tool_name not in tool_registry:
            unknown_tools.append(tool_name)
            continue
        if tool_name in seen:
            continue
        seen.add(tool_name)
        tools.append(tool_registry[tool_name])

    if unknown_tools and source_path is not None:
        _prune_unknown_tools_from_file(source_path, unknown_tools)

    from app.agent.mcp import mcp_manager

    for server_name in cfg.mcp:
        server_tools = mcp_manager.get_tools_for_server(server_name)
        if server_tools:
            for mcp_tool in server_tools:
                if mcp_tool.name not in seen:
                    seen.add(mcp_tool.name)
                    tools.append(mcp_tool)

    try:
        provider_instance = provider_factory(
            cfg.model,
            model_kwargs=(
                {"thinking_level": cfg.thinking_level} if cfg.thinking_level else None
            ),
        )
    except UnconfiguredProviderError:
        from app.agent.providers.unconfigured import UnconfiguredProvider

        provider_instance = UnconfiguredProvider()

    agent = Agent(
        llm_provider=provider_instance,
        system_prompt=system_prompt,
        tools=tools,
        name=cfg.name,
        description=cfg.description,
        model_id=cfg.model,
        mcp_servers=cfg.mcp,
    )

    if source_path is not None:
        from app.agent.mcp.config import config_path as _mcp_config_path

        agent.source_path = source_path
        agent.config_stamp = stamp_agent_files(
            agent_md_path=source_path,
            mcp_config_path=_mcp_config_path(),
        )

    return agent


def load_agent_from_dir(
    agents_dir: str | Path,
    *,
    provider_factory: ProviderFactory | None = None,
    extra_tools: dict[str, Tool] | None = None,
    db_factory: DbFactory | None = None,
    mode: str = "coding",
    workspace: str | None = None,
) -> AgentSession | None:
    """Load an AgentSession from an agents directory."""
    agents_dir = Path(agents_dir).resolve()
    if not agents_dir.exists():
        return None

    target_path = agents_dir / "code.md"
    if not target_path.is_file():
        return None

    cfg = validate_canonical_code_profile(target_path)

    tool_registry = _default_tool_registry()
    if extra_tools:
        tool_registry.update(extra_tools)

    if provider_factory is None:
        provider_factory = build_provider

    db_factory = resolve_db_factory(db_factory)

    agent = _build_agent(
        cfg,
        tool_registry,
        provider_factory,
        source_path=target_path,
        mode=mode,
    )

    session = AgentSession(
        agent=agent,
        workspace=workspace,
        db_factory=db_factory,
        provider_factory=provider_factory,
        extra_tools=extra_tools,
    )
    logger.info("agent_loaded name={} model={}", cfg.name, agent.model_id)
    return session


def rebuild_agent_from_disk(
    source_path: Path,
    *,
    provider_factory: ProviderFactory | None = None,
    extra_tools: dict[str, Tool] | None = None,
    mode: str = "coding",
) -> Agent:
    cfg = parse_agent_md(source_path)

    tool_registry = _default_tool_registry()
    if extra_tools:
        tool_registry.update(extra_tools)

    if provider_factory is None:
        provider_factory = build_provider

    return _build_agent(
        cfg, tool_registry, provider_factory, source_path=source_path, mode=mode
    )
