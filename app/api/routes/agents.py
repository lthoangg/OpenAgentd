"""Agent CRUD: writes ``.md`` files under ``AGENTS_DIR``.

Validates each write against ``AgentConfig`` and team invariants
(one lead, known tools, valid models).  Failed validation rolls the
file back.  Running agents pick up new config on their next turn.
"""

from __future__ import annotations

import asyncio
import time
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException
from loguru import logger
from pydantic import ValidationError

from app.agent.loader import AgentConfig
from app.agent.hooks.summarization import prompt_token_threshold_for_model
from app.agent.providers.capabilities import get_capabilities
from app.agent.providers.catalog import ProviderEntry, all_providers
from app.agent.providers.model_discovery import (
    discover_provider_models,
    filter_agent_model_ids,
)
from app.core.runtime_settings import provider_visible_models
from app.agent.tools.builtin.skill import discover_skills
from app.api.schemas.agents import (
    AgentDeleteResponse,
    AgentDetail,
    AgentListResponse,
    AgentSummary,
    AgentWriteRequest,
    ModelCatalogEntry,
    RegistryResponse,
    SkillCatalogEntry,
    ToolCatalogEntry,
)
from app.services import agent_fs
from app.services.agent_fs import (
    AgentFsConflictError,
    AgentFsNotFoundError,
    AgentFsPathError,
)

router = APIRouter()

# Live-discovered provider models are cached per-provider so each
# ``/agents/registry`` call doesn't fan out to every configured backend.
# TTL is short so newly-added models become visible without a restart.
_REGISTRY_MODEL_CACHE_TTL_S = 60.0
_registry_model_cache: dict[str, tuple[float, list[str]]] = {}


# ── Helpers ─────────────────────────────────────────────────────────────────


def _parse_summary(name: str, content: str) -> AgentSummary:
    """Never raises; invalid agents are flagged via ``valid=False``."""
    try:
        cfg = _parse_content(name, content)
    except ValueError as exc:
        return AgentSummary(
            name=name,
            role="member",
            description=None,
            model=None,
            tools=[],
            mcp=[],
            skills=[],
            valid=False,
            error=str(exc),
        )
    mode = _mode_for_agent_path(name)
    effective = _effective_config(cfg, mode=mode)
    return AgentSummary(
        name=name,
        role=effective.role,
        description=effective.description,
        model=effective.model,
        tools=effective.tools,
        mcp=effective.mcp,
        skills=effective.skills,
        valid=True,
        error=None,
    )


def _mode_for_agent_path(name: str) -> str:
    return "coding" if Path(name).parts[:1] == ("coding",) else "normal"


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
    if data.role == "lead" and data.name == "openagentd":
        from app.agent.builtin_prompts import (
            openagentd_description_for_mode,
            openagentd_tools_for_mode,
        )

        data.description = data.description or openagentd_description_for_mode(mode)
        data.tools = list(
            dict.fromkeys([*openagentd_tools_for_mode(mode), *data.tools])
        )
        data.mcp = list(dict.fromkeys(data.mcp))
    elif data.role == "member":
        from app.agent.builtin_prompts import builtin_member_profile

        profile = builtin_member_profile(mode, data.name)
        if profile is not None:
            data.description = data.description or profile["description"]
            data.tools = list(dict.fromkeys([*profile["tools"], *data.tools]))
            data.skills = list(dict.fromkeys([*profile["skills"], *data.skills]))
            data.mcp = list(dict.fromkeys([*profile["mcp"], *data.mcp]))
    data.tools = list(dict.fromkeys(data.tools))
    return data


def _parse_content(name: str, content: str) -> AgentConfig:
    """Parse raw .md text into an ``AgentConfig`` (no disk I/O)."""
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
    body = m.group(2).strip()
    raw_meta.setdefault("name", _frontmatter_name_for_path(name))
    raw_meta["system_prompt"] = body or "You are a helpful assistant."
    try:
        return AgentConfig.model_validate(raw_meta)
    except ValidationError as exc:
        errors = "; ".join(
            f"{'.'.join(str(p) for p in e['loc'])}: {e['msg']}" for e in exc.errors()
        )
        raise ValueError(errors) from exc


def _require_frontmatter_name(name: str, content: str) -> None:
    cfg = _parse_content(name, content)
    expected_name = _frontmatter_name_for_path(name)
    if cfg.name != expected_name:
        raise HTTPException(
            status_code=422,
            detail=(f"Frontmatter name '{cfg.name}' does not match URL name '{name}'."),
        )


def _frontmatter_name_for_path(name: str) -> str:
    return Path(name).name


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
    from app.agent.loader import load_team_from_dir

    try:
        validation_dir = (
            agent_fs.agents_dir()
            if rollback_name is None
            else _validation_dir_for_name(rollback_name)
        )
        candidate = load_team_from_dir(validation_dir)
        if candidate is None:
            raise ValueError(
                f"No agents would remain in '{validation_dir}'. "
                "At least one .md file with 'role: lead' is required."
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


@router.get("")
async def list_agents() -> AgentListResponse:
    rows: list[AgentSummary] = []
    for name in agent_fs.list_agents():
        try:
            record = agent_fs.read_agent(name)
        except Exception as exc:
            rows.append(
                AgentSummary(
                    name=name,
                    role="member",
                    valid=False,
                    error=str(exc),
                )
            )
            continue
        rows.append(_parse_summary(name, record.content))
    return AgentListResponse(agents=rows)


@router.get("/registry")
async def get_registry() -> RegistryResponse:
    """Dropdown catalog: tools, skills, providers, known models."""
    from app.agent.loader import _default_tool_registry

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
    providers = sorted(entry["id"] for entry in all_providers())

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
                summary_trigger_tokens=prompt_token_threshold_for_model(model_id),
            )
        )

    def _visible(provider: str, models: list[str]) -> list[str]:
        visible = set(provider_visible_models(provider))
        if not visible:
            return models
        return [model for model in models if model in visible]

    # Live discovery covers every configured provider that has a working
    # ``/models`` endpoint. For the rare provider with no listing API
    # upstream, the catalog carries a curated
    # ``fallback_models`` list — but we only surface it when the provider
    # is configured, so the agent dropdown never advertises models the
    # user can't actually run.
    from app.api.routes.settings import _provider_is_configured

    for entry in all_providers():
        fallback = entry.get("fallback_models", [])
        if not fallback or not _provider_is_configured(entry):
            continue
        for model in _visible(entry["id"], filter_agent_model_ids(list(fallback))):
            _append(entry["id"], model)

    visible_by_provider: dict[str, set[str]] = {}
    for provider, model in await _discover_configured_registry_models():
        visible = visible_by_provider.setdefault(
            provider, set(provider_visible_models(provider))
        )
        if not visible or model in visible:
            _append(provider, model)

    models.sort(key=lambda item: (item.provider, item.model))

    return RegistryResponse(
        tools=tools,
        skills=skills,
        providers=providers,
        models=models,
    )


async def _discover_configured_registry_models() -> list[tuple[str, str]]:
    """Concurrently discover live models for every configured provider.

    Results are cached per-provider for :data:`_REGISTRY_MODEL_CACHE_TTL_S`
    seconds, and discovery failures degrade silently (the cached fallback
    or just the curated catalog is shown instead). We *only* poll
    providers that are already configured — otherwise we'd send empty
    requests to every backend on every registry call.
    """
    # Avoid a circular-import-on-startup hazard: this helper is imported
    # from settings.py for the configuration check.
    from app.api.routes.settings import (
        _provider_is_configured,
        _provider_saved_overrides,
    )

    configured: list[ProviderEntry] = [
        entry for entry in all_providers() if _provider_is_configured(entry)
    ]
    if not configured:
        return []

    now = time.monotonic()

    async def _fetch(entry: ProviderEntry) -> tuple[str, list[str]]:
        provider_id = entry["id"]
        cached = _registry_model_cache.get(provider_id)
        if cached and now - cached[0] < _REGISTRY_MODEL_CACHE_TTL_S:
            return provider_id, cached[1]
        models = await discover_provider_models(
            entry, overrides=_provider_saved_overrides(entry)
        )
        _registry_model_cache[provider_id] = (now, models)
        return provider_id, models

    results = await asyncio.gather(
        *(_fetch(entry) for entry in configured),
        return_exceptions=True,
    )

    out: list[tuple[str, str]] = []
    for result in results:
        if isinstance(result, BaseException):
            logger.info("registry_model_discovery_failed error={}", result)
            continue
        provider_id, model_ids = result
        out.extend((provider_id, model) for model in filter_agent_model_ids(model_ids))
    return out


async def is_registered_model_id(model_id: str) -> bool:
    """Return whether *model_id* is currently selectable from the registry."""
    if ":" not in model_id:
        return False
    provider, model = model_id.split(":", 1)
    if not provider or not model:
        return False

    from app.api.routes.settings import _provider_is_configured

    for entry in all_providers():
        if entry["id"] != provider or not _provider_is_configured(entry):
            continue
        fallback = filter_agent_model_ids(list(entry.get("fallback_models", [])))
        visible = set(provider_visible_models(provider))
        if visible and model not in visible:
            return False
        if model in fallback:
            return True
        discovered = await _discover_configured_registry_models()
        return any(p == provider and m == model for p, m in discovered)
    return False


@router.get("/{name}")
@router.get("/{name:path}")
async def get_agent(name: str) -> AgentDetail:
    try:
        record = agent_fs.read_agent(name)
    except AgentFsPathError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except AgentFsNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc

    config: dict[str, Any] | None = None
    error: str | None = None
    try:
        cfg = _parse_content(name, record.content)
        config = _effective_config(cfg, mode=_mode_for_agent_path(name)).model_dump(
            exclude_none=True
        )
    except ValueError as exc:
        error = str(exc)

    return AgentDetail(
        name=record.name,
        path=record.path,
        content=record.content,
        config=config,
        error=error,
    )


@router.post("", status_code=201)
async def create_agent(body: AgentWriteRequest) -> AgentDetail:
    try:
        cfg = _parse_content(body.name, body.content)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    expected_name = _frontmatter_name_for_path(body.name)
    if cfg.name != expected_name:
        raise HTTPException(
            status_code=422,
            detail=(
                f"Frontmatter name '{cfg.name}' must match the request name "
                f"'{expected_name}'."
            ),
        )

    try:
        record = agent_fs.write_agent(body.name, body.content, create=True)
    except AgentFsConflictError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except AgentFsPathError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    await _validate_or_restore(rollback_name=body.name, rollback_content=None)

    return AgentDetail(
        name=record.name,
        path=record.path,
        content=record.content,
        config=cfg.model_dump(exclude_none=True),
    )


@router.put("/{name}")
@router.put("/{name:path}")
async def update_agent(name: str, body: AgentWriteRequest) -> AgentDetail:
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
        cfg = _parse_content(name, body.content)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    _require_frontmatter_name(name, body.content)

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


@router.delete("/{name}")
@router.delete("/{name:path}")
async def delete_agent(name: str) -> AgentDeleteResponse:
    """422 if removal would leave the team without a lead."""
    try:
        previous = agent_fs.read_agent(name)
    except AgentFsNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except AgentFsPathError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    try:
        agent_fs.delete_agent(name)
    except AgentFsPathError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    await _validate_or_restore(rollback_name=name, rollback_content=previous.content)
    return AgentDeleteResponse(name=name)
