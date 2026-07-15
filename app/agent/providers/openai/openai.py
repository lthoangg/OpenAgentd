"""OpenAI provider — Chat Completions and Responses API.

Routing logic:
  1. ``responses_api: true``  in model_kwargs  → always use /responses
  2. ``responses_api: false`` in model_kwargs  → always use /chat/completions
  3. ``thinking_level`` is set (and not "none"/"off") → auto-use /responses
     (Chat Completions does not support reasoning_effort with function tools)
  4. Default → /chat/completions

Usage::

    # Chat Completions (default — no thinking)
    provider = OpenAIProvider(api_key="sk-...", model="gpt-5.4")

    # Auto-routes to Responses API because thinking_level is set
    provider = OpenAIProvider(
        api_key="sk-...", model="gpt-5.4",
        model_kwargs={"thinking_level": "high"},
    )

    # Force Responses API explicitly
    provider = OpenAIProvider(
        api_key="sk-...", model="gpt-5.4",
        model_kwargs={"responses_api": True},
    )

    # Custom base URL for OpenAI-compatible APIs
    provider = OpenAIProvider(api_key="...", model="...", base_url="https://...")
"""

from __future__ import annotations

from typing import Any

from loguru import logger
from pydantic.types import SecretStr

from app.agent.providers.base import LLMProviderBase
from app.agent.schemas.chat import AssistantMessage, ChatMessage

from .completions import CompletionsHandler
from .responses import ResponsesHandler

API_BASE_URL = "https://api.openai.com/v1"

_NO_THINKING = frozenset({"none", "off", ""})


def _should_use_responses(model_kwargs: dict[str, Any]) -> bool:
    """Determine whether to use the Responses API.

    Explicit ``responses_api`` flag takes priority. Otherwise, auto-switch
    to Responses API when thinking_level is set, since Chat Completions
    does not support reasoning_effort alongside function tools.
    """
    if "responses_api" in model_kwargs:
        return bool(model_kwargs["responses_api"])
    thinking_level = model_kwargs.get("thinking_level", "")
    return thinking_level not in _NO_THINKING and bool(thinking_level)


class OpenAIProvider(LLMProviderBase):
    """OpenAI Chat Completions / Responses provider.

    Also works with any OpenAI-compatible endpoint (e.g. Azure OpenAI,
    local Ollama, Together AI) by passing a custom ``base_url``.

    Args:
        api_key: OpenAI API key (``sk-...``). Accepts raw string or
            ``pydantic.SecretStr``.
        model: Model name, e.g. ``"gpt-4o"``, ``"gpt-5.4"``.
        base_url: Override the API base URL. Defaults to the official
            OpenAI endpoint.
        max_tokens: Hard cap on completion tokens.
        model_kwargs: Extra fields. Notable keys:
            ``responses_api`` (bool)   — force /responses or /chat/completions
            ``thinking_level`` (str)   — "low"|"medium"|"high" → auto-routes to /responses
    """

    def __init__(
        self,
        api_key: str | SecretStr,
        model: str,
        base_url: str = API_BASE_URL,
        max_tokens: int | None = None,
        model_kwargs: dict[str, Any] | None = None,
    ) -> None:
        super().__init__(
            max_tokens=max_tokens,
            model_kwargs=model_kwargs,
        )

        resolved_key = (
            api_key.get_secret_value() if isinstance(api_key, SecretStr) else api_key
        )
        if not resolved_key:
            raise ValueError(
                "API key is required. Provide it via the provider's environment variable."
            )

        self.api_key = resolved_key
        self.model = model
        self.base_url = base_url.rstrip("/")
        self._use_responses = self._use_responses_for(self.model_kwargs)

        headers = self._build_headers()

        self._completions = self._make_completions_handler(
            model, self.base_url, headers
        )
        self._responses = self._make_responses_handler(model, self.base_url, headers)

        logger.debug(
            "openai_provider model={} endpoint={}",
            model,
            "responses" if self._use_responses else "completions",
        )

    # ------------------------------------------------------------------
    # Construction hooks (override in subclasses for provider variants)
    # ------------------------------------------------------------------

    def _build_headers(self) -> dict[str, str]:
        """Return the HTTP headers for outbound requests.

        Default sets Bearer auth + JSON content type. Override to add
        provider-specific headers (e.g. Copilot's ``Openai-Intent``,
        ``x-initiator``) or swap the auth scheme.
        """
        return {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
        }

    def _use_responses_for(self, model_kwargs: dict[str, Any]) -> bool:
        """Return True to route to /responses, False for /chat/completions.

        Default uses ``_should_use_responses`` (explicit flag, then
        thinking-level auto-detection).  Override to implement
        per-model routing tables (e.g. Copilot's ``_MODEL_ENDPOINT_MAP``).
        """
        return _should_use_responses(model_kwargs)

    def _make_completions_handler(
        self, model: str, base_url: str, headers: dict[str, str]
    ) -> CompletionsHandler:
        """Construct the chat-completions handler.

        Override to inject a ``CompletionsHandler`` subclass with a
        provider-specific ``customize_thinking`` (e.g. ZAI's ``thinking``
        field, Copilot's model-gated ``reasoning_effort``).
        """
        return CompletionsHandler(model, base_url, headers)

    def _make_responses_handler(
        self, model: str, base_url: str, headers: dict[str, str]
    ) -> ResponsesHandler:
        """Construct the responses-API handler.

        Override to inject a ``ResponsesHandler`` subclass.
        """
        return ResponsesHandler(
            model,
            base_url,
            headers,
            # Official stateless reasoning replay contract:
            # https://developers.openai.com/api/docs/guides/migrate-to-responses
            preserve_stateless_reasoning=base_url.rstrip("/") == API_BASE_URL,
        )

    # ------------------------------------------------------------------
    # Public interface
    # ------------------------------------------------------------------

    async def chat(
        self,
        messages: list[ChatMessage],
        tools: list[dict] | None = None,
        **kwargs: Any,
    ) -> AssistantMessage:
        merged = self._merged_kwargs(**kwargs)
        if self._use_responses:
            return await self._responses.chat(messages, tools, merged)
        return await self._completions.chat(messages, tools, merged)

    async def stream(
        self,
        messages: list[ChatMessage],
        tools: list[dict] | None = None,
        **kwargs: Any,
    ):
        merged = self._merged_kwargs(**kwargs)
        if self._use_responses:
            async for chunk in self._responses.stream(messages, tools, merged):
                yield chunk
        else:
            async for chunk in self._completions.stream(messages, tools, merged):
                yield chunk
