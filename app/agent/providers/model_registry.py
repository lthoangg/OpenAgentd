"""Shared model registry loader.

Registry precedence is:

1. cached/refreshed ``https://models.dev/api.json`` metadata;
2. provider-owned runtime metadata overlays;
3. local ``{OPENAGENTD_CONFIG_DIR}/model_registry.yaml`` overrides.

Public resolver APIs stay in ``capabilities.py`` and ``model_metadata.py``; this
module owns source loading, normalization, and merge order.
"""

from __future__ import annotations

import json
import time
from copy import deepcopy
from functools import lru_cache
from pathlib import Path
from typing import Any

import httpx
import yaml
from loguru import logger

from app.agent.providers.opencode.constants import PROVIDER_IDS as OPENCODE_PROVIDER_IDS
from app.agent.providers.opencode.metadata import model_transport as opencode_transport
from app.core.config import settings


ModelRegistry = dict[str, dict[str, Any]]

MODELS_DEV_URL = "https://models.dev/api.json"
MODELS_DEV_CACHE_TTL_SECONDS = 24 * 60 * 60

_MANTLE_API_URLS = {
    "https://bedrock-mantle.${AWS_REGION}.api.aws/v1": "default",
    "https://bedrock-mantle.${AWS_REGION}.api.aws/openai/v1": "openai",
}


def _deep_merge(base: dict[str, Any], override: dict[str, Any]) -> dict[str, Any]:
    result = deepcopy(base)
    for key, value in override.items():
        current = result.get(key)
        if isinstance(current, dict) and isinstance(value, dict):
            result[key] = _deep_merge(current, value)
        else:
            result[key] = deepcopy(value)
    return result


def _provider_entries(include_plugins: bool) -> list[Any]:
    from app.agent.providers.catalog import all_providers, builtin_providers

    return list(all_providers() if include_plugins else builtin_providers())


def _provider_id_aliases(*, include_plugins: bool = True) -> dict[str, str]:
    aliases: dict[str, str] = {}
    for entry in _provider_entries(include_plugins):
        provider_id = entry.get("id")
        source_id = entry.get("models_dev_provider_id")
        if isinstance(provider_id, str) and isinstance(source_id, str) and source_id:
            aliases[source_id.lower()] = provider_id.lower()
    return aliases


def _model_registry_aliases(
    *, include_plugins: bool = True
) -> tuple[dict[str, str], dict[str, str]]:
    provider_aliases: dict[str, str] = {}
    model_aliases: dict[str, str] = {}
    for entry in _provider_entries(include_plugins):
        provider_id = entry.get("id")
        if not isinstance(provider_id, str) or not provider_id:
            continue
        target_provider = provider_id.lower()
        source_provider = entry.get("metadata_source_provider")
        if isinstance(source_provider, str) and source_provider:
            provider_aliases[target_provider] = source_provider.lower()

        aliases = entry.get("model_registry_aliases")
        if not isinstance(aliases, dict):
            continue
        for target_model, source_key in aliases.items():
            if not isinstance(target_model, str) or not isinstance(source_key, str):
                continue
            target_key = (
                target_model
                if ":" in target_model
                else f"{target_provider}:{target_model}"
            )
            model_aliases[target_key.lower()] = source_key.lower()
    return provider_aliases, model_aliases


def apply_model_registry_aliases(
    registry: ModelRegistry, *, overwrite: bool = False, include_plugins: bool = True
) -> ModelRegistry:
    """Add provider-owned metadata aliases for runtime provider/model IDs."""
    provider_aliases, model_aliases = _model_registry_aliases(
        include_plugins=include_plugins
    )
    result = dict(registry)
    for key, value in registry.items():
        if ":" not in key:
            continue
        provider_id, model_id = key.split(":", 1)
        for target_provider, source_provider in provider_aliases.items():
            if provider_id != source_provider:
                continue
            target_key = f"{target_provider}:{model_id}"
            if overwrite:
                result[target_key] = _deep_merge(result.get(target_key, {}), value)
            elif target_key not in result:
                result[target_key] = deepcopy(value)

    for target_key, source_key in model_aliases.items():
        source = result.get(source_key)
        if source and overwrite:
            result[target_key] = _deep_merge(result.get(target_key, {}), source)
        elif source and target_key not in result:
            result[target_key] = deepcopy(source)
    return result


def _coerce_registry(parsed: Any, source: str) -> ModelRegistry:
    if not isinstance(parsed, dict):
        logger.warning(
            "{} did not parse to a mapping (got {}); ignoring",
            source,
            type(parsed).__name__,
        )
        return {}

    registry: ModelRegistry = {}
    for key, value in parsed.items():
        if not isinstance(key, str) or not isinstance(value, dict):
            logger.warning("{}: skipping malformed entry key={!r}", source, key)
            continue
        registry[key.lower()] = value
    return registry


def _models_dev_cache_path() -> Path:
    return Path(settings.OPENAGENTD_CACHE_DIR) / "models-dev.json"


def _read_json_file(path: Path) -> Any | None:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return None
    except (OSError, json.JSONDecodeError) as exc:
        logger.warning("failed to read model registry cache {} ({})", path, exc)
        return None


def _fetch_models_dev() -> Any | None:
    try:
        response = httpx.get(MODELS_DEV_URL, timeout=5.0)
        response.raise_for_status()
        return response.json()
    except (httpx.HTTPError, json.JSONDecodeError, ValueError) as exc:
        logger.warning("failed to fetch models.dev registry ({})", exc)
        return None


def _load_models_dev_data(*, force: bool = False) -> Any | None:
    if not settings.OPENAGENTD_MODEL_REGISTRY_REFRESH:
        return _read_json_file(_models_dev_cache_path())

    cache_path = _models_dev_cache_path()
    cached = _read_json_file(cache_path)
    if cached is not None and not force:
        try:
            if time.time() - cache_path.stat().st_mtime < MODELS_DEV_CACHE_TTL_SECONDS:
                return cached
        except OSError:
            pass

    fetched = _fetch_models_dev()
    if fetched is None:
        return cached

    try:
        cache_path.parent.mkdir(parents=True, exist_ok=True)
        cache_path.write_text(
            json.dumps(fetched, separators=(",", ":")), encoding="utf-8"
        )
    except OSError as exc:
        logger.warning(
            "failed to write models.dev registry cache {} ({})", cache_path, exc
        )
    return fetched


def _modalities_to_capabilities(model: dict[str, Any]) -> dict[str, Any]:
    modalities = model.get("modalities")
    if not isinstance(modalities, dict):
        return {}

    input_modalities = modalities.get("input") or []
    output_modalities = modalities.get("output") or []
    if not isinstance(input_modalities, list):
        input_modalities = []
    if not isinstance(output_modalities, list):
        output_modalities = []

    capabilities: dict[str, Any] = {}
    input_caps = {
        "vision": "image" in input_modalities,
        "audio": "audio" in input_modalities,
        "video": "video" in input_modalities,
    }
    input_caps = {key: value for key, value in input_caps.items() if value}
    if input_caps:
        capabilities["input"] = input_caps

    output_caps = {
        "text": "text" in output_modalities,
        "image": "image" in output_modalities,
        "audio": "audio" in output_modalities,
        "video": "video" in output_modalities,
    }
    if output_caps["image"] or output_caps["audio"] or output_caps["video"]:
        capabilities["output"] = output_caps
    return capabilities


def _limits_from_model(model: dict[str, Any]) -> dict[str, int]:
    limit = model.get("limit")
    if not isinstance(limit, dict):
        return {}

    result: dict[str, int] = {}
    context = limit.get("context")
    input_tokens = limit.get("input")
    output = limit.get("output")
    if isinstance(context, int) and not isinstance(context, bool) and context > 0:
        result["context_length"] = context
    if (
        isinstance(input_tokens, int)
        and not isinstance(input_tokens, bool)
        and input_tokens > 0
    ):
        result["max_input_tokens"] = input_tokens
    if isinstance(output, int) and not isinstance(output, bool) and output > 0:
        result["max_completion_tokens"] = output
    return result


def _cost_from_model(model: dict[str, Any]) -> dict[str, float]:
    cost = model.get("cost")
    if not isinstance(cost, dict):
        return {}

    result: dict[str, float] = {}
    for source, target in (
        ("input", "input"),
        ("output", "output"),
        ("cache_read", "cache_read"),
        ("cache_write", "cache_write"),
    ):
        value = cost.get(source)
        if isinstance(value, int | float) and not isinstance(value, bool):
            result[target] = float(value)
    return result


def _features_from_model(model: dict[str, Any]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for source, target in (
        ("tool_call", "tool_call"),
        ("attachment", "attachment"),
        ("temperature", "temperature"),
        ("reasoning", "reasoning"),
    ):
        value = model.get(source)
        if isinstance(value, bool):
            result[target] = value

    status = model.get("status")
    if isinstance(status, str) and status:
        result["status"] = status
    release_date = model.get("release_date")
    if isinstance(release_date, str) and release_date:
        result["release_date"] = release_date
    return result


def _thinking_from_model(model: dict[str, Any]) -> dict[str, list[str]]:
    options = model.get("reasoning_options")
    if not isinstance(options, list):
        return {}

    levels: list[str] = []
    has_budget_tokens = False
    has_toggle = False
    for option in options:
        if not isinstance(option, dict):
            continue
        if option.get("type") == "budget_tokens":
            has_budget_tokens = True
            continue
        if option.get("type") == "toggle":
            has_toggle = True
            continue
        if option.get("type") != "effort":
            continue
        values = option.get("values")
        if not isinstance(values, list):
            continue
        for value in values:
            if isinstance(value, str) and value and value not in levels:
                levels.append(value)
    if has_toggle and "none" not in levels:
        levels.insert(0, "none")
    if levels:
        return {"levels": levels}
    if has_budget_tokens:
        return {"levels": ["none", "low", "medium", "high"]}
    return {}


def _mantle_transport(provider: Any) -> dict[str, str] | None:
    """Normalize a known Mantle provider block without retaining its URL."""
    if not isinstance(provider, dict):
        return None
    endpoint_variant = _MANTLE_API_URLS.get(provider.get("api"))
    if endpoint_variant is None or provider.get("shape") != "responses":
        return None
    return {"endpoint_variant": endpoint_variant, "api_family": "responses"}


def _normalize_models_dev(data: Any, *, include_plugins: bool = True) -> ModelRegistry:
    if not isinstance(data, dict):
        return {}

    registry: ModelRegistry = {}
    provider_aliases = _provider_id_aliases(include_plugins=include_plugins)
    for provider_key, provider in data.items():
        if not isinstance(provider_key, str) or not isinstance(provider, dict):
            continue
        source_provider_id = str(provider.get("id") or provider_key).lower()
        provider_id = provider_aliases.get(source_provider_id, source_provider_id)
        models = provider.get("models")
        if not isinstance(models, dict):
            continue
        for model_key, model in models.items():
            if not isinstance(model_key, str) or not isinstance(model, dict):
                continue
            model_id = str(model.get("id") or model_key)
            entry: dict[str, Any] = {}
            capabilities = _modalities_to_capabilities(model)
            limits = _limits_from_model(model)
            cost = _cost_from_model(model)
            features = _features_from_model(model)
            thinking = _thinking_from_model(model)
            transport = None
            if source_provider_id == "amazon-bedrock":
                transport = _mantle_transport(model.get("provider"))
            elif source_provider_id in OPENCODE_PROVIDER_IDS:
                transport = opencode_transport(
                    source_provider_id, model_id, provider, model.get("provider")
                )
            if capabilities:
                entry["capabilities"] = capabilities
            if limits:
                entry["limits"] = limits
            if cost:
                entry["cost"] = cost
            if features:
                entry["features"] = features
            if thinking:
                entry["thinking"] = thinking
            if transport:
                entry["transport"] = transport
            if entry:
                registry[f"{provider_id}:{model_id}".lower()] = entry
    return registry


def _load_user_overlay() -> ModelRegistry:
    path = Path(settings.OPENAGENTD_CONFIG_DIR) / "model_registry.yaml"
    try:
        parsed = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    except FileNotFoundError:
        return {}
    except (OSError, yaml.YAMLError) as exc:
        logger.warning("failed to read model registry overlay {} ({})", path, exc)
        return {}
    return _coerce_registry(parsed, str(path))


@lru_cache(maxsize=1)
def load_model_registry() -> ModelRegistry:
    """Load cached/refreshed models.dev and user model metadata."""
    from app.agent.providers.catalog import runtime_model_metadata_overlay

    registry: ModelRegistry = {}
    models_dev = _normalize_models_dev(_load_models_dev_data())
    provider_overlay = runtime_model_metadata_overlay()
    overlay = _load_user_overlay()

    for source in (models_dev, overlay):
        for key, value in source.items():
            registry[key] = _deep_merge(registry.get(key, {}), value)
        registry = apply_model_registry_aliases(registry, overwrite=True)
        if source is overlay:
            for key, value in source.items():
                registry[key] = _deep_merge(registry.get(key, {}), value)

    # Provider-owned runtime metadata overrides cross-provider aliases, while
    # explicit user entries remain the final authority.
    for key, value in provider_overlay.items():
        registry[key] = _deep_merge(registry.get(key, {}), value)
    for key, value in overlay.items():
        registry[key] = _deep_merge(registry.get(key, {}), value)

    logger.debug(
        "model registry loaded models_dev={} provider_overlay={} overlay={} final={}",
        len(models_dev),
        len(provider_overlay),
        len(overlay),
        len(registry),
    )
    return registry


def clear_model_registry_caches() -> None:
    """Clear all memory caches for the model registry, capabilities, and metadata."""
    from app.agent.providers import capabilities, model_metadata

    load_model_registry.cache_clear()
    capabilities._registry.cache_clear()
    model_metadata._registry.cache_clear()


def refresh_model_registry(*, force: bool = True) -> None:
    """Refresh the models.dev cache and clear memory caches."""
    from app.agent.providers.catalog import refresh_runtime_model_metadata

    try:
        _load_models_dev_data(force=force)
        refresh_runtime_model_metadata(force=force)
    except Exception as exc:
        logger.warning("failed to refresh model registry ({})", exc)
    finally:
        # Clear the memory caches so subsequent calls see the updated data
        clear_model_registry_caches()
