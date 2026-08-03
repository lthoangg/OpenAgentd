"""Live model metadata for the ChatGPT Codex provider."""

from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Any

import httpx2
from loguru import logger

from app.agent.providers.codex.oauth import CODEX_ORIGINATOR, CodexOAuth
from app.core.config import settings

CODEX_MODELS_URL = "https://chatgpt.com/backend-api/codex/models"
CODEX_MODELS_CACHE_TTL_SECONDS = 60 * 60
CODEX_EFFECTIVE_CONTEXT_WINDOW_PERCENT = 95
_CACHED_MODEL_FIELDS = (
    "slug",
    "context_window",
    "max_context_window",
    "effective_context_window_percent",
    "auto_compact_token_limit",
)


def _cache_path() -> Path:
    return Path(settings.OPENAGENTD_CACHE_DIR) / "codex-models.json"


def _read_cache(path: Path) -> Any | None:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return None
    except (OSError, json.JSONDecodeError) as exc:
        logger.warning("failed to read Codex model catalog cache {} ({})", path, exc)
        return None


def _fetch_catalog() -> Any | None:
    oauth = CodexOAuth.load()
    if oauth is None:
        return None
    try:
        if oauth.is_expired():
            oauth = oauth.refresh()
        headers = {
            "Authorization": f"Bearer {oauth.access_token.get_secret_value()}",
            "Content-Type": "application/json",
            "User-Agent": "openagentd/1.0.0",
            "originator": CODEX_ORIGINATOR,
        }
        if oauth.account_id:
            headers["ChatGPT-Account-Id"] = oauth.account_id
        response = httpx2.get(
            CODEX_MODELS_URL,
            params={"client_version": "1.0.0"},
            headers=headers,
            timeout=5.0,
        )
        response.raise_for_status()
        return response.json()
    except Exception as exc:
        logger.warning("failed to fetch Codex model catalog ({})", type(exc).__name__)
        return None


def _cacheable_catalog(data: Any) -> dict[str, list[dict[str, Any]]]:
    """Keep only fields used for discovery and context-limit resolution."""
    items = data.get("models", []) if isinstance(data, dict) else []
    models = [
        {field: item[field] for field in _CACHED_MODEL_FIELDS if field in item}
        for item in items
        if isinstance(item, dict) and isinstance(item.get("slug"), str)
    ]
    return {"models": models}


def cached_codex_catalog() -> Any | None:
    """Return cached catalog data without performing network or OAuth work."""
    return _read_cache(_cache_path())


def load_codex_catalog(*, force: bool = False) -> Any | None:
    """Return cached or freshly fetched Codex model-catalog data."""
    cache_path = _cache_path()
    cached = cached_codex_catalog()
    if not settings.OPENAGENTD_MODEL_REGISTRY_REFRESH:
        return cached
    if cached is not None and not force:
        try:
            if (
                time.time() - cache_path.stat().st_mtime
                < CODEX_MODELS_CACHE_TTL_SECONDS
            ):
                return cached
        except OSError:
            pass

    response_data = _fetch_catalog()
    if response_data is None:
        return cached
    fetched = _cacheable_catalog(response_data)
    try:
        cache_path.parent.mkdir(parents=True, exist_ok=True)
        cache_path.write_text(
            json.dumps(fetched, separators=(",", ":")), encoding="utf-8"
        )
    except OSError as exc:
        logger.warning(
            "failed to write Codex model catalog cache {} ({})", cache_path, exc
        )
    return fetched


def model_ids(data: Any) -> list[str]:
    """Return valid model slugs from a Codex catalog response."""
    items = data.get("models", []) if isinstance(data, dict) else []
    return sorted(
        str(item["slug"])
        for item in items
        if isinstance(item, dict) and isinstance(item.get("slug"), str)
    )


def model_registry_overlay(data: Any) -> dict[str, dict[str, Any]]:
    """Normalize Codex context limits for the shared metadata registry."""
    if not isinstance(data, dict) or not isinstance(data.get("models"), list):
        return {}

    registry: dict[str, dict[str, Any]] = {}
    for model in data["models"]:
        if not isinstance(model, dict):
            continue
        slug = model.get("slug")
        context = model.get("context_window")
        if context is None:
            context = model.get("max_context_window")
        percent = model.get("effective_context_window_percent")
        if percent is None:
            percent = CODEX_EFFECTIVE_CONTEXT_WINDOW_PERCENT
        if (
            not isinstance(slug, str)
            or not slug
            or isinstance(context, bool)
            or not isinstance(context, int)
            or context <= 0
            or isinstance(percent, bool)
            or not isinstance(percent, int)
            or not 1 <= percent <= 100
        ):
            continue
        registry[f"codex:{slug}".lower()] = {
            "limits": {
                "context_length": context,
                "max_input_tokens": context * percent // 100,
            }
        }
    return registry
