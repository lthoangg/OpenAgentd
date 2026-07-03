"""Generic OpenAI-compatible provider variants."""

from __future__ import annotations

from typing import Any

from pydantic.types import SecretStr

from .openai import OpenAIProvider


class ChatCompletionsOnlyProvider(OpenAIProvider):
    """OpenAI-compatible provider that does not expose Responses API.

    Many providers implement the OpenAI Chat Completions wire format but do not
    implement OpenAI's newer ``/responses`` endpoint. Keep these providers on
    ``/chat/completions`` even when session or agent config sets
    ``thinking_level`` or ``responses_api``.
    """

    def __init__(
        self,
        api_key: str | SecretStr,
        model: str,
        base_url: str,
        max_tokens: int | None = None,
        model_kwargs: dict[str, Any] | None = None,
    ) -> None:
        super().__init__(
            api_key=api_key,
            model=model,
            base_url=base_url,
            max_tokens=max_tokens,
            model_kwargs=model_kwargs,
        )

    def _use_responses_for(self, model_kwargs: dict[str, Any]) -> bool:
        return False
