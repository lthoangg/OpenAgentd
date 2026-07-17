"""Grok Build subscription provider backed by xAI's session proxy."""

from __future__ import annotations

import asyncio
import hmac
from collections.abc import AsyncIterator
from typing import Any

from loguru import logger

from app.agent.providers.grok.oauth import (
    GROK_BUILD_API_BASE,
    GrokOAuth,
    session_headers,
)
from app.agent.providers.openai.openai import OpenAIProvider
from app.agent.providers.openai.responses import ResponsesHandler
from app.agent.schemas.chat import AssistantMessage, ChatCompletionChunk, ChatMessage


def _load_access_token() -> str:
    oauth = GrokOAuth.load()
    if oauth is None:
        raise ValueError(
            "Grok Build OAuth credentials not found. Run:\n"
            "  openagentd auth grok\n"
            "to authenticate with your Grok subscription."
        )
    if oauth.is_expired():
        try:
            oauth = oauth.refresh()
        except Exception as exc:
            raise ValueError(
                "Grok Build token refresh failed. Run: openagentd auth grok"
            ) from exc
    return oauth.access_token.get_secret_value()


class GrokBuildProvider(OpenAIProvider):
    """OpenAI-compatible provider for Grok Build OAuth sessions."""

    def __init__(
        self,
        model: str,
        max_tokens: int | None = None,
        model_kwargs: dict[str, Any] | None = None,
    ) -> None:
        super().__init__(
            api_key=_load_access_token(),
            model=model,
            base_url=GROK_BUILD_API_BASE,
            max_tokens=max_tokens,
            model_kwargs=model_kwargs,
        )
        logger.debug("grok_build_provider model={}", model)

    def _build_headers(self) -> dict[str, str]:
        return session_headers(self.api_key, model=self.model)

    def _use_responses_for(self, model_kwargs: dict[str, Any]) -> bool:
        if "responses_api" in model_kwargs:
            return bool(model_kwargs["responses_api"])
        if self.model == "grok-4.5":
            return True
        return super()._use_responses_for(model_kwargs)

    def _make_responses_handler(
        self, model: str, base_url: str, headers: dict[str, str]
    ) -> ResponsesHandler:
        return ResponsesHandler(
            model,
            base_url,
            headers,
            preserve_stateless_reasoning=True,
        )

    async def _refresh_session_if_needed(self) -> None:
        oauth = GrokOAuth.load()
        if oauth is None:
            raise ValueError(
                "Grok Build OAuth credentials not found. Run: openagentd auth grok"
            )
        if oauth.is_expired():
            try:
                oauth = await asyncio.to_thread(oauth.refresh)
            except Exception as exc:
                raise ValueError(
                    "Grok Build token refresh failed. Run: openagentd auth grok"
                ) from exc
        access_token = oauth.access_token.get_secret_value()
        if hmac.compare_digest(access_token, self.api_key):
            return
        self.api_key = access_token
        headers = self._build_headers()
        self._completions.headers = headers
        self._responses.headers = headers

    async def chat(
        self,
        messages: list[ChatMessage],
        tools: list[dict] | None = None,
        **kwargs: Any,
    ) -> AssistantMessage:
        await self._refresh_session_if_needed()
        return await super().chat(messages, tools, **kwargs)

    async def stream(
        self,
        messages: list[ChatMessage],
        tools: list[dict] | None = None,
        **kwargs: Any,
    ) -> AsyncIterator[ChatCompletionChunk]:
        await self._refresh_session_if_needed()
        async for chunk in super().stream(messages, tools, **kwargs):
            yield chunk
