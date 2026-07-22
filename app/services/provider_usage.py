"""Provider usage dispatcher for Settings -> Providers."""

from __future__ import annotations

import asyncio
import time
from typing import TYPE_CHECKING, cast

from loguru import logger

from app.agent.providers.codex.usage import (
    CodexUsageCredentialsError,
    CodexUsageUnavailableError,
    get_usage as get_codex_usage,
)
from app.agent.providers.copilot.usage import (
    CopilotUsageCredentialsError,
    CopilotUsageUnavailableError,
    get_usage as get_copilot_usage,
)
from app.agent.providers.grok.usage import (
    GrokUsageCredentialsError,
    GrokUsageUnavailableError,
    get_usage as get_grok_usage,
)
from app.agent.providers.plugin_registry import (
    ProviderCredentialStore,
    find_provider_plugin,
    provider_plugins,
)
from app.api.schemas.settings import (
    ProviderUsageResponse,
    ProviderUsageSummaryBody,
    ProviderUsageSummaryItem,
)
from app.core import runtime_settings
from app.services.provider_connection import provider_is_configured

if TYPE_CHECKING:
    from app.agent.providers.catalog import ProviderEntry

# Builtin (non-plugin) providers that expose a usage endpoint. Kept as an
# id -> label map so the summary reads sensibly even if the catalog entry
# is momentarily unavailable.
_BUILTIN_USAGE_PROVIDERS: dict[str, str] = {
    "codex": "OpenAI Codex",
    "copilot": "GitHub Copilot",
    "grok": "Grok Build",
}

# Per-provider timeout for the *aggregate* summary. Individual usage
# modules already apply their own client timeouts; this
# is a hard backstop so one slow/hanging plugin can't stall the whole
# tray poll.
_SUMMARY_PROVIDER_TIMEOUT_S = 6.0

# Short-lived cache so a tray polling every few minutes (or a user mashing
# "Refresh") doesn't fan out a fresh request per provider on every call.
# Keyed by nothing (single global snapshot) since the summary is always
# "all connected providers".
_SUMMARY_CACHE_TTL_S = 45.0
# Stale-while-revalidate window: past the fresh TTL but within this age,
# the cached snapshot is served immediately (the caller never waits on
# upstream) while a single background task revalidates. Past this age the
# caller pays for a blocking fresh fetch — data that old is worse than a
# short wait.
_SUMMARY_STALE_TTL_S = 15 * 60.0
# How long a provider's last successful usage payload may be substituted
# for a transiently failing live fetch (marked ``stale=True``). Past this,
# the failure is surfaced as-is — indefinitely serving hours-old numbers
# during a real outage would be misleading.
_LAST_GOOD_MAX_AGE_S = 30 * 60.0
_summary_cache: tuple[float, ProviderUsageSummaryBody] | None = None
_summary_lock = asyncio.Lock()
# provider_id -> (monotonic time of success, last "ok" item).
_last_good_items: dict[str, tuple[float, ProviderUsageSummaryItem]] = {}
_background_refresh_task: asyncio.Task[None] | None = None


class ProviderUsageUnsupportedError(ValueError):
    """Raised when a provider has no usage endpoint integration."""


class ProviderUsageCredentialsError(ValueError):
    """Raised when usage support needs missing OAuth credentials."""


class ProviderUsageUnavailableError(RuntimeError):
    """Raised when the upstream usage endpoint cannot be reached or parsed."""


async def get_provider_usage(provider_id: str) -> ProviderUsageResponse:
    try:
        if provider_id == "codex":
            return await get_codex_usage()
        if provider_id == "copilot":
            return await get_copilot_usage()
        if provider_id == "grok":
            return await get_grok_usage()
    except (
        CodexUsageCredentialsError,
        CopilotUsageCredentialsError,
        GrokUsageCredentialsError,
    ) as exc:
        raise ProviderUsageCredentialsError(str(exc)) from exc
    except (
        CodexUsageUnavailableError,
        CopilotUsageUnavailableError,
        GrokUsageUnavailableError,
    ) as exc:
        raise ProviderUsageUnavailableError(str(exc)) from exc

    plugin = find_provider_plugin(provider_id)
    if plugin is not None and plugin.get_usage is not None:
        try:
            return await plugin.get_usage(ProviderCredentialStore(provider_id))
        except ValueError as exc:
            raise ProviderUsageCredentialsError(str(exc)) from exc
        except Exception as exc:
            raise ProviderUsageUnavailableError(str(exc)) from exc
    raise ProviderUsageUnsupportedError(provider_id)


def _usage_capable_connected_providers(
    settings_snapshot: runtime_settings.RuntimeSettings,
) -> list[tuple[str, str]]:
    """Return (provider_id, label) for every *connected* usage-capable provider.

    "Usage-capable" = builtin OAuth providers with a hand-written usage
    module plus any provider plugin that defines ``get_usage``. "Connected"
    reuses the same static credential/token check the Settings → Providers
    page uses, so the tray never shows a provider the user hasn't actually
    authenticated — and additionally respects the user's explicit Settings →
    Providers "Disconnect" toggle (``is_disconnected``), which hides a
    provider without deleting its credentials.

    The caller passes one settings snapshot so every provider sees a
    consistent configuration without reparsing ``settings.yaml`` per row.
    """
    from app.agent.providers.catalog import find as find_catalog_entry

    def _is_disconnected(provider_id: str) -> bool:
        provider_settings = settings_snapshot.providers.get(provider_id)
        return bool(provider_settings and provider_settings.is_disconnected)

    candidates: list[tuple[str, str]] = []
    for provider_id, fallback_label in _BUILTIN_USAGE_PROVIDERS.items():
        if _is_disconnected(provider_id):
            continue
        entry = find_catalog_entry(provider_id) or cast(
            "ProviderEntry",
            {"id": provider_id, "label": fallback_label, "kind": "oauth"},
        )
        if not provider_is_configured(entry):
            continue
        candidates.append((provider_id, entry.get("label", fallback_label)))

    for provider_id, plugin in provider_plugins().items():
        if plugin.get_usage is None:
            continue
        if _is_disconnected(provider_id):
            continue
        entry = find_catalog_entry(provider_id) or cast(
            "ProviderEntry",
            {"id": provider_id, "label": plugin.label, "kind": plugin.kind},
        )
        if not provider_is_configured(entry):
            continue
        candidates.append((provider_id, plugin.label))

    return candidates


def _normalize_model_token(value: str) -> str:
    """Normalize a model/limit id for fuzzy matching: lowercase, and strip
    separators so ``gemini-3.5-flash`` == ``gemini_3_5_flash`` == ``Gemini 3.5 Flash``."""
    return "".join(ch for ch in value.lower() if ch.isalnum())


def _limit_matches_visible_models(
    limit_id: str | None, visible_normalized: list[str]
) -> bool:
    """Whether a per-model limit corresponds to one of the user's chosen models.

    Fuzzy containment either way: providers often prefix/suffix ids
    differently between the model list and the usage API (e.g. the model
    picker's ``antigravity-gemini-3.5-flash-low`` vs the usage endpoint's
    ``gemini-3.5-flash-low``).
    """
    if not limit_id:
        return False
    limit_norm = _normalize_model_token(limit_id)
    if not limit_norm:
        return False
    return any(
        limit_norm in visible or visible in limit_norm for visible in visible_normalized
    )


def _filter_usage_to_visible_models(
    usage: ProviderUsageResponse,
    visible_models: list[str],
) -> ProviderUsageResponse:
    """Drop per-model limit rows for models the user hasn't made visible.

    Some providers report one limit per *model* (a dozen rows, most for
    models the user never runs). When the user has curated Settings →
    Providers → visible models, only limits matching those models are kept.

    Deliberately conservative:
    - No visible-model selection configured → keep everything.
    - Nothing matches at all → keep everything. This is the signal that
      the provider's limits aren't model-keyed (e.g. a quota window like
      ``five_hour``/``seven_day``) — filtering those against model names
      would blank the provider.
    """
    if not visible_models or not usage.limits:
        return usage
    visible_normalized = [
        norm
        for norm in (_normalize_model_token(model) for model in visible_models)
        if norm
    ]
    if not visible_normalized:
        return usage
    kept = [
        limit
        for limit in usage.limits
        if _limit_matches_visible_models(limit.limit_id, visible_normalized)
    ]
    if not kept:
        return usage
    return usage.model_copy(update={"limits": kept})


def _last_good_fallback(
    provider_id: str, error: str
) -> ProviderUsageSummaryItem | None:
    """Substitute a recent last-known-good item for a transient failure.

    Returns ``None`` when there is no last-good snapshot or it is older
    than :data:`_LAST_GOOD_MAX_AGE_S` — serving hours-old numbers during a
    real outage would be misleading, so past that age the failure is
    surfaced as-is.
    """
    entry = _last_good_items.get(provider_id)
    if entry is None:
        return None
    recorded_at, item = entry
    if time.monotonic() - recorded_at > _LAST_GOOD_MAX_AGE_S:
        return None
    return item.model_copy(update={"stale": True, "error": error})


async def _fetch_summary_item(
    provider_id: str,
    label: str,
    visible_models: list[str],
) -> ProviderUsageSummaryItem:
    try:
        usage = await asyncio.wait_for(
            get_provider_usage(provider_id), timeout=_SUMMARY_PROVIDER_TIMEOUT_S
        )
    except ProviderUsageCredentialsError as exc:
        # Deliberately no last-good fallback here: missing credentials need
        # the user to reconnect, and substituting old numbers would hide that.
        return ProviderUsageSummaryItem(
            provider=provider_id,
            label=label,
            status="credentials_missing",
            error=str(exc),
        )
    except TimeoutError:
        error = "Timed out waiting for provider usage."
        return _last_good_fallback(provider_id, error) or ProviderUsageSummaryItem(
            provider=provider_id, label=label, status="unavailable", error=error
        )
    except (ProviderUsageUnavailableError, ProviderUsageUnsupportedError) as exc:
        return _last_good_fallback(provider_id, str(exc)) or ProviderUsageSummaryItem(
            provider=provider_id, label=label, status="unavailable", error=str(exc)
        )
    except Exception as exc:  # noqa: BLE001 - one bad provider must not sink the tray poll
        logger.warning(
            "provider_usage_summary_item_failed provider={} error={}", provider_id, exc
        )
        return _last_good_fallback(provider_id, str(exc)) or ProviderUsageSummaryItem(
            provider=provider_id, label=label, status="unavailable", error=str(exc)
        )
    item = ProviderUsageSummaryItem(
        provider=provider_id,
        label=label,
        status="ok",
        usage=_filter_usage_to_visible_models(usage, visible_models),
    )
    _last_good_items[provider_id] = (time.monotonic(), item)
    return item


async def _fetch_fresh_snapshot() -> ProviderUsageSummaryBody:
    """Fan out to every connected, usage-capable provider concurrently."""
    settings_snapshot = runtime_settings.load_runtime_settings()
    candidates = _usage_capable_connected_providers(settings_snapshot)
    items = list(
        await asyncio.gather(
            *(
                _fetch_summary_item(
                    pid,
                    label,
                    visible_models=(
                        settings_snapshot.providers[pid].visible_models
                        if pid in settings_snapshot.providers
                        else []
                    ),
                )
                for pid, label in candidates
            )
        )
    )
    return ProviderUsageSummaryBody(items=items, checked_at=int(time.time()))


def _schedule_background_refresh() -> None:
    """Kick off a single background revalidation task (if none is running)."""
    global _background_refresh_task

    if _background_refresh_task is not None and not _background_refresh_task.done():
        return

    async def _revalidate() -> None:
        global _summary_cache
        try:
            async with _summary_lock:
                now = time.monotonic()
                if (
                    _summary_cache is not None
                    and now - _summary_cache[0] < _SUMMARY_CACHE_TTL_S
                ):
                    return  # someone else already revalidated
                body = await _fetch_fresh_snapshot()
                _summary_cache = (time.monotonic(), body)
        except Exception as exc:  # noqa: BLE001 - background task must never crash the loop
            logger.warning("provider_usage_summary_revalidate_failed error={}", exc)

    _background_refresh_task = asyncio.get_running_loop().create_task(_revalidate())


async def get_connected_provider_usage_summary(
    *, force_refresh: bool = False
) -> ProviderUsageSummaryBody:
    """Aggregate usage for every connected, usage-capable provider.

    Serving policy (stale-while-revalidate):

    - Fresh cache (< :data:`_SUMMARY_CACHE_TTL_S`): served immediately.
    - Stale cache (< :data:`_SUMMARY_STALE_TTL_S`): served immediately,
      while a single background task revalidates — so a periodic tray
      poll never blocks on N upstream OAuth calls.
    - Older / no cache / ``force_refresh=True``: blocking fresh fetch,
      deduplicated by :data:`_summary_lock`.

    Providers that fail transiently are substituted with their
    last-known-good payload (marked ``stale=True``) for up to
    :data:`_LAST_GOOD_MAX_AGE_S`, so one flaky poll doesn't blank a row.
    """
    global _summary_cache

    if not force_refresh and _summary_cache is not None:
        cached_at, cached_body = _summary_cache
        age = time.monotonic() - cached_at
        if age < _SUMMARY_CACHE_TTL_S:
            return cached_body.model_copy(update={"cached": True})
        if age < _SUMMARY_STALE_TTL_S:
            _schedule_background_refresh()
            return cached_body.model_copy(update={"cached": True})

    async with _summary_lock:
        # Re-check after acquiring: a concurrent caller (or the background
        # revalidator) may have refreshed while we waited on the lock.
        if not force_refresh and _summary_cache is not None:
            cached_at, cached_body = _summary_cache
            if time.monotonic() - cached_at < _SUMMARY_CACHE_TTL_S:
                return cached_body.model_copy(update={"cached": True})

        body = await _fetch_fresh_snapshot()
        _summary_cache = (time.monotonic(), body)
        return body
