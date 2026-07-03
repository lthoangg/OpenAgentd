"""xAI (Grok) provider — OpenAI-compatible API.

Thin wrapper around ``OpenAIProvider`` that points at the xAI inference
endpoint and reads ``XAI_API_KEY`` from settings or environment.

Endpoint:  https://api.x.ai/v1
Auth:      Bearer {XAI_API_KEY}
Docs:      https://docs.x.ai/docs/quickstart

Token resolution order:
    1. ``Settings.XAI_API_KEY`` (from ``.env`` or environment)
    2. ``XAI_API_KEY`` environment variable

Usage::

    model: xai:grok-4
    model: xai:grok-3-mini
"""

from __future__ import annotations

from typing import Any

from app.agent.providers.openai import OpenAIProvider

XAI_API_BASE = "https://api.x.ai/v1"


class XAIProvider(OpenAIProvider):
    """xAI Grok provider (OpenAI-compatible).

    Delegates entirely to ``OpenAIProvider`` with the xAI base URL.
    Vision is supported on multimodal Grok models (e.g. ``grok-4``).

    Args:
        api_key: xAI API key from https://console.x.ai.
        model: Model name, e.g. ``"grok-4"``, ``"grok-3-mini"``.
        max_tokens: Hard cap on completion tokens.
        model_kwargs: Extra request body fields passed as-is.
    """

    def __init__(
        self,
        api_key: str,
        model: str,
        max_tokens: int | None = None,
        model_kwargs: dict[str, Any] | None = None,
    ) -> None:
        super().__init__(
            api_key=api_key,
            model=model,
            base_url=XAI_API_BASE,
            max_tokens=max_tokens,
            model_kwargs=model_kwargs,
        )

    def _use_responses_for(self, model_kwargs: dict[str, Any]) -> bool:
        # xAI's OpenAI-compatible surface is chat-completions based; do not
        # route thinking-level requests to OpenAI's /responses endpoint.
        return False
