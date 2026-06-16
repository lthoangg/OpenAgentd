"""Generic ``/api/settings`` endpoints.

Exposes the user-editable sandbox deny-list and the provider catalog.

Application updates are deliberately not served here. Desktop bundle users
trigger updates from the native menu bar (``tauri-plugin-updater``); CLI
users run ``openagentd upgrade`` (see ``app/cli/commands/upgrade.py``).
"""

from __future__ import annotations

import asyncio
import os
import time
from pathlib import Path
from typing import TYPE_CHECKING

import httpx
from fastapi import APIRouter, HTTPException
from loguru import logger

from app.agent.sandbox_config import SandboxFileConfig, load_config, save_config
from app.core.config import settings
from app.core.runtime_settings import (
    provider_visible_models,
    set_provider_visible_models,
)

if TYPE_CHECKING:
    from app.agent.providers.catalog import ProviderEntry
from app.api.schemas.settings import (
    ProviderInfo,
    ProviderModelsRequest,
    ProviderModelsResponse,
    ProviderSaveRequest,
    ProviderSaveResponse,
    ProviderTestRequest,
    ProviderTestResponse,
    ProviderUsageResponse,
    ProviderVisibleModelsRequest,
    ProviderVisibleModelsResponse,
    ProvidersListBody,
    MultimodalSettingsBody,
    SandboxSettingsBody,
    SeedInstallRequest,
    SeedInstallResponse,
    TitleGenerationSettingsBody,
)
from app.services.provider_usage import (
    ProviderUsageCredentialsError,
    ProviderUsageUnavailableError,
    ProviderUsageUnsupportedError,
    get_provider_usage as load_provider_usage,
)

router = APIRouter()

# Serialises concurrent provider tests. ``build_provider`` reads credentials
# from ``os.environ`` deep in the factory; the test endpoint has to mutate
# it temporarily, so a lock prevents two in-flight tests from clobbering
# each other's keys.
_TEST_PROVIDER_LOCK = asyncio.Lock()

# Per-provider reachability cache (provider_id → (monotonic_ts, reachable)).
# Local-daemon providers (Ollama, 9Router, CLIProxyAPI) need an actual ping
# — without it every install would falsely show "Connected" just because
# the env var was set or the catalog row exists. We cache the result
# briefly so listing providers doesn't fan out probes on every render.
_LOCAL_REACHABLE_TTL_S = 10.0
_LOCAL_REACHABLE_TIMEOUT_S = 1.0
_local_reachable_cache: dict[str, tuple[float, bool]] = {}

# Providers that run as a local-ish daemon — even when authed by API key,
# "Connected" should mean the daemon actually responds.
_DAEMON_PROVIDER_IDS = frozenset({"ollama", "router9", "cliproxy"})


@router.get("/sandbox")
async def get_sandbox_settings() -> SandboxSettingsBody:
    """Return the current sandbox deny-list.

    On first run this seeds ``sandbox.yaml`` with sensible defaults
    (``**/.env``, ``**/.env.*``).
    """
    try:
        cfg = load_config()
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return SandboxSettingsBody(denied_patterns=list(cfg.denied_patterns))


@router.put("/sandbox")
async def update_sandbox_settings(body: SandboxSettingsBody) -> SandboxSettingsBody:
    """Replace the sandbox deny-list with the supplied glob patterns."""
    cleaned = [p.strip() for p in body.denied_patterns if p.strip()]
    save_config(SandboxFileConfig(denied_patterns=cleaned))
    return SandboxSettingsBody(denied_patterns=cleaned)


@router.get("/title-generation")
async def get_title_generation_settings() -> TitleGenerationSettingsBody:
    from app.core.runtime_settings import load_runtime_settings

    cfg = load_runtime_settings().title_generation
    return TitleGenerationSettingsBody(
        enabled=cfg.enabled,
        model=cfg.model or "",
        wait_timeout_seconds=cfg.wait_timeout_seconds,
    )


@router.put("/title-generation")
async def update_title_generation_settings(
    body: TitleGenerationSettingsBody,
) -> TitleGenerationSettingsBody:
    from app.core.runtime_settings import load_runtime_settings, save_runtime_settings

    cfg = load_runtime_settings()
    cfg.title_generation.enabled = body.enabled
    cfg.title_generation.model = body.model.strip() or None
    cfg.title_generation.wait_timeout_seconds = max(0.0, body.wait_timeout_seconds)
    save_runtime_settings(cfg)
    return TitleGenerationSettingsBody(
        enabled=cfg.title_generation.enabled,
        model=cfg.title_generation.model or "",
        wait_timeout_seconds=cfg.title_generation.wait_timeout_seconds,
    )


@router.get("/multimodal")
async def get_multimodal_settings() -> MultimodalSettingsBody:
    from app.agent.tools.multimodalities._config import load_raw_config

    raw = load_raw_config()
    return MultimodalSettingsBody.model_validate(raw)


@router.put("/multimodal")
async def update_multimodal_settings(
    body: MultimodalSettingsBody,
) -> MultimodalSettingsBody:
    from app.agent.tools.multimodalities._config import save_raw_config

    save_raw_config(body.model_dump(mode="json", exclude_none=True))
    return body


# ── Providers (Settings → Providers tab) ────────────────────────────────────


def _env_has_provider_key(env_file: "Path") -> bool:
    """Return True if ``.env`` already contains *any* known API-key env var.

    Used by ``save_provider`` to decide whether this save is the user's
    first credential and the frontend should kick off seed installation
    afterward. OAuth tokens (which live in CACHE_DIR, not .env) and the
    Ollama local default don't count — the seed installer needs a
    chat-capable provider:model string, which OAuth providers without a
    saved model don't yet have.
    """
    from app.agent.providers.catalog import PROVIDER_KEY_VAR

    try:
        text = env_file.read_text(encoding="utf-8")
    except OSError:
        return False
    keys = {key for key in PROVIDER_KEY_VAR.values() if key}
    for line in text.splitlines():
        if "=" not in line:
            continue
        name, _, value = line.partition("=")
        if name.strip() in keys and value.strip():
            return True
    return False


def _provider_is_configured(entry: "ProviderEntry") -> bool:
    """Return True if the user's .env has credentials for this provider.

    Synchronous static check — does **not** probe daemons or networks.
    For ``kind="local"`` (Ollama) this returns optimistically; callers
    that care about actual reachability should use
    :func:`_provider_is_reachable` instead, which adds an async daemon
    ping on top of this.
    """
    kind = entry.get("kind")
    from app.agent.providers.plugin_registry import (
        ProviderCredentialStore,
        find_provider_plugin,
    )

    plugin = find_provider_plugin(entry["id"])
    if plugin is not None:
        store = ProviderCredentialStore(plugin.id)
        if plugin.is_configured is not None:
            return plugin.is_configured(store)
        return all(
            store.get(field.name) for field in plugin.credentials if field.required
        )
    if kind == "local":
        return True
    if kind == "oauth":
        cache_dir = Path(settings.OPENAGENTD_CACHE_DIR or "")
        token_files = {
            "codex": cache_dir / "codex_oauth.json",
            "copilot": cache_dir / "copilot_oauth.json",
        }
        token_file = token_files.get(entry["id"])
        return bool(token_file and token_file.is_file())
    if kind == "cloud_creds":
        if entry["id"] == "bedrock":
            store = ProviderCredentialStore(entry["id"])
            profile = os.environ.get("AWS_BEDROCK_PROFILE") or store.get(
                "AWS_BEDROCK_PROFILE"
            )
            access_key = os.environ.get("AWS_ACCESS_KEY_ID") or store.get(
                "AWS_ACCESS_KEY_ID"
            )
            secret_key = os.environ.get("AWS_SECRET_ACCESS_KEY") or store.get(
                "AWS_SECRET_ACCESS_KEY"
            )
            return bool(profile or (access_key and secret_key))
        # Vertex AI: need project + location *and* gcloud ADC. We can't
        # check gcloud from here without shelling out, so the UI's
        # "Test connection" button is the source of truth.
        names = entry.get("env_vars") or []
        return all(os.environ.get(name) for name in names)
    # api_key
    env_var = entry.get("env_var") or ""
    if not env_var:
        return False
    # Check both os.environ (mutated by recent saves) and settings
    # (loaded once at startup) and the user's config .env (loaded by the
    # credential store) so saved keys survive daemon restarts.
    store = ProviderCredentialStore(entry["id"])
    return bool(store.get(env_var))


def _provider_saved_overrides(entry: "ProviderEntry") -> dict[str, str]:
    """Return saved credential values for provider model discovery."""
    from app.agent.providers.plugin_registry import ProviderCredentialStore

    store = ProviderCredentialStore(entry["id"])
    names: set[str] = set()
    if entry.get("env_var"):
        names.add(str(entry["env_var"]))
    names.update(str(name) for name in entry.get("env_vars") or [])
    for field in entry.get("credentials") or []:
        name = str(field.get("name", ""))
        if name:
            names.add(name)
    names.update({"OLLAMA_BASE_URL", "ROUTER9_BASE_URL", "CLIPROXY_BASE_URL"})
    return {name: value for name in names if (value := store.get(name))}


def _provider_saved_display_credentials(entry: "ProviderEntry") -> dict[str, str]:
    """Return saved non-secret credential values that are safe to echo to the UI."""
    saved = _provider_saved_overrides(entry)
    visible_names = {
        str(field.get("name", ""))
        for field in entry.get("credentials") or []
        if field.get("name") and not field.get("secret")
    }
    return {name: value for name, value in saved.items() if name in visible_names}


def _daemon_base_url(provider_id: str) -> str:
    """Resolve the daemon base URL for a local/local-proxy provider."""
    if provider_id == "ollama":
        return os.getenv("OLLAMA_BASE_URL") or settings.OLLAMA_BASE_URL or ""
    if provider_id == "router9":
        return os.getenv("ROUTER9_BASE_URL") or settings.ROUTER9_BASE_URL or ""
    if provider_id == "cliproxy":
        return os.getenv("CLIPROXY_BASE_URL") or settings.CLIPROXY_BASE_URL or ""
    return ""


async def _local_provider_reachable(entry: "ProviderEntry") -> bool:
    """Short-timeout daemon probe for local-daemon providers.

    Returns True only if the daemon actually responds. Cached per-provider
    for :data:`_LOCAL_REACHABLE_TTL_S` seconds so listing the providers
    page doesn't fan out one HTTP request per render.

    On any error (connection refused, timeout, DNS failure) returns
    False — we'd rather show "not connected" than a false positive.
    """
    provider_id = entry["id"]
    now = time.monotonic()
    cached = _local_reachable_cache.get(provider_id)
    if cached and now - cached[0] < _LOCAL_REACHABLE_TTL_S:
        return cached[1]

    base_url = _daemon_base_url(provider_id)
    reachable = False
    if base_url:
        try:
            async with httpx.AsyncClient(timeout=_LOCAL_REACHABLE_TIMEOUT_S) as client:
                response = await client.get(f"{base_url.rstrip('/')}/models")
                reachable = response.status_code < 500
        except Exception as exc:
            logger.debug(
                "local_provider_unreachable provider={} url={} error={}",
                provider_id,
                base_url,
                exc,
            )
            reachable = False

    _local_reachable_cache[provider_id] = (now, reachable)
    return reachable


async def _empty_models() -> list[str]:
    return []


async def _provider_is_reachable(entry: "ProviderEntry") -> bool:
    """Configuration check including a daemon probe for daemon providers.

    For Ollama / 9Router / CLIProxyAPI we *also* require the daemon to
    respond on its base URL — otherwise the UI would show "Connected"
    for a daemon that isn't running. Other providers fall back to the
    static :func:`_provider_is_configured` check.
    """
    provider_id = entry["id"]
    if provider_id in _DAEMON_PROVIDER_IDS:
        # For api_key daemon providers (router9, cliproxy) the static
        # check additionally requires the env var. No env var → don't
        # bother probing.
        if entry.get("kind") == "api_key" and not _provider_is_configured(entry):
            return False
        return await _local_provider_reachable(entry)
    return _provider_is_configured(entry)


@router.get("/providers")
async def list_providers() -> ProvidersListBody:
    """Return the provider catalog enriched with per-provider configuration state.

    ``is_configured`` reflects *actual* availability: API keys present,
    OAuth token files on disk, cloud creds set — and for local daemons
    (Ollama), an HTTP probe confirming the daemon answers. Static-only
    catalog inspection would falsely show "Connected" for a daemon that
    isn't running.
    """
    from app.agent.providers.catalog import all_providers
    from app.agent.providers.model_discovery import filter_agent_model_ids

    entries = all_providers()
    saved_states = [_provider_is_configured(entry) for entry in entries]
    reachability = await asyncio.gather(
        *(_provider_is_reachable(entry) for entry in entries),
        return_exceptions=False,
    )
    from app.agent.providers.model_discovery import discover_provider_models

    discovery_results = await asyncio.gather(
        *(
            discover_provider_models(entry, overrides=_provider_saved_overrides(entry))
            if is_configured
            else _empty_models()
            for entry, is_configured in zip(entries, reachability, strict=True)
        ),
        return_exceptions=False,
    )

    out: list[ProviderInfo] = []
    for entry, is_saved, is_configured, live_models in zip(
        entries, saved_states, reachability, discovery_results, strict=True
    ):
        out.append(
            ProviderInfo(
                id=entry["id"],
                label=entry["label"],
                description=entry.get("description", ""),
                kind=entry["kind"],
                credentials=list(entry.get("credentials", [])),
                saved_credentials=_provider_saved_display_credentials(entry),
                env_var=entry.get("env_var", ""),
                env_vars=list(entry.get("env_vars", [])),
                fallback_models=filter_agent_model_ids(
                    list(entry.get("fallback_models", []))
                ),
                oauth_command=entry.get("oauth_command", ""),
                docs_url=entry.get("docs_url", ""),
                is_configured=is_configured and bool(live_models),
                is_saved=is_saved,
                is_reachable=bool(live_models) if is_configured else None,
                visible_models=provider_visible_models(entry["id"]),
            )
        )
    has_any = any(p.is_configured for p in out)
    return ProvidersListBody(providers=out, has_any_configured=has_any)


def _build_overrides(
    entry: "ProviderEntry", body_api_key: str, body_extra: dict[str, str]
) -> dict[str, str]:
    overrides: dict[str, str] = {}
    credentials = entry.get("credentials") or []
    if body_api_key and entry.get("env_var"):
        overrides[entry["env_var"]] = body_api_key
    elif body_api_key and credentials:
        name = str(credentials[0].get("name", ""))
        if name:
            overrides[name] = body_api_key
    overrides.update(body_extra)
    return overrides


@router.post("/providers/{provider_id}/models")
async def list_provider_models(
    provider_id: str, body: ProviderModelsRequest
) -> ProviderModelsResponse:
    """Return live provider models, or an empty list when discovery fails.

    Per-request credentials in ``body`` are threaded through to
    :func:`discover_provider_models` via the ``overrides`` parameter — we
    never touch ``os.environ`` because a concurrent request would observe
    the leaked value.
    """
    from app.agent.providers.catalog import find
    from app.agent.providers.model_discovery import (
        discover_provider_models,
        filter_agent_model_ids,
    )

    entry = find(provider_id)
    if entry is None:
        raise HTTPException(status_code=404, detail=f"Unknown provider '{provider_id}'")

    overrides = _provider_saved_overrides(entry) | _build_overrides(
        entry, body.api_key, body.extra
    )
    discovered = filter_agent_model_ids(
        await discover_provider_models(entry, overrides=overrides)
    )
    if discovered:
        return ProviderModelsResponse(
            provider=provider_id,
            models=discovered,
            source="provider",
        )
    return ProviderModelsResponse(provider=provider_id, models=[], source="provider")


@router.get("/providers/{provider_id}/usage")
async def get_provider_usage(provider_id: str) -> ProviderUsageResponse:
    """Return live provider usage details when the provider exposes them."""
    try:
        return await load_provider_usage(provider_id)
    except ProviderUsageUnsupportedError as exc:
        raise HTTPException(
            status_code=404, detail=f"Usage monitoring unsupported for '{provider_id}'."
        ) from exc
    except ProviderUsageCredentialsError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ProviderUsageUnavailableError as exc:
        raise HTTPException(
            status_code=502, detail="Provider usage unavailable."
        ) from exc


@router.put("/providers/{provider_id}/visible-models")
async def save_provider_visible_models(
    provider_id: str, body: ProviderVisibleModelsRequest
) -> ProviderVisibleModelsResponse:
    """Persist provider-local model IDs shown in normal model pickers."""
    from app.agent.providers.catalog import find

    entry = find(provider_id)
    if entry is None:
        raise HTTPException(status_code=404, detail=f"Unknown provider '{provider_id}'")

    set_provider_visible_models(provider_id, body.models)
    return ProviderVisibleModelsResponse(
        provider=provider_id,
        visible_models=provider_visible_models(provider_id),
    )


@router.post("/providers/{provider_id}/test")
async def test_provider(
    provider_id: str, body: ProviderTestRequest
) -> ProviderTestResponse:
    """Run a one-token completion to verify the supplied credentials.

    ``build_provider`` reads credentials from ``os.environ`` deep in the
    factory, so this endpoint has to mutate the environment temporarily.
    A module-level :class:`asyncio.Lock` serialises concurrent tests so
    one request's candidate key cannot leak to another.
    """
    from app.agent.providers.catalog import find
    from app.agent.providers.factory import build_provider

    entry = find(provider_id)
    if entry is None:
        raise HTTPException(status_code=404, detail=f"Unknown provider '{provider_id}'")

    async with _TEST_PROVIDER_LOCK:
        overrides: dict[str, str | None] = {}
        if body.api_key and entry.get("env_var"):
            env_var = entry["env_var"]
            overrides[env_var] = os.environ.get(env_var)
            os.environ[env_var] = body.api_key
        for name, value in body.extra.items():
            overrides[name] = os.environ.get(name)
            os.environ[name] = value

        started = time.perf_counter()
        try:
            provider = build_provider(f"{provider_id}:{body.model}")
            from app.agent.schemas.chat import HumanMessage

            await provider.chat(
                messages=[HumanMessage(content="ping")],
                max_tokens=1,
            )
            latency_ms = int((time.perf_counter() - started) * 1000)
            return ProviderTestResponse(ok=True, latency_ms=latency_ms)
        except Exception as exc:
            logger.warning(
                "provider_test_failed provider={} error={}", provider_id, exc
            )
            return ProviderTestResponse(ok=False, error=str(exc))
        finally:
            for name, prev in overrides.items():
                if prev is None:
                    os.environ.pop(name, None)
                else:
                    os.environ[name] = prev


@router.put("/providers/{provider_id}")
async def save_provider(
    provider_id: str, body: ProviderSaveRequest
) -> ProviderSaveResponse:
    """Persist provider credentials to ``$OPENAGENTD_CONFIG_DIR/.env``.

    Side effects:

    - Updates ``os.environ`` so the next ``build_provider`` call sees the
      new value without restarting the server.
    - Returns ``is_first_provider=True`` on the first-ever provider save
      (kept for the CLI's ``openagentd init`` flow, which still uses the
      seed installer; the web UI no longer triggers seed install on save).
    """
    from app.agent.providers.catalog import find
    from app.cli.seed import write_env_credentials

    entry = find(provider_id)
    if entry is None:
        raise HTTPException(status_code=404, detail=f"Unknown provider '{provider_id}'")

    creds: dict[str, str] = {}
    credentials = entry.get("credentials") or []
    if credentials:
        if body.api_key and len(credentials) == 1:
            creds[str(credentials[0].get("name", ""))] = body.api_key
        elif body.api_key and credentials:
            creds[str(credentials[0].get("name", ""))] = body.api_key
        for field in credentials:
            name = str(field.get("name", ""))
            if name in body.extra:
                creds[name] = body.extra[name]
    elif entry.get("kind") == "api_key" and entry.get("env_var"):
        creds[entry["env_var"]] = body.api_key
    elif entry.get("kind") == "cloud_creds":
        for name in entry.get("env_vars") or []:
            if name in body.extra:
                creds[name] = body.extra[name]
    # ``body.extra`` also carries optional knobs like ROUTER9_BASE_URL /
    # CLIPROXY_BASE_URL / OLLAMA_BASE_URL — users running the proxy on
    # another host need a way to point at it without hand-editing .env.
    # Empty string means "remove the override and fall back to the
    # pydantic-settings default", which ``write_env_credentials`` honours
    # by deleting the line.
    for name, value in body.extra.items():
        if name not in creds:
            creds[name] = value
    # OAuth/local providers don't write env vars from this endpoint — OAuth
    # uses the auth route, local needs no credentials.

    if not creds:
        # Nothing to write, but report success so the UI can proceed to
        # seed materialisation.
        return ProviderSaveResponse(saved=False)

    # "First provider" = no .env yet (or .env exists but contains no
    # API keys). OAuth-only and local-only states don't count: the seed
    # installer needs a chat-capable model in OPENAGENTD_MODEL or in a
    # provider env var, which a bare Copilot OAuth token doesn't satisfy.
    env_file = Path(settings.OPENAGENTD_CONFIG_DIR) / ".env"
    is_first = not env_file.exists() or not _env_has_provider_key(env_file)

    write_env_credentials(env_file, creds)

    # Mirror writes into os.environ so build_provider sees them now.
    # ``settings`` is a frozen Pydantic instance — it doesn't refresh,
    # but the providers read from os.environ via require_api_key.
    for key, val in creds.items():
        if val:
            os.environ[key] = val
        else:
            os.environ.pop(key, None)

    logger.info(
        "provider_credentials_saved provider={} env_vars={}",
        provider_id,
        list(creds.keys()),
    )

    return ProviderSaveResponse(
        saved=True,
        is_first_provider=is_first,
    )


@router.post("/seed")
async def install_seed_defaults(body: SeedInstallRequest) -> SeedInstallResponse:
    """Install bundled first-run agents/skills into the user's config dir."""
    from app.cli.seed import PROVIDER_MODEL_TOKEN, SeedDownloadError, install_seed

    provider_model = body.provider_model or PROVIDER_MODEL_TOKEN
    try:
        result = install_seed(
            Path(settings.OPENAGENTD_CONFIG_DIR),
            provider_model=provider_model,
        )
    except SeedDownloadError as exc:
        logger.warning("seed_install_failed error={}", exc)
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    return SeedInstallResponse(
        agents_written=result.agents_written,
        skills_written=result.skills_written,
        configs_written=result.configs_written,
        agents_removed=result.agents_removed,
        source=result.source,
    )
