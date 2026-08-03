from __future__ import annotations

from typing import Any

from .constants import GO_PROVIDER_ID, ZEN_PROVIDER_ID

_DOCUMENTED_TRANSPORTS = {
    f"{ZEN_PROVIDER_ID}:grok-build-0.1": "responses",
    f"{GO_PROVIDER_ID}:grok-4.5": "chat_completions",
}

_API_FAMILY_BY_PACKAGE = {
    "@ai-sdk/anthropic": "messages",
    "@ai-sdk/google": "generate_content",
    "@ai-sdk/openai": "responses",
}


def model_transport(
    provider_id: str,
    model_id: str,
    provider: dict[str, Any],
    model_provider: Any,
) -> dict[str, str]:
    """Translate OpenCode's Models.dev SDK package into a wire protocol."""
    documented_family = _DOCUMENTED_TRANSPORTS.get(f"{provider_id}:{model_id}")
    if documented_family:
        return {"endpoint_variant": "default", "api_family": documented_family}

    package = model_provider.get("npm") if isinstance(model_provider, dict) else None
    package = package or provider.get("npm") or "@ai-sdk/openai-compatible"
    return {
        "endpoint_variant": "default",
        "api_family": _API_FAMILY_BY_PACKAGE.get(package, "chat_completions"),
    }
