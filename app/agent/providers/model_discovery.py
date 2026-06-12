from __future__ import annotations

import os
from collections.abc import Mapping

import httpx
from loguru import logger

from app.agent.providers.catalog import ProviderEntry
from app.agent.providers.openai.compatible import OPENAI_COMPATIBLE_PROVIDER_SPECS
from app.core.config import settings

TIMEOUT_S = 3.0

_NON_AGENT_MODEL_MARKERS = (
    "embedding",
    "embed",
    "rerank",
    "moderation",
    "whisper",
    "tts",
    "dall-e",
    "davinci",
    "gpt-audio",
    "gpt-image",
    "imagen",
    "image",
    "lyria",
    "nano-banana",
    "sora",
    "veo",
)


def _secret_value(value: object) -> str:
    if value is None:
        return ""
    get_secret_value = getattr(value, "get_secret_value", None)
    if callable(get_secret_value):
        return str(get_secret_value())
    return str(value)


def _resolve(overrides: Mapping[str, str] | None, name: str, default: str = "") -> str:
    """Look up a value: overrides → env → settings → default.

    Used to thread per-request credentials/base-URLs through discovery
    without mutating ``os.environ`` (which would leak to concurrent
    requests).
    """
    if overrides and name in overrides:
        return overrides[name]
    env_val = os.getenv(name)
    if env_val:
        return env_val
    setting_val = _secret_value(getattr(settings, name, None))
    return setting_val or default


def is_agent_model_id(model_id: str) -> bool:
    """Return True for model IDs that are plausible text-chat agent models."""
    lowered = model_id.lower()
    return not any(marker in lowered for marker in _NON_AGENT_MODEL_MARKERS)


def filter_agent_model_ids(model_ids: list[str]) -> list[str]:
    return [model_id for model_id in model_ids if is_agent_model_id(model_id)]


async def _openai_compatible_models(
    *,
    provider_id: str,
    base_url: str,
    api_key: str,
) -> list[str]:
    headers = {"Authorization": f"Bearer {api_key}"} if api_key else {}
    async with httpx.AsyncClient(timeout=TIMEOUT_S) as client:
        response = await client.get(f"{base_url.rstrip('/')}/models", headers=headers)
        response.raise_for_status()
    data = response.json()
    items = data.get("data", []) if isinstance(data, dict) else []
    models = sorted(
        str(item["id"])
        for item in items
        if isinstance(item, dict) and isinstance(item.get("id"), str)
    )
    logger.debug(
        "provider_models_discovered provider={} count={}", provider_id, len(models)
    )
    return models


async def _google_genai_models(overrides: Mapping[str, str] | None) -> list[str]:
    api_key = _resolve(overrides, "GOOGLE_API_KEY")
    if not api_key:
        return []
    async with httpx.AsyncClient(timeout=TIMEOUT_S) as client:
        response = await client.get(
            "https://generativelanguage.googleapis.com/v1beta/models",
            headers={"x-goog-api-key": api_key},
        )
        response.raise_for_status()
    data = response.json()
    items = data.get("models", []) if isinstance(data, dict) else []
    models: list[str] = []
    for item in items:
        if not isinstance(item, dict):
            continue
        name = item.get("name")
        methods = item.get("supportedGenerationMethods", [])
        if isinstance(name, str) and "generateContent" in methods:
            models.append(name.removeprefix("models/"))
    return sorted(models)


async def _anthropic_models(overrides: Mapping[str, str] | None) -> list[str]:
    api_key = _resolve(overrides, "ANTHROPIC_API_KEY")
    if not api_key:
        return []
    base_url = _resolve(overrides, "ANTHROPIC_BASE_URL", settings.ANTHROPIC_BASE_URL)
    async with httpx.AsyncClient(timeout=TIMEOUT_S) as client:
        response = await client.get(
            f"{base_url.rstrip('/')}/v1/models",
            headers={
                "x-api-key": api_key,
                "anthropic-version": "2023-06-01",
            },
        )
        response.raise_for_status()
    data = response.json()
    items = data.get("data", []) if isinstance(data, dict) else []
    return sorted(
        str(item["id"])
        for item in items
        if isinstance(item, dict) and isinstance(item.get("id"), str)
    )


async def _copilot_models() -> list[str]:
    from app.agent.providers.copilot.oauth import CopilotOAuth

    oauth = CopilotOAuth.load()
    if oauth is None:
        return []
    async with httpx.AsyncClient(timeout=TIMEOUT_S) as client:
        response = await client.get(
            "https://api.githubcopilot.com/models",
            headers={
                "Authorization": f"Bearer {oauth.github_token.get_secret_value()}",
                "Accept": "application/json",
                "User-Agent": "openagentd/1.0.0",
            },
        )
        response.raise_for_status()
    data = response.json()
    items = data.get("data", []) if isinstance(data, dict) else []
    return sorted(
        str(item["id"])
        for item in items
        if isinstance(item, dict)
        and isinstance(item.get("id"), str)
        and item.get("model_picker_enabled", True)
    )


async def _codex_models() -> list[str]:
    from app.agent.providers.codex.oauth import CodexOAuth

    oauth = CodexOAuth.load()
    if oauth is None:
        return []
    if oauth.is_expired():
        oauth = oauth.refresh()
    headers = {
        "Authorization": f"Bearer {oauth.access_token.get_secret_value()}",
        "Content-Type": "application/json",
        "User-Agent": "openagentd/1.0.0",
        "originator": "openagentd",
    }
    if oauth.account_id:
        headers["ChatGPT-Account-Id"] = oauth.account_id
    async with httpx.AsyncClient(timeout=TIMEOUT_S) as client:
        response = await client.get(
            "https://chatgpt.com/backend-api/codex/models",
            params={"client_version": "1.0.0"},
            headers=headers,
        )
        response.raise_for_status()
    data = response.json()
    items = data.get("models", []) if isinstance(data, dict) else []
    return sorted(
        str(item["slug"])
        for item in items
        if isinstance(item, dict) and isinstance(item.get("slug"), str)
    )


async def _bedrock_models(overrides: Mapping[str, str] | None = None) -> list[str]:
    import boto3

    region = (
        _resolve(overrides, "AWS_BEDROCK_REGION")
        or settings.AWS_BEDROCK_REGION
        or os.getenv("AWS_BEDROCK_REGION")
        or os.getenv("AWS_DEFAULT_REGION")
        or "us-east-1"
    )
    kwargs: dict[str, str] = {"region_name": region}
    profile = (
        _resolve(overrides, "AWS_BEDROCK_PROFILE")
        or settings.AWS_BEDROCK_PROFILE
        or os.getenv("AWS_BEDROCK_PROFILE")
    )
    access_key = _resolve(overrides, "AWS_ACCESS_KEY_ID")
    secret_key = _resolve(overrides, "AWS_SECRET_ACCESS_KEY")
    if profile:
        session = boto3.Session(profile_name=profile)
        client = session.client("bedrock", **kwargs)
    elif access_key and secret_key:
        session = boto3.Session(
            aws_access_key_id=access_key,
            aws_secret_access_key=secret_key,
        )
        client = session.client("bedrock", **kwargs)
    else:
        client = boto3.client("bedrock", **kwargs)
    model_ids: set[str] = set()

    response = client.list_foundation_models(byOutputModality="TEXT")
    summaries = response.get("modelSummaries", [])
    model_ids.update(
        str(item["modelId"])
        for item in summaries
        if isinstance(item, dict) and isinstance(item.get("modelId"), str)
    )

    for profile_type in ("SYSTEM_DEFINED", "APPLICATION"):
        next_token: str | None = None
        while True:
            params = {"typeEquals": profile_type, "maxResults": 1000}
            if next_token:
                params["nextToken"] = next_token
            profiles_response = client.list_inference_profiles(**params)
            profile_summaries = profiles_response.get("inferenceProfileSummaries", [])
            model_ids.update(
                str(item["inferenceProfileId"])
                for item in profile_summaries
                if isinstance(item, dict)
                and isinstance(item.get("inferenceProfileId"), str)
                and item.get("status") in (None, "ACTIVE")
            )
            next_token = profiles_response.get("nextToken")
            if not isinstance(next_token, str) or not next_token:
                break

    return sorted(model_ids)


async def discover_provider_models(
    entry: ProviderEntry,
    *,
    overrides: Mapping[str, str] | None = None,
) -> list[str]:
    """Return live provider model IDs, or ``[]`` on failure / unsupported.

    ``overrides`` lets callers (e.g. the settings ``/models`` route) inject
    a candidate API key + base URL for a single request without mutating
    ``os.environ`` — which would leak to other concurrent requests.
    """
    provider_id = entry["id"]
    try:
        match provider_id:
            case "openai":
                models = await _openai_compatible_models(
                    provider_id=provider_id,
                    base_url="https://api.openai.com/v1",
                    api_key=_resolve(overrides, "OPENAI_API_KEY"),
                )
            case _ if provider_id in OPENAI_COMPATIBLE_PROVIDER_SPECS:
                spec = OPENAI_COMPATIBLE_PROVIDER_SPECS[provider_id]
                base_url = spec.base_url
                if spec.base_url_env_var:
                    base_url = _resolve(overrides, spec.base_url_env_var, spec.base_url)
                models = await _openai_compatible_models(
                    provider_id=provider_id,
                    base_url=base_url,
                    api_key=_resolve(overrides, spec.env_var) or spec.default_api_key,
                )
            case "zai":
                models = await _openai_compatible_models(
                    provider_id=provider_id,
                    base_url="https://api.z.ai/api/paas/v4",
                    api_key=_resolve(overrides, "ZAI_API_KEY"),
                )
            case "googlegenai":
                models = await _google_genai_models(overrides)
            case "anthropic":
                models = await _anthropic_models(overrides)
            case "copilot":
                models = await _copilot_models()
            case "codex":
                models = await _codex_models()
            case "bedrock":
                models = await _bedrock_models(overrides)
            case _:
                from app.agent.providers.plugin_registry import (
                    ProviderCredentialStore,
                    find_provider_plugin,
                )

                plugin = find_provider_plugin(provider_id)
                if plugin is not None:
                    store = ProviderCredentialStore(provider_id, dict(overrides or {}))
                    if plugin.discover_models is not None:
                        models = await plugin.discover_models(store)
                    else:
                        models = list(plugin.fallback_models)
                else:
                    models = []
        return filter_agent_model_ids(models)
    except Exception as exc:
        logger.info(
            "provider_models_unavailable provider={} error={}", provider_id, exc
        )
        return []
