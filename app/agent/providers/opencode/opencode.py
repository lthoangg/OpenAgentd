"""OpenCode Zen and Go providers.

Both gateways expose one base URL but route models through different wire
protocols. Models.dev publishes the model-specific SDK package; the shared
model registry normalizes that package to a provider-neutral API family.
"""

from __future__ import annotations

import hmac
from collections.abc import AsyncIterator
from typing import Any

from pydantic import SecretStr

from app.agent.providers.anthropic import AnthropicProvider
from app.agent.providers.base import LLMProviderBase
from app.agent.providers.googlegenai import GoogleGenAIProvider
from app.agent.providers.model_metadata import get_model_limits, get_model_transport
from app.agent.providers.openai import ChatCompletionsOnlyProvider, OpenAIProvider
from app.agent.providers.openai.responses import ResponsesHandler
from app.agent.schemas.chat import AssistantMessage, ChatCompletionChunk, ChatMessage

from .access import model_is_accessible
from .constants import (
    API_KEY_ENV_BY_PROVIDER,
    GO_API_KEY_ENV,
    GO_PROVIDER_ID,
    PUBLIC_API_KEY,
    ZEN_API_KEY_ENV,
)


class OpenCodeResponsesProvider(OpenAIProvider):
    """OpenAI delegate pinned to Responses with stateless reasoning replay."""

    def _use_responses_for(self, model_kwargs: dict[str, Any]) -> bool:
        return True

    def _make_responses_handler(
        self, model: str, base_url: str, headers: dict[str, str]
    ) -> ResponsesHandler:
        return ResponsesHandler(
            model,
            base_url,
            headers,
            preserve_stateless_reasoning=True,
        )


class OpenCodeProvider(LLMProviderBase):
    """Route OpenCode Zen/Go models through their documented API family."""

    def __init__(
        self,
        *,
        api_key: str | SecretStr,
        model: str,
        provider_id: str,
        base_url: str,
        max_tokens: int | None = None,
        model_kwargs: dict[str, Any] | None = None,
    ) -> None:
        super().__init__(max_tokens=max_tokens, model_kwargs=model_kwargs)
        resolved_key = (
            api_key.get_secret_value() if isinstance(api_key, SecretStr) else api_key
        )
        if not resolved_key:
            env_var = API_KEY_ENV_BY_PROVIDER.get(provider_id, ZEN_API_KEY_ENV)
            raise ValueError(f"OpenCode API key is required. Set {env_var}.")
        self.api_key = resolved_key
        self.model = model
        self.provider_id = provider_id
        self.base_url = base_url.rstrip("/")
        if hmac.compare_digest(resolved_key, PUBLIC_API_KEY):
            if provider_id == GO_PROVIDER_ID:
                raise ValueError(
                    f"OpenCode Go API key is required. Set {GO_API_KEY_ENV}."
                )
            if not model_is_accessible(
                provider_id,
                model,
                has_credentials=False,
            ):
                raise ValueError(
                    f"OpenCode Zen model '{model}' requires {ZEN_API_KEY_ENV}; "
                    "only free Zen models support keyless access."
                )

    def _delegate(
        self,
    ) -> (
        AnthropicProvider
        | ChatCompletionsOnlyProvider
        | GoogleGenAIProvider
        | OpenCodeResponsesProvider
    ):
        model_id = f"{self.provider_id}:{self.model}"
        transport = get_model_transport(model_id)
        api_family = transport.api_family if transport else "chat_completions"

        if api_family == "messages":
            max_tokens = self.max_tokens
            if max_tokens is None:
                max_tokens = get_model_limits(model_id).max_completion_tokens
            return AnthropicProvider(
                api_key=self.api_key,
                model=self.model,
                # AnthropicProvider appends /v1/messages itself.
                base_url=self.base_url.removesuffix("/v1"),
                max_tokens=max_tokens,
                model_kwargs=self.model_kwargs,
            )
        if api_family == "generate_content":
            return GoogleGenAIProvider(
                api_key=self.api_key,
                model=self.model,
                base_url=self.base_url,
                max_tokens=self.max_tokens,
                model_kwargs=self.model_kwargs,
            )
        if api_family == "responses":
            return OpenCodeResponsesProvider(
                api_key=self.api_key,
                model=self.model,
                base_url=self.base_url,
                max_tokens=self.max_tokens,
                model_kwargs=self.model_kwargs,
            )
        return ChatCompletionsOnlyProvider(
            api_key=self.api_key,
            model=self.model,
            base_url=self.base_url,
            max_tokens=self.max_tokens,
            model_kwargs=self.model_kwargs,
        )

    async def chat(
        self,
        messages: list[ChatMessage],
        tools: list[dict] | None = None,
        **kwargs: Any,
    ) -> AssistantMessage:
        delegate = self._delegate()
        try:
            return await delegate.chat(messages, tools, **kwargs)
        finally:
            await delegate.aclose()

    async def stream(
        self,
        messages: list[ChatMessage],
        tools: list[dict] | None = None,
        **kwargs: Any,
    ) -> AsyncIterator[ChatCompletionChunk]:
        delegate = self._delegate()
        try:
            async for chunk in delegate.stream(messages, tools, **kwargs):
                yield chunk
        finally:
            await delegate.aclose()
