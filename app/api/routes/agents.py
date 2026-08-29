"""Canonical coding-agent configuration API.

Validates each write against ``AgentConfig`` and agent invariants
(known tools and valid models).  Failed validation rolls the
file back.  Running agents pick up new config on their next turn.
"""

from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException, Request
from loguru import logger
from pydantic import ValidationError

from app.agent.loader import AgentConfig
from app.agent.hooks.summarization import resolve_prompt_token_threshold
from app.agent.providers.capabilities import get_capabilities
from app.agent.providers.catalog import ProviderEntry, all_providers
from app.agent.providers.model_metadata import get_model_thinking_levels
from app.agent.providers.model_discovery import (
    filter_agent_model_ids,
    is_agent_model_id,
)
from app.agent.providers.opencode.access import model_is_accessible
from app.agent.providers.opencode.constants import PROVIDER_IDS as OPENCODE_PROVIDER_IDS
from app.core.runtime_settings import (
    ProviderUiSettings,
    effective_visible_models,
    load_runtime_settings,
    set_provider_cached_models,
)
from app.agent.tools.builtin.skill import discover_skills
from app.api.routes.settings import (
    _provider_is_configured,
    _provider_saved_overrides,
)
from app.api.schemas.base import _validation_detail
from app.api.schemas.agents import (
    AgentDetail,
    AgentWriteRequest,
    ModelCatalogEntry,
    RegistryResponse,
    SkillCatalogEntry,
    ToolCatalogEntry,
)
from app.services import agent_fs
from app.services.agent_fs import (
    AgentFsNotFoundError,
    AgentFsPathError,
)

router = APIRouter()

# ── Helpers ─────────────────────────────────────────────────────────────────


def _effective_config(cfg: AgentConfig, *, mode: str) -> AgentConfig:
    """Return config with built-in first-party defaults applied.

    This mirrors runtime merging for metadata/capability fields without
    changing the raw saved file. Prompts are intentionally left as saved body in
    API config; callers edit extras, not the expanded runtime prompt.
    """
    data = cfg.model_copy(deep=True)
    implicit_tools = ["skill"]
    if data.role == "lead":
        implicit_tools += ["todo_manage", "schedule_task", "note"]
    data.tools = [*implicit_tools, *data.tools]
    if data.role == "lead" and data.name == "code":
        from app.agent.builtin_prompts import (
            openagentd_description_for_mode,
            openagentd_tools_for_mode,
        )

        data.description = data.description or openagentd_description_for_mode(mode)
        data.tools = list(
            dict.fromkeys([*openagentd_tools_for_mode(mode), *data.tools])
        )
        data.mcp = list(dict.fromkeys(data.mcp))
    data.tools = list(dict.fromkeys(data.tools))
    return data


def _parse_content(content: str) -> AgentConfig:
    """Parse the canonical coding-agent Markdown (no disk I/O)."""
    from app.agent.loader import _FRONTMATTER_RE

    m = _FRONTMATTER_RE.match(content)
    if not m:
        raise ValueError(
            "Missing YAML frontmatter. Expected '---\\n<yaml>\\n---\\n<system prompt>'."
        )
    import yaml

    try:
        raw_meta = yaml.safe_load(m.group(1)) or {}
    except yaml.YAMLError as exc:
        raise ValueError(f"Invalid YAML frontmatter: {exc}") from exc
    if not isinstance(raw_meta, dict):
        raise ValueError("Frontmatter must be a YAML mapping.")
    if raw_meta.get("name") != "code":
        raise ValueError("Canonical agent profile 'code.md' must declare name 'code'")
    body = m.group(2).strip()
    raw_meta["system_prompt"] = body or "You are a helpful assistant."
    try:
        return AgentConfig.model_validate(raw_meta)
    except ValidationError as exc:
        raise ValueError(_validation_detail(exc)) from exc


def _validation_dir_for_name(name: str) -> Path:
    rel_parent = Path(name).parent
    if str(rel_parent) == ".":
        return agent_fs.agents_dir()
    return agent_fs.agents_dir() / rel_parent


async def _validate_or_restore(
    rollback_name: str | None, rollback_content: str | None
) -> None:
    """Re-validate the agents directory; roll back on failure.

    ``rollback_content=None`` → delete the just-created file; otherwise
    restore the previous text.
    """
    from app.agent.loader import load_agent_from_dir

    try:
        validation_dir = (
            agent_fs.agents_dir()
            if rollback_name is None
            else _validation_dir_for_name(rollback_name)
        )
        candidate = load_agent_from_dir(validation_dir)
        if candidate is None:
            raise ValueError(
                f"No agents would remain in '{validation_dir}'. "
                "At least one .md file is required."
            )
    except ValueError as exc:
        if rollback_name is not None and rollback_content is not None:
            try:
                try:
                    agent_fs.write_agent(rollback_name, rollback_content, create=True)
                except agent_fs.AgentFsConflictError:
                    agent_fs.write_agent(rollback_name, rollback_content, create=False)
            except Exception:
                logger.exception("agents_rollback_failed name={}", rollback_name)
        elif rollback_name is not None and rollback_content is None:
            try:
                agent_fs.delete_agent(rollback_name)
            except Exception:
                logger.exception("agents_rollback_delete_failed name={}", rollback_name)
        raise HTTPException(status_code=422, detail=str(exc)) from exc


# ── Routes ──────────────────────────────────────────────────────────────────


async def _warm_provider_model_cache() -> None:
    """Populate missing cached models for configured providers once per request."""
    from app.agent.providers.model_discovery import discover_provider_models

    provider_entries = list(all_providers())
    provider_ui_settings = load_runtime_settings().providers
    candidates = []
    for entry in provider_entries:
        provider_ui = provider_ui_settings.get(entry["id"], ProviderUiSettings())
        if (
            _provider_is_configured(entry)
            and not provider_ui.is_disconnected
            and not provider_ui.cached_models
        ):
            candidates.append(entry)
    if not candidates:
        return

    # Static configuration treats local daemons optimistically. Probe them
    # before model discovery so a stopped Ollama/router cannot hold the registry
    # request in the provider discovery retry path.
    from app.api.routes.settings import _DAEMON_PROVIDER_IDS, _provider_is_reachable

    async def _candidate_is_reachable(entry: ProviderEntry) -> bool:
        if entry["id"] not in _DAEMON_PROVIDER_IDS:
            return True
        return await _provider_is_reachable(entry)

    reachable = await asyncio.gather(
        *(_candidate_is_reachable(entry) for entry in candidates)
    )
    configured = [
        entry
        for entry, is_reachable in zip(candidates, reachable, strict=True)
        if is_reachable
    ]
    if not configured:
        return

    discovered = await asyncio.gather(
        *(
            discover_provider_models(
                entry,
                overrides=_provider_saved_overrides(entry),
            )
            for entry in configured
        ),
        return_exceptions=True,
    )
    for entry, models in zip(configured, discovered, strict=True):
        if isinstance(models, BaseException):
            logger.info(
                "provider_model_cache_warm_failed provider={} error={}",
                entry["id"],
                models,
            )
            continue
        cleaned = filter_agent_model_ids(models)
        if cleaned:
            set_provider_cached_models(entry["id"], cleaned)


@router.get("/registry")
async def get_registry(request: Request) -> RegistryResponse:
    """Dropdown catalog: tools, skills, providers, known models."""
    from app.agent.loader import _default_tool_registry

    refresh_task = getattr(request.app.state, "model_registry_refresh_task", None)
    if refresh_task is not None:
        await asyncio.shield(refresh_task)

    await _warm_provider_model_cache()

    try:
        runtime_settings = load_runtime_settings()
        _custom_threshold: int | None = (
            runtime_settings.summarization.prompt_token_threshold
        )
    except Exception:
        # Preserve the previous route behavior: threshold parsing failures were
        # ignored here, but provider UI reads still surfaced settings errors.
        _custom_threshold = None
        runtime_settings = load_runtime_settings()

    def _effective_summary_trigger(mid: str) -> int:
        return resolve_prompt_token_threshold(mid, _custom_threshold)

    tool_registry = _default_tool_registry()
    hidden_tools = {"skill", "todo_manage", "schedule_task", "note"}
    tools = sorted(
        (
            ToolCatalogEntry(name=t.name, description=t.description or "")
            for t in tool_registry.values()
            if t.name not in hidden_tools
        ),
        key=lambda t: t.name,
    )

    skill_map = discover_skills()
    skills = sorted(
        (
            SkillCatalogEntry(name=k, description=v.get("description", ""))
            for k, v in skill_map.items()
        ),
        key=lambda s: s.name,
    )

    # Provider IDs straight from the catalog — single source of truth.
    # Previously this was derived from the capability resolver's prefix
    # table; the resolver no longer has one (see capabilities.py).
    all_provider_entries = list(all_providers())
    provider_entries = {entry["id"]: entry for entry in all_provider_entries}
    providers = sorted(provider_entries)

    # Build a per-provider fast-mode support map so models can advertise it
    # without hard-coding a prefix list on the frontend.
    fast_mode_providers: set[str] = {
        entry["id"]
        for entry in all_provider_entries
        if entry.get("supports_fast_mode", False)
    }

    seen: set[str] = set()
    models: list[ModelCatalogEntry] = []

    def _append(provider: str, model: str) -> None:
        model_id = f"{provider}:{model}"
        if model_id in seen:
            return
        seen.add(model_id)
        caps = get_capabilities(model_id)
        models.append(
            ModelCatalogEntry(
                id=model_id,
                provider=provider,
                model=model,
                vision=caps.input.vision,
                output_image=caps.output.image,
                output_video=caps.output.video,
                thinking_levels=list(get_model_thinking_levels(model_id)),
                summary_trigger_tokens=_effective_summary_trigger(model_id),
                fast_mode=provider in fast_mode_providers,
            )
        )

    from app.agent.providers.model_registry import load_model_registry

    static_registry = load_model_registry()

    provider_ui_settings = runtime_settings.providers
    for provider in providers:
        entry = provider_entries[provider]
        provider_ui = provider_ui_settings.get(provider, ProviderUiSettings())
        if provider_ui.is_disconnected:
            continue
        has_credentials = provider not in OPENCODE_PROVIDER_IDS or (
            _provider_is_configured(entry)
        )
        visible = set(effective_visible_models(provider_ui))
        # 1. Add cached/discovered agent models
        for model in provider_ui.cached_models:
            if not model_is_accessible(
                provider,
                model,
                has_credentials=has_credentials,
            ):
                continue
            model_id = f"{provider}:{model}"
            if is_agent_model_id(model_id):
                if not visible or model in visible:
                    _append(provider, model)

        # 2. Add static multimodal models defined in the registry
        for model_key in static_registry:
            if ":" not in model_key:
                continue
            p, m = model_key.split(":", 1)
            if p.lower() != provider.lower() or not model_is_accessible(
                provider,
                m,
                has_credentials=has_credentials,
            ):
                continue
            caps = get_capabilities(model_key)
            if caps.output.image or caps.output.video:
                _append(provider, m)

    models.sort(key=lambda item: (item.provider, item.model))

    return RegistryResponse(
        tools=tools,
        skills=skills,
        providers=providers,
        models=models,
    )


async def is_registered_model_id(model_id: str) -> bool:
    """Return whether *model_id* is currently selectable from the registry."""
    if ":" not in model_id:
        return False
    provider, model = model_id.split(":", 1)
    if not provider or not model:
        return False

    entry = next(
        (candidate for candidate in all_providers() if candidate["id"] == provider),
        None,
    )
    if entry is None:
        return False
    provider_ui = load_runtime_settings().providers.get(provider, ProviderUiSettings())
    if provider_ui.is_disconnected:
        return False

    visible = set(effective_visible_models(provider_ui))
    if visible and model not in visible:
        return False
    has_credentials = provider not in OPENCODE_PROVIDER_IDS or (
        _provider_is_configured(entry)
    )
    if not model_is_accessible(
        provider,
        model,
        has_credentials=has_credentials,
    ):
        return False
    return is_agent_model_id(model) and model in provider_ui.cached_models


@router.get("/code")
async def get_agent() -> AgentDetail:
    name = "code"
    try:
        record = agent_fs.read_agent(name)
    except AgentFsPathError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except AgentFsNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc

    config: dict[str, Any] | None = None
    error: str | None = None
    try:
        cfg = _parse_content(record.content)
        config = _effective_config(cfg, mode="coding").model_dump(exclude_none=True)
    except ValueError as exc:
        error = str(exc)

    return AgentDetail(
        name=record.name,
        path=record.path,
        content=record.content,
        config=config,
        error=error,
    )


@router.put("/code")
async def update_agent(body: AgentWriteRequest) -> AgentDetail:
    name = "code"
    if body.name != name:
        raise HTTPException(
            status_code=422,
            detail=f"URL name '{name}' does not match body name '{body.name}'.",
        )

    try:
        previous = agent_fs.read_agent(name)
    except AgentFsNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except AgentFsPathError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    try:
        cfg = _parse_content(body.content)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    try:
        record = agent_fs.write_agent(name, body.content, create=False)
    except AgentFsPathError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    await _validate_or_restore(rollback_name=name, rollback_content=previous.content)

    return AgentDetail(
        name=record.name,
        path=record.path,
        content=record.content,
        config=cfg.model_dump(exclude_none=True),
    )
