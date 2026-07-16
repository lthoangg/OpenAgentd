"""OpenAI Chat Completions API handler (/v1/chat/completions)."""

from __future__ import annotations

from contextlib import asynccontextmanager
from typing import TYPE_CHECKING, Any, AsyncIterator

import httpx
from loguru import logger

from app.agent.usage import usage_to_dict
from app.agent.providers.streaming import iter_sse_data
from app.agent.schemas.chat import (
    AssistantMessage,
    ChatCompletionChunk,
    ChatCompletionChunkChoice,
    ChatCompletionDelta,
    ChatMessage,
    FunctionCall,
    FunctionCallDelta,
    HumanMessage,
    ImageDataBlock,
    ImageUrlBlock,
    SystemMessage,
    TextBlock,
    ToolCall,
    ToolCallDelta,
    ToolMessage,
    Usage,
)

from .schemas import (
    OpenAIChatRequest,
    OpenAIChatResponse,
    OpenAIFunction,
    OpenAIFunctionCall,
    OpenAIMessage,
    OpenAIStreamChunk,
    OpenAIStreamOptions,
    OpenAITool,
    OpenAIToolCall,
)
from .sanitization import sanitize_openai_tool_pairs

if TYPE_CHECKING:
    pass


class CompletionsHandler:
    """Handles all interaction with /v1/chat/completions."""

    # OpenAI's reasoning-capable models (o-series, gpt-5*, gpt-5.4*) reject
    # the legacy ``max_tokens`` field — they require ``max_completion_tokens``.
    # The Chat Completions API accepts ``max_completion_tokens`` on every
    # current OpenAI model (including legacy gpt-4o/gpt-3.5), so we default
    # to the new field for the native OpenAI provider.
    #
    # OpenAI-compatible endpoints that still require the legacy field
    # (xAI Grok, Deepseek as of 2026-Q2) flip this to ``False`` in their
    # provider subclass — see ``providers/xai`` and ``providers/deepseek``.
    #
    # Class-level flag rather than per-instance so subclassing remains
    # the single override point; callers don't toggle field names ad-hoc.
    uses_max_completion_tokens: bool = True

    def __init__(self, model: str, base_url: str, headers: dict[str, str]) -> None:
        self.model = model
        self.base_url = base_url
        self.headers = headers
        self.client: httpx.AsyncClient | None = None

    @asynccontextmanager
    async def _request_client(self) -> AsyncIterator[httpx.AsyncClient]:
        if self.client is not None:
            yield self.client
        else:
            async with httpx.AsyncClient() as client:
                yield client

    # ------------------------------------------------------------------
    # Message / tool conversion
    # ------------------------------------------------------------------

    def convert_messages(self, messages: list[ChatMessage]) -> list[OpenAIMessage]:
        result: list[OpenAIMessage] = []
        for msg in messages:
            if isinstance(msg, SystemMessage):
                result.append(OpenAIMessage(role="system", content=msg.content or ""))

            elif isinstance(msg, HumanMessage):
                if msg.parts:
                    oai_parts: list[dict] = []
                    for part in msg.parts:
                        if isinstance(part, TextBlock):
                            oai_parts.append({"type": "text", "text": part.text})
                        elif isinstance(part, ImageUrlBlock):
                            img_url: dict = {"url": part.url}
                            if part.detail:
                                img_url["detail"] = part.detail
                            oai_parts.append(
                                {"type": "image_url", "image_url": img_url}
                            )
                        elif isinstance(part, ImageDataBlock):
                            data_url = f"data:{part.media_type};base64,{part.data}"
                            oai_parts.append(
                                {
                                    "type": "image_url",
                                    "image_url": {"url": data_url, "detail": "auto"},
                                }
                            )
                    result.append(OpenAIMessage(role="user", content=oai_parts))
                else:
                    result.append(OpenAIMessage(role="user", content=msg.content or ""))

            elif isinstance(msg, AssistantMessage):
                openai_tool_calls = None
                if msg.tool_calls:
                    openai_tool_calls = [
                        OpenAIToolCall(
                            id=tc.id,
                            function=OpenAIFunctionCall(
                                name=tc.function.name,
                                arguments=tc.function.arguments
                                if isinstance(tc.function.arguments, str)
                                else "{}",
                            ),
                        )
                        for tc in msg.tool_calls
                    ]
                result.append(
                    OpenAIMessage(
                        role="assistant",
                        content=msg.content or "",
                        tool_calls=openai_tool_calls,
                    )
                )

            elif isinstance(msg, ToolMessage):
                if msg.parts:
                    oai_parts = []
                    for part in msg.parts:
                        if isinstance(part, TextBlock):
                            oai_parts.append({"type": "text", "text": part.text})
                        elif isinstance(part, ImageUrlBlock):
                            img_url = {"url": part.url}
                            if part.detail:
                                img_url["detail"] = part.detail
                            oai_parts.append(
                                {"type": "image_url", "image_url": img_url}
                            )
                        elif isinstance(part, ImageDataBlock):
                            data_url = f"data:{part.media_type};base64,{part.data}"
                            oai_parts.append(
                                {
                                    "type": "image_url",
                                    "image_url": {"url": data_url, "detail": "auto"},
                                }
                            )
                    result.append(
                        OpenAIMessage(
                            role="tool",
                            content=oai_parts,
                            tool_call_id=msg.tool_call_id,
                            name=msg.name,
                        )
                    )
                else:
                    result.append(
                        OpenAIMessage(
                            role="tool",
                            content=msg.content or "",
                            tool_call_id=msg.tool_call_id,
                            name=msg.name,
                        )
                    )
        return result

    def convert_tools(
        self, tools: list[dict[str, Any]] | None
    ) -> list[OpenAITool] | None:
        if not tools:
            return None
        result = []
        for t in tools:
            if t.get("type") == "function":
                f = t["function"]
                result.append(
                    OpenAITool(
                        function=OpenAIFunction(
                            name=f["name"],
                            description=f.get("description", ""),
                            parameters=f.get("parameters"),
                        )
                    )
                )
        return result or None

    # ------------------------------------------------------------------
    # Request builder
    # ------------------------------------------------------------------

    def build_request(
        self,
        messages: list[ChatMessage],
        tools: list[dict[str, Any]] | None,
        stream: bool,
        merged: dict[str, Any],
    ) -> dict[str, Any]:
        # Route the caller's ``max_tokens`` to whichever field name the
        # downstream API expects.  Callers up the stack use the canonical
        # ``max_tokens`` name (defined on ``LLMProviderBase.chat``); the
        # handler is the *only* layer that knows whether the wire field
        # should be ``max_tokens`` (legacy) or ``max_completion_tokens``
        # (reasoning-capable OpenAI models — see class docstring).
        max_tokens_value = merged.get("max_tokens")
        service_tier = merged.get("service_tier")
        request_service_tier = None
        if service_tier and "api.openai.com" in self.base_url:
            request_service_tier = (
                "priority" if service_tier == "fast" else service_tier
            )

        req = OpenAIChatRequest(
            model=self.model,
            messages=self.convert_messages(sanitize_openai_tool_pairs(messages)),
            tools=self.convert_tools(tools),
            max_tokens=(
                max_tokens_value if not self.uses_max_completion_tokens else None
            ),
            max_completion_tokens=(
                max_tokens_value if self.uses_max_completion_tokens else None
            ),
            stream=stream,
            stream_options=OpenAIStreamOptions(include_usage=True) if stream else None,
            service_tier=request_service_tier,
        )
        body = req.model_dump(exclude_none=True)
        if merged.get("prompt_cache_key") is not None:
            body["prompt_cache_key"] = merged["prompt_cache_key"]
        # Honour an explicit tool_choice override (e.g. "none" from the
        # summarisation hook).  Only injected when tools are present — sending
        # tool_choice without a tools list is an API error on most endpoints.
        tool_choice = merged.get("tool_choice")
        if tool_choice is not None and body.get("tools"):
            body["tool_choice"] = tool_choice
        self.customize_thinking(merged, body)
        return body

    def customize_thinking(self, merged: dict[str, Any], body: dict[str, Any]) -> None:
        """Apply provider-specific reasoning/thinking translation.

        Default behaviour: map ``thinking_level`` to OpenAI's ``reasoning_effort``
        top-level field for o-series and gpt-5 models.

        Subclasses override this method to:

        - Send a different field (e.g. ZAI's ``thinking: {type: disabled}``).
        - Gate the mapping by model (e.g. Copilot only injects
          ``reasoning_effort`` for whitelisted OpenAI models).
        - Suppress reasoning entirely.

        Mutates ``body`` in place.
        """
        thinking_level = merged.get("thinking_level")
        if thinking_level and thinking_level not in ("none", "off"):
            body["reasoning_effort"] = thinking_level

    # ------------------------------------------------------------------
    # Response parsing — non-streaming
    # ------------------------------------------------------------------

    def parse_response(self, data: dict) -> AssistantMessage:
        parsed = OpenAIChatResponse.model_validate(data)
        if not parsed.choices:
            return AssistantMessage(content=None)

        msg = parsed.choices[0].message
        tool_calls: list[ToolCall] = []
        if msg.tool_calls:
            for tc in msg.tool_calls:
                tool_calls.append(
                    ToolCall(
                        id=tc.id,
                        function=FunctionCall(
                            name=tc.function.name,
                            arguments=tc.function.arguments,
                        ),
                    )
                )
        usage_dict = None
        if parsed.usage is not None:
            usage_dict = usage_to_dict(
                self._usage_from_openai(parsed.usage), self.model
            )
        return AssistantMessage(
            content=msg.content or None,
            reasoning_content=msg.reasoning_content or None,
            tool_calls=tool_calls if tool_calls else None,
            extra={"usage": usage_dict} if usage_dict is not None else None,
        )

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    async def chat(
        self,
        messages: list[ChatMessage],
        tools: list[dict[str, Any]] | None,
        merged: dict[str, Any],
    ) -> AssistantMessage:
        body = self.build_request(messages, tools, stream=False, merged=merged)
        url = f"{self.base_url}/chat/completions"

        async with self._request_client() as client:
            headers = self.headers
            prepare = getattr(self, "_prepare_request_headers", None)
            if callable(prepare):
                headers = prepare(body)
            response = await client.post(url, headers=headers, json=body, timeout=120.0)
            if response.status_code >= 400:
                logger.error(
                    "openai_chat_error status={} body={}",
                    response.status_code,
                    response.text[:500],
                )
            response.raise_for_status()
            return self.parse_response(response.json())

    async def stream(
        self,
        messages: list[ChatMessage],
        tools: list[dict[str, Any]] | None,
        merged: dict[str, Any],
    ) -> AsyncIterator[ChatCompletionChunk]:
        body = self.build_request(messages, tools, stream=True, merged=merged)
        url = f"{self.base_url}/chat/completions"

        async with self._request_client() as client:
            headers = self.headers
            prepare = getattr(self, "_prepare_request_headers", None)
            if callable(prepare):
                headers = prepare(body)
            async with client.stream(
                "POST", url, headers=headers, json=body, timeout=120.0
            ) as response:
                if response.status_code >= 400:
                    err_body = await response.aread()
                    logger.error(
                        "openai_stream_error status={} body={}",
                        response.status_code,
                        err_body[:500],
                    )
                    response.raise_for_status()

                async for data in iter_sse_data(response, sentinel="[DONE]"):
                    chunk = OpenAIStreamChunk.model_validate(data)

                    if not chunk.choices:
                        if chunk.usage:
                            yield self._usage_chunk(chunk)
                        continue

                    choice = chunk.choices[0]
                    delta = choice.delta

                    delta_tool_calls: list[ToolCallDelta] = []
                    for tc in delta.tool_calls or []:
                        delta_tool_calls.append(
                            ToolCallDelta(
                                index=tc.index,
                                id=tc.id,
                                function=FunctionCallDelta(
                                    name=tc.function.name if tc.function else None,
                                    arguments=tc.function.arguments
                                    if tc.function
                                    else None,
                                ),
                            )
                        )

                    usage = (
                        self._usage_from_openai(chunk.usage) if chunk.usage else None
                    )

                    yield ChatCompletionChunk(
                        id=chunk.id,
                        created=chunk.created,
                        model=chunk.model,
                        choices=[
                            ChatCompletionChunkChoice(
                                index=choice.index,
                                delta=ChatCompletionDelta(
                                    content=delta.content,
                                    reasoning_content=delta.reasoning_content,
                                    tool_calls=delta_tool_calls or None,
                                ),
                                finish_reason=choice.finish_reason,
                            )
                        ],
                        usage=usage,
                    )

    # ------------------------------------------------------------------
    # Usage helpers
    # ------------------------------------------------------------------

    def _usage_from_openai(self, u: Any) -> Usage:
        cached = None
        if u.prompt_tokens_details:
            cached = u.prompt_tokens_details.cached_tokens or None
        thoughts = None
        if u.completion_tokens_details:
            thoughts = u.completion_tokens_details.reasoning_tokens or None
        return Usage(
            prompt_tokens=u.prompt_tokens,
            completion_tokens=u.completion_tokens,
            total_tokens=u.total_tokens,
            cached_tokens=cached,
            thoughts_tokens=thoughts,
        )

    def _usage_chunk(self, chunk: OpenAIStreamChunk) -> ChatCompletionChunk:
        return ChatCompletionChunk(
            id=chunk.id,
            created=chunk.created,
            model=chunk.model,
            choices=[],
            usage=self._usage_from_openai(chunk.usage),
        )
