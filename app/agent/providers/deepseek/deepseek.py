"""DeepSeek provider — OpenAI-compatible API.

Thin wrapper around ``OpenAIProvider`` that points at the DeepSeek
inference endpoint and reads ``DEEPSEEK_API_KEY`` from settings or
environment.

Endpoint:  https://api.deepseek.com/v1
Auth:      Bearer {DEEPSEEK_API_KEY}
Docs:      https://api-docs.deepseek.com/

Models:
    deepseek-v4-flash  — fast general-purpose chat
    deepseek-v4-pro    — higher-quality variant

DeepSeek thinking mode quirks (vs plain OpenAI):
    1. ``max_tokens`` only — rejects ``max_completion_tokens``.
    2. Thinking mode requires ``thinking: {"type": "enabled"}`` alongside
       ``reasoning_effort``; ``reasoning_effort`` alone is not enough.
    3. When an assistant message contains tool calls AND thinking was active,
       the ``reasoning_content`` field MUST be echoed back in the next
       request or the API returns a 400.  The canonical ``AssistantMessage``
       carries ``reasoning_content`` with ``exclude=True`` (other providers
       don't want it), so this handler uses its own ``DeepSeekMessage``
       schema that includes the field.

Token resolution order:
    1. ``Settings.DEEPSEEK_API_KEY`` (from ``.env`` or environment)
    2. ``DEEPSEEK_API_KEY`` environment variable

Usage::

    model: deepseek:deepseek-v4-flash
    model: deepseek:deepseek-v4-pro
"""

from __future__ import annotations

from typing import Any

from app.agent.providers.openai import OpenAIProvider
from app.agent.providers.openai.completions import CompletionsHandler
from app.agent.providers.openai.sanitization import sanitize_openai_tool_pairs
from app.agent.providers.openai.schemas import OpenAIStreamOptions
from app.agent.schemas.chat import (
    AssistantMessage,
    ChatMessage,
    HumanMessage,
    ImageDataBlock,
    ImageUrlBlock,
    SystemMessage,
    TextBlock,
    ToolMessage,
)

from .schemas import (
    DeepSeekChatRequest,
    DeepSeekMessage,
    DeepSeekThinking,
)

# Request contract: https://api-docs.deepseek.com/api/create-chat-completion
DEEPSEEK_API_BASE = "https://api.deepseek.com/v1"

_NO_THINKING = frozenset({"none", "off", ""})


class _DeepSeekCompletionsHandler(CompletionsHandler):
    """DeepSeek-specific completions handler.

    Differences from the base ``CompletionsHandler``:

    1. ``max_tokens`` only — DeepSeek rejects ``max_completion_tokens``.
    2. Uses ``DeepSeekMessage`` instead of ``OpenAIMessage`` so that
       ``reasoning_content`` on assistant messages is a proper schema
       field and survives ``model_dump``.
    3. ``build_request`` uses ``DeepSeekChatRequest`` which carries the
       DeepSeek-specific ``thinking`` + ``reasoning_effort`` fields.
    4. ``customize_thinking`` sends both ``thinking: {type: enabled}``
       and ``reasoning_effort`` when ``thinking_level`` is configured.
    """

    uses_max_completion_tokens = False

    def _convert_messages_deepseek(
        self, messages: list[ChatMessage]
    ) -> list[DeepSeekMessage]:
        """Convert canonical chat messages to DeepSeek wire messages.

        Identical to the base ``convert_messages`` but produces
        ``DeepSeekMessage`` objects and echoes ``reasoning_content`` on
        assistant messages that had tool calls — required by DeepSeek when
        thinking mode was active for that turn.
        """
        result: list[DeepSeekMessage] = []
        for msg in messages:
            if isinstance(msg, SystemMessage):
                result.append(DeepSeekMessage(role="system", content=msg.content))

            elif isinstance(msg, HumanMessage):
                if msg.parts:
                    parts: list[dict] = []
                    for part in msg.parts:
                        if isinstance(part, TextBlock):
                            parts.append({"type": "text", "text": part.text})
                        elif isinstance(part, ImageUrlBlock):
                            img: dict = {"url": part.url}
                            if part.detail:
                                img["detail"] = part.detail
                            parts.append({"type": "image_url", "image_url": img})
                        elif isinstance(part, ImageDataBlock):
                            data_url = f"data:{part.media_type};base64,{part.data}"
                            parts.append(
                                {
                                    "type": "image_url",
                                    "image_url": {"url": data_url, "detail": "auto"},
                                }
                            )
                    result.append(DeepSeekMessage(role="user", content=parts))
                else:
                    result.append(DeepSeekMessage(role="user", content=msg.content))

            elif isinstance(msg, AssistantMessage):
                from app.agent.providers.openai.schemas import (
                    OpenAIFunctionCall,
                    OpenAIToolCall,
                )

                tool_calls = None
                if msg.tool_calls:
                    tool_calls = [
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
                    DeepSeekMessage(
                        role="assistant",
                        # DeepSeek rejects assistant messages that have neither
                        # content nor tool_calls. Mirror the OpenAI-compatible
                        # handler and coerce empty assistant text to "" so
                        # sanitized history remains provider-valid.
                        content=msg.content or "",
                        tool_calls=tool_calls,
                        # Echo reasoning_content only when tool_calls were present —
                        # DeepSeek mandates this for thinking-mode tool turns.
                        reasoning_content=(
                            msg.reasoning_content
                            if msg.tool_calls and msg.reasoning_content
                            else None
                        ),
                    )
                )

            elif isinstance(msg, ToolMessage):
                if msg.parts:
                    parts = []
                    for part in msg.parts:
                        if isinstance(part, TextBlock):
                            parts.append({"type": "text", "text": part.text})
                        elif isinstance(part, ImageUrlBlock):
                            img = {"url": part.url}
                            if part.detail:
                                img["detail"] = part.detail
                            parts.append({"type": "image_url", "image_url": img})
                        elif isinstance(part, ImageDataBlock):
                            data_url = f"data:{part.media_type};base64,{part.data}"
                            parts.append(
                                {
                                    "type": "image_url",
                                    "image_url": {"url": data_url, "detail": "auto"},
                                }
                            )
                    result.append(
                        DeepSeekMessage(
                            role="tool",
                            content=parts,
                            tool_call_id=msg.tool_call_id,
                            name=msg.name,
                        )
                    )
                else:
                    result.append(
                        DeepSeekMessage(
                            role="tool",
                            content=msg.content,
                            tool_call_id=msg.tool_call_id,
                            name=msg.name,
                        )
                    )
        return result

    def build_request(
        self,
        messages: list[ChatMessage],
        tools: list[dict[str, Any]] | None,
        stream: bool,
        merged: dict[str, Any],
    ) -> dict[str, Any]:
        req = DeepSeekChatRequest(
            model=self.model,
            messages=self._convert_messages_deepseek(
                sanitize_openai_tool_pairs(messages)
            ),
            tools=self.convert_tools(tools),
            max_tokens=merged.get("max_tokens"),
            stream=stream,
            stream_options=OpenAIStreamOptions(include_usage=True) if stream else None,
        )
        body = req.model_dump(exclude_none=True)
        # Honour an explicit tool_choice override (e.g. "none" from the
        # summarisation hook).  Only injected when tools are present —
        # sending tool_choice without a tools list is an API error.
        tool_choice = merged.get("tool_choice")
        if tool_choice is not None and body.get("tools"):
            body["tool_choice"] = tool_choice
        self.customize_thinking(merged, body)
        return body

    def customize_thinking(self, merged: dict[str, Any], body: dict[str, Any]) -> None:
        """Map ``thinking_level`` to DeepSeek's thinking toggle + reasoning_effort.

        DeepSeek requires both ``thinking: {type: enabled}`` and
        ``reasoning_effort`` to activate thinking mode.  Sending
        ``reasoning_effort`` alone without the ``thinking`` object is
        insufficient.
        """
        thinking_level = merged.get("thinking_level", "")
        if thinking_level in _NO_THINKING:
            if thinking_level:
                # DeepSeek defaults thinking to enabled, so omission cannot disable it.
                body["thinking"] = DeepSeekThinking(type="disabled").model_dump()
        else:
            body["thinking"] = DeepSeekThinking(type="enabled").model_dump()
            body["reasoning_effort"] = thinking_level


class DeepSeekProvider(OpenAIProvider):
    """DeepSeek provider (OpenAI-compatible).

    Delegates entirely to ``OpenAIProvider`` with the DeepSeek base URL.
    Vision is not supported by current DeepSeek models.

    Args:
        api_key: DeepSeek API key from https://platform.deepseek.com.
        model: Model name, e.g. ``"deepseek-v4-flash"``, ``"deepseek-v4-pro"``.
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
            base_url=DEEPSEEK_API_BASE,
            max_tokens=max_tokens,
            model_kwargs=model_kwargs,
        )

    def _use_responses_for(self, model_kwargs: dict[str, Any]) -> bool:
        # DeepSeek exposes reasoning through /chat/completions, not OpenAI's
        # /responses endpoint. Keep thinking-level requests on completions so
        # the DeepSeek-specific thinking payload is applied.
        return False

    def _make_completions_handler(
        self, model: str, base_url: str, headers: dict[str, str]
    ) -> CompletionsHandler:
        return _DeepSeekCompletionsHandler(model, base_url, headers)
