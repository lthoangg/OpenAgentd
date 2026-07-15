"""Z.ai provider — OpenAI-compatible Chat Completions endpoint.

Subclass of :class:`OpenAIProvider` that points at the Z.ai inference
endpoint and overrides only the reasoning-control translation:

* OpenAI exposes reasoning via the ``reasoning_effort`` top-level field.
* Z.ai exposes it via ``thinking: {"type": "enabled" | "disabled"}``;
  reasoning models default to enabled, and the only knob the agent
  surfaces is the *off* switch.

Endpoint:  https://api.z.ai/api/paas/v4
Auth:      Bearer {ZAI_API_KEY}
Docs:      https://docs.z.ai/

Token resolution order:
    1. ``Settings.ZAI_API_KEY`` (from ``.env`` or environment)
    2. ``ZAI_API_KEY`` environment variable
"""

from __future__ import annotations

from typing import Any

from pydantic.types import SecretStr

from app.agent.providers.openai import OpenAIProvider
from app.agent.providers.openai.completions import CompletionsHandler

# API reference: https://docs.z.ai/api-reference/llm/chat-completion.md
ZAI_API_BASE = "https://api.z.ai/api/paas/v4"


class _ZAICompletionsHandler(CompletionsHandler):
    """Z.ai-specific reasoning translation.

    Z.ai does not accept OpenAI's ``reasoning_effort`` field. Reasoning
    is on by default for thinking-capable models; the only override is
    to disable it via ``thinking: {"type": "disabled"}``.
    """

    uses_max_completion_tokens = False

    def customize_thinking(self, merged: dict[str, Any], body: dict[str, Any]) -> None:
        if body.get("tool_choice") != "auto":
            body.pop("tool_choice", None)
        if merged.get("thinking_level") == "none":
            body["thinking"] = {"type": "disabled"}


class ZAIProvider(OpenAIProvider):
    """Z.ai provider (OpenAI-compatible Chat Completions).

    Args:
        api_key: Z.ai API key.
        model: Model name (e.g. ``"glm-4.6"``).
        max_tokens: Hard cap on completion tokens.
        model_kwargs: Extra request body fields. Notable keys:
            ``thinking_level`` (str) — ``"none"`` disables reasoning;
              other values are ignored (Z.ai uses model defaults).
    """

    def __init__(
        self,
        api_key: str | SecretStr,
        model: str,
        max_tokens: int | None = None,
        model_kwargs: dict[str, Any] | None = None,
    ) -> None:
        super().__init__(
            api_key=api_key,
            model=model,
            base_url=ZAI_API_BASE,
            max_tokens=max_tokens,
            model_kwargs=model_kwargs,
        )

    def _use_responses_for(self, model_kwargs: dict[str, Any]) -> bool:
        # Z.ai exposes only /chat/completions. Even with ``thinking_level``
        # set, never auto-route to /responses.
        return False

    def _make_completions_handler(
        self, model: str, base_url: str, headers: dict[str, str]
    ) -> CompletionsHandler:
        return _ZAICompletionsHandler(model, base_url, headers)
